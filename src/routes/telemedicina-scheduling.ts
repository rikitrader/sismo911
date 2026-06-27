// Telemedicine scheduling v2 — direct booking against doctor availability.
// Mounted alongside ./telemedicina at /api/telemedicina. Patient flow:
//   catalog → book/doctors → book/doctors/:id/slots → book/appointments →
//   book/appointment/:token (status tracking, self check-in / cancel).
// Doctor panel: panel/availability (set hours/blocks) + panel/appointments
//   (the 7-state lifecycle: scheduled → checked_in → waiting_room →
//    in_progress → completed | cancelled | no_show).
import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { rateLimit, nameHasSpam, textHasLink, requestIp } from '../lib/security';
import { audit } from '../lib/audit';
import { sendEmail, randomToken, telemedScheduledEmail, telemedApptStatusEmail } from '../lib/email';
import { notifyPatientText } from '../lib/sms';
import {
  APPT_TYPES, APPT_TYPE_KEYS, isApptType, type ApptType, type ApptStatus, isStatus, canTransition,
  computeSlots, localToMs, weekdayOf, minToHHMM, type Interval,
} from '../lib/telemed-slots';

export const telemedScheduling = new Hono<{ Bindings: Env }>();

const SPECIALTIES = [
  'general', 'pediatria', 'medicina_interna', 'cardiologia', 'ginecologia', 'traumatologia',
  'psicologia', 'psiquiatria', 'dermatologia', 'neurologia', 'nutricion', 'enfermeria', 'farmacia', 'otra',
];
const LANGS = ['es', 'en', 'pt', 'it', 'fr'];
const DEFAULT_TYPES = JSON.stringify(APPT_TYPE_KEYS);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const baseUrl = (c: any): string => (c.env.PUBLIC_BASE_URL || 'https://sismo911.com').replace(/\/+$/, '');
const firstName = (s: string): string => String(s || '').trim().split(/\s+/)[0] || '';
const jitsiUrl = (token: string): string => `https://meet.jit.si/sismo911-tm-${token}`;
const trackUrl = (c: any, token: string): string => `${baseUrl(c)}/telemedicina?cita=${token}`;
const whenText = (ms: number): string =>
  new Date(ms).toLocaleString('es-VE', { timeZone: 'America/Caracas', dateStyle: 'full', timeStyle: 'short' }) + ' (hora de Venezuela)';

async function verifyDoctor(env: Env, doctorId: string, token: string): Promise<any | null> {
  if (!doctorId || !token) return null;
  return env.DB.prepare(
    `SELECT * FROM telemed_doctors WHERE id=? AND panel_token=? AND status='activo' AND moderation='approved' LIMIT 1`,
  ).bind(doctorId, token).first<any>().catch(() => null);
}
// A doctor's effective prefs (defaults applied when no prefs row exists).
async function loadPrefs(env: Env, doctorId: string): Promise<{ slot_minutes: number; accepting: boolean; appt_types: ApptType[] }> {
  const r = await env.DB.prepare(`SELECT slot_minutes, accepting, appt_types FROM telemed_doctor_prefs WHERE doctor_id=?`)
    .bind(doctorId).first<any>().catch(() => null);
  let types: ApptType[] = [...APPT_TYPE_KEYS];
  if (r?.appt_types) { try { const a = JSON.parse(r.appt_types); if (Array.isArray(a) && a.length) types = a.filter(isApptType); } catch { /* keep default */ } }
  return { slot_minutes: r?.slot_minutes ?? 30, accepting: r ? !!r.accepting : true, appt_types: types };
}
function safeJson(s: any, fallback: any) { try { const v = JSON.parse(s); return v ?? fallback; } catch { return fallback; } }
function icsStamp(ms: number): string { return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
function icsEscape(s: string): string { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }

// ---------------------------------------------------------------------------
// CATALOG + DOCTOR DISCOVERY (public)
// ---------------------------------------------------------------------------

// GET /catalog — specialties with bookable-doctor counts + appointment types.
telemedScheduling.get('/catalog', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT d.specialty AS specialty, COUNT(DISTINCT d.id) AS n
       FROM telemed_doctors d
       JOIN telemed_availability a ON a.doctor_id = d.id
       LEFT JOIN telemed_doctor_prefs p ON p.doctor_id = d.id
      WHERE d.status='activo' AND d.moderation='approved' AND COALESCE(p.accepting,1)=1
      GROUP BY d.specialty ORDER BY n DESC`,
  ).all().catch(() => ({ results: [] as any[] }));
  const types = APPT_TYPE_KEYS.map((k) => ({ key: k, label: APPT_TYPES[k].label, duration: APPT_TYPES[k].duration, icon: APPT_TYPES[k].icon }));
  return c.json({ ok: true, specialties: results ?? [], types }, 200, { 'Cache-Control': 'public, max-age=30' });
});

// GET /book/doctors?specialty=&type= — bookable doctors (have availability + accepting).
telemedScheduling.get('/book/doctors', async (c) => {
  const specialty = String(c.req.query('specialty') || '').trim();
  const type = String(c.req.query('type') || '').trim();
  const conds = ["d.status='activo'", "d.moderation='approved'", 'COALESCE(p.accepting,1)=1'];
  const binds: unknown[] = [DEFAULT_TYPES];
  if (specialty && SPECIALTIES.includes(specialty)) { conds.push('d.specialty=?'); binds.push(specialty); }
  const { results } = await c.env.DB.prepare(
    `SELECT d.id, d.full_name, d.specialty, d.country, d.languages, d.bio, d.verified,
            COALESCE(p.slot_minutes,30) AS slot_minutes, COALESCE(p.appt_types,?) AS appt_types
       FROM telemed_doctors d
       JOIN telemed_availability a ON a.doctor_id = d.id
       LEFT JOIN telemed_doctor_prefs p ON p.doctor_id = d.id
      WHERE ${conds.join(' AND ')}
      GROUP BY d.id ORDER BY d.verified DESC, d.full_name ASC LIMIT 200`,
  ).bind(...binds).all().catch(() => ({ results: [] as any[] }));
  let items = (results ?? []).map((r: any) => {
    let languages: string[] = []; try { languages = JSON.parse(r.languages || '[]'); } catch { languages = []; }
    let appt_types: ApptType[] = [...APPT_TYPE_KEYS]; try { const a = JSON.parse(r.appt_types); if (Array.isArray(a) && a.length) appt_types = a.filter(isApptType); } catch { /* default */ }
    return { id: r.id, full_name: r.full_name, specialty: r.specialty, country: r.country, languages, bio: r.bio, verified: !!r.verified, slot_minutes: r.slot_minutes, appt_types };
  });
  if (isApptType(type)) items = items.filter((d) => d.appt_types.includes(type as ApptType));
  return c.json({ ok: true, items, total: items.length }, 200, { 'Cache-Control': 'public, max-age=20' });
});

// GET /book/doctors/:id — public doctor profile for the booking flow.
telemedScheduling.get('/book/doctors/:id', async (c) => {
  const id = String(c.req.param('id') || '').trim().slice(0, 64);
  const d = await c.env.DB.prepare(
    `SELECT id, full_name, specialty, country, languages, bio, verified FROM telemed_doctors
      WHERE id=? AND status='activo' AND moderation='approved' LIMIT 1`,
  ).bind(id).first<any>().catch(() => null);
  if (!d) return c.json({ error: 'not_found' }, 404);
  const prefs = await loadPrefs(c.env, id);
  let languages: string[] = []; try { languages = JSON.parse(d.languages || '[]'); } catch { languages = []; }
  return c.json({ ok: true, doctor: { ...d, verified: !!d.verified, languages, ...prefs } }, 200, { 'Cache-Control': 'public, max-age=20' });
});

// GET /book/doctors/:id/slots?date=YYYY-MM-DD&type= — free slots for that day/type.
telemedScheduling.get('/book/doctors/:id/slots', async (c) => {
  const id = String(c.req.param('id') || '').trim().slice(0, 64);
  const date = String(c.req.query('date') || '').trim();
  const type = String(c.req.query('type') || 'video').trim();
  if (!DATE_RE.test(date)) return c.json({ error: 'bad_date' }, 400);
  if (!isApptType(type)) return c.json({ error: 'bad_type' }, 400);
  const prefs = await loadPrefs(c.env, id);
  if (!prefs.accepting || !prefs.appt_types.includes(type)) return c.json({ ok: true, slots: [] }, 200);
  const weekday = weekdayOf(date);
  const [windows, blocks, busy] = await Promise.all([
    c.env.DB.prepare(`SELECT start_min, end_min FROM telemed_availability WHERE doctor_id=? AND weekday=?`).bind(id, weekday).all(),
    c.env.DB.prepare(`SELECT start_min, end_min FROM telemed_blocks WHERE doctor_id=? AND date=?`).bind(id, date).all(),
    c.env.DB.prepare(`SELECT start_min, end_min FROM telemed_appointments WHERE doctor_id=? AND date=? AND status NOT IN ('cancelled','no_show')`).bind(id, date).all(),
  ]);
  const blockIv: Interval[] = (blocks.results ?? []).map((b: any) => ({ start_min: b.start_min ?? 0, end_min: b.end_min ?? 1440 }));
  const slots = computeSlots({
    date,
    windows: (windows.results ?? []) as unknown as Interval[],
    blocks: blockIv,
    busy: (busy.results ?? []) as unknown as Interval[],
    duration: APPT_TYPES[type].duration,
    step: prefs.slot_minutes,
    nowMs: Date.now(),
  });
  return c.json({ ok: true, date, type, duration: APPT_TYPES[type].duration, slots }, 200, { 'Cache-Control': 'no-store' });
});

// ---------------------------------------------------------------------------
// BOOK + TRACK (patient, manage_token-gated)
// ---------------------------------------------------------------------------

// POST /book/appointments — create a booking. Re-validates the slot server-side.
telemedScheduling.post('/book/appointments', async (c) => {
  const limited = await rateLimit(c.env, c, 'telemed_book', 12, 600);
  if (limited) return limited;
  const b: any = (await c.req.json().catch(() => ({}))) || {};
  const name = String(b.patient_name || '').trim();
  const email = String(b.patient_email || '').trim().toLowerCase();
  const phone = String(b.patient_phone || '').trim();
  const reason = String(b.reason || '').trim();
  const type = String(b.appt_type || '').trim();
  const date = String(b.date || '').trim();
  const startMin = Number(b.start_min);
  if (!name) return c.json({ error: 'patient_name_required', hint: 'Indica el nombre del paciente.' }, 400);
  if (!email && !phone) return c.json({ error: 'contact_required', hint: 'Indica un correo o teléfono para coordinar la consulta.' }, 400);
  if (reason.length < 3) return c.json({ error: 'reason_required', hint: 'Cuéntale al médico el motivo de la consulta.' }, 400);
  if (!isApptType(type)) return c.json({ error: 'bad_type' }, 400);
  if (!DATE_RE.test(date) || !Number.isInteger(startMin) || startMin < 0 || startMin >= 1440) return c.json({ error: 'bad_slot' }, 400);
  if (nameHasSpam(name) || textHasLink(reason)) {
    await audit(c, 'spam_blocked', { ip: requestIp(c), src: 'telemed_book' }).catch(() => {});
    return c.json({ error: 'spam_blocked', hint: 'No incluyas enlaces.' }, 400);
  }
  const doctorId = String(b.doctor_id || '').trim().slice(0, 64);
  const doc = await c.env.DB.prepare(
    `SELECT id, full_name, email, specialty, panel_token FROM telemed_doctors WHERE id=? AND status='activo' AND moderation='approved' LIMIT 1`,
  ).bind(doctorId).first<any>().catch(() => null);
  if (!doc) return c.json({ error: 'doctor_not_found' }, 404);
  const prefs = await loadPrefs(c.env, doctorId);
  if (!prefs.accepting || !prefs.appt_types.includes(type)) return c.json({ error: 'doctor_unavailable', hint: 'Este médico no acepta este tipo de cita.' }, 409);

  // Re-compute available slots and require the requested start to be one of them
  // (prevents tampering + double-booking on a slot that filled while choosing).
  const weekday = weekdayOf(date);
  const [windows, blocks, busy] = await Promise.all([
    c.env.DB.prepare(`SELECT start_min, end_min FROM telemed_availability WHERE doctor_id=? AND weekday=?`).bind(doctorId, weekday).all(),
    c.env.DB.prepare(`SELECT start_min, end_min FROM telemed_blocks WHERE doctor_id=? AND date=?`).bind(doctorId, date).all(),
    c.env.DB.prepare(`SELECT start_min, end_min FROM telemed_appointments WHERE doctor_id=? AND date=? AND status NOT IN ('cancelled','no_show')`).bind(doctorId, date).all(),
  ]);
  const blockIv: Interval[] = (blocks.results ?? []).map((x: any) => ({ start_min: x.start_min ?? 0, end_min: x.end_min ?? 1440 }));
  const slots = computeSlots({
    date, windows: (windows.results ?? []) as unknown as Interval[], blocks: blockIv, busy: (busy.results ?? []) as unknown as Interval[],
    duration: APPT_TYPES[type].duration, step: prefs.slot_minutes, nowMs: Date.now(),
  });
  const slot = slots.find((s) => s.start_min === startMin);
  if (!slot) return c.json({ error: 'slot_unavailable', hint: 'Ese horario ya no está disponible. Elige otro.' }, 409);

  const specialty = SPECIALTIES.includes(String(b.specialty)) ? String(b.specialty) : (doc.specialty || 'general');
  const lang = LANGS.includes(String(b.preferred_lang)) ? String(b.preferred_lang) : 'es';
  // Expanded intake the doctor needs to start the consult.
  const GENDERS = ['Femenino', 'Masculino', 'Otro', 'Prefiero no decir'];
  const gender = GENDERS.includes(String(b.patient_gender)) ? String(b.patient_gender) : null;
  const dob = /^\d{4}-\d{2}-\d{2}$/.test(String(b.patient_dob || '')) ? String(b.patient_dob) : null;
  let age: number | null = null;
  if (dob) {
    const d = new Date(dob + 'T00:00:00Z'), n = new Date();
    let a = n.getUTCFullYear() - d.getUTCFullYear();
    const mm = n.getUTCMonth() - d.getUTCMonth();
    if (mm < 0 || (mm === 0 && n.getUTCDate() < d.getUTCDate())) a--;
    if (a >= 0 && a <= 120) age = a;
  }
  const cedula = b.patient_cedula ? String(b.patient_cedula).slice(0, 24) : null;
  const ploc = b.patient_location ? String(b.patient_location).slice(0, 120) : null;
  const id = uid('apt'); const manageToken = randomToken(20); const now = Date.now();
  const video = jitsiUrl(manageToken);
  await c.env.DB.prepare(
    `INSERT INTO telemed_appointments (id, doctor_id, patient_name, patient_email, patient_phone, specialty,
        appt_type, reason, insurance_provider, insurance_member_id,
        patient_location, patient_cedula, patient_dob, patient_gender, patient_age,
        date, start_min, end_min, start_ms, end_ms,
        status, video_url, preferred_lang, manage_token, ip, created_at, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id, doctorId, name.slice(0, 120), email.slice(0, 160) || null, phone.slice(0, 60) || null, specialty,
    type, reason.slice(0, 2000),
    b.insurance_provider ? String(b.insurance_provider).slice(0, 120) : null,
    b.insurance_member_id ? String(b.insurance_member_id).slice(0, 80) : null,
    ploc, cedula, dob, gender, age,
    date, slot.start_min, slot.end_min, slot.start_ms, localToMs(date, slot.end_min),
    'scheduled', video, lang, manageToken, requestIp(c), new Date(now).toISOString(), now, now,
  ).run();
  await c.env.DB.prepare(`INSERT INTO telemed_appt_status (id, appointment_id, status, actor, at_ms) VALUES (?,?,?,?,?)`)
    .bind(uid('sh'), id, 'scheduled', 'system', now).run();

  const track = trackUrl(c, manageToken);
  const icsUrl = `${baseUrl(c)}/api/telemedicina/appt/${id}/ics?t=${manageToken}`;
  const when = whenText(slot.start_ms);
  if (email) c.executionCtx?.waitUntil?.(sendEmail(c.env, email,
    telemedScheduledEmail({ toName: firstName(name), counterpartName: doc.full_name, whenText: when, videoUrl: video, icsUrl, manageUrl: track, forDoctor: false })).then(() => {}));
  if (doc.email) c.executionCtx?.waitUntil?.(sendEmail(c.env, doc.email,
    telemedScheduledEmail({ toName: firstName(doc.full_name), counterpartName: name, whenText: when, videoUrl: video, icsUrl, manageUrl: `${baseUrl(c)}/telemedicina-panel?doc=${doc.id}&t=${doc.panel_token}`, forDoctor: true })).then(() => {}));
  // Text confirmation (WhatsApp + SMS) — no-ops gracefully until Twilio secrets are set.
  if (phone) {
    const txt = `SISMO911 Telemedicina: tu videoconsulta con Dr(a). ${doc.full_name} está agendada para ${when}. Entra al video: ${video} · Sigue tu cita: ${track}`;
    c.executionCtx?.waitUntil?.(notifyPatientText(c.env, phone, txt).then(() => {}));
  }
  await audit(c, 'telemed.book', { id, doctor_id: doctorId, type, date }).catch(() => {});
  return c.json({
    ok: true, id, manage_token: manageToken, manage_url: track, status: 'scheduled',
    appointment: { id, doctor_name: doc.full_name, appt_type: type, type_label: APPT_TYPES[type as ApptType].label, date, time: minToHHMM(slot.start_min), when, video_url: video, ics_url: icsUrl },
  }, 201);
});

// GET /book/appointment/:token — patient status view + timeline.
telemedScheduling.get('/book/appointment/:token', async (c) => {
  const token = String(c.req.param('token') || '').trim().slice(0, 64);
  if (!token) return c.json({ error: 'token_required' }, 400);
  const a = await c.env.DB.prepare(
    `SELECT a.*, d.full_name AS doctor_name, d.country AS doctor_country FROM telemed_appointments a
       LEFT JOIN telemed_doctors d ON d.id = a.doctor_id WHERE a.manage_token=? LIMIT 1`,
  ).bind(token).first<any>().catch(() => null);
  if (!a) return c.json({ error: 'not_found' }, 404);
  const [hist, rx, consult] = await Promise.all([
    c.env.DB.prepare(`SELECT status, actor, note, at_ms FROM telemed_appt_status WHERE appointment_id=? ORDER BY at_ms ASC`).bind(a.id).all(),
    c.env.DB.prepare(`SELECT id, items, notes, issued_ms FROM telemed_prescriptions WHERE appointment_id=? ORDER BY issued_ms ASC`).bind(a.id).all(),
    c.env.DB.prepare(`SELECT summary FROM telemed_consults WHERE appointment_id=?`).bind(a.id).first<any>().catch(() => null),
  ]);
  return c.json({
    ok: true,
    appointment: {
      id: a.id, doctor_name: a.doctor_name, doctor_country: a.doctor_country, specialty: a.specialty,
      patient_name: a.patient_name,
      appt_type: a.appt_type, type_label: APPT_TYPES[a.appt_type as ApptType]?.label || a.appt_type,
      date: a.date, time: minToHHMM(a.start_min), when: whenText(a.start_ms), start_ms: a.start_ms,
      status: a.status, video_url: a.video_url, reason: a.reason,
      insurance_provider: a.insurance_provider, manage_token: a.manage_token,
      patient_location: a.patient_location, patient_cedula: a.patient_cedula,
      patient_dob: a.patient_dob, patient_gender: a.patient_gender, patient_age: a.patient_age,
    },
    history: hist.results ?? [],
    // Clinical outputs the patient may see: the plan + their récipe(s). Doctor-only notes are NOT exposed.
    plan: consult?.summary || '',
    prescriptions: (rx.results ?? []).map((r: any) => ({ id: r.id, items: safeJson(r.items, []), notes: r.notes, issued_ms: r.issued_ms })),
  }, 200, { 'Cache-Control': 'no-store' });
});

// Patient self-service status changes: check-in, enter waiting room, cancel.
async function patientStatus(c: any, to: ApptStatus) {
  const token = String(c.req.param('token') || '').trim().slice(0, 64);
  const a = await c.env.DB.prepare(`SELECT * FROM telemed_appointments WHERE manage_token=? LIMIT 1`).bind(token).first().catch(() => null);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (!canTransition(a.status as ApptStatus, to, 'patient')) return c.json({ error: 'bad_transition', from: a.status, to }, 409);
  const now = Date.now();
  await c.env.DB.prepare(`UPDATE telemed_appointments SET status=?, updated_ms=? WHERE id=?`).bind(to, now, a.id).run();
  await c.env.DB.prepare(`INSERT INTO telemed_appt_status (id, appointment_id, status, actor, at_ms) VALUES (?,?,?,?,?)`)
    .bind(uid('sh'), a.id, to, 'patient', now).run();
  await audit(c, 'telemed.appt_status', { id: a.id, to, actor: 'patient' }).catch(() => {});
  return c.json({ ok: true, id: a.id, status: to }, 200);
}
telemedScheduling.post('/book/appointment/:token/checkin', (c) => patientStatus(c, 'checked_in'));
telemedScheduling.post('/book/appointment/:token/waiting', (c) => patientStatus(c, 'waiting_room'));
telemedScheduling.post('/book/appointment/:token/cancel', (c) => patientStatus(c, 'cancelled'));

// ---------------------------------------------------------------------------
// DOCTOR PANEL (panel_token-gated)
// ---------------------------------------------------------------------------

// GET /panel/appointments?doc=&t= — the doctor's bookings (all statuses) + prefs.
telemedScheduling.get('/panel/appointments', async (c) => {
  const doc = await verifyDoctor(c.env, String(c.req.query('doc') || ''), String(c.req.query('t') || ''));
  if (!doc) return c.json({ error: 'unauthorized' }, 401);
  const { results } = await c.env.DB.prepare(
    `SELECT id, patient_name, patient_email, patient_phone, specialty, appt_type, reason, insurance_provider,
            patient_location, patient_cedula, patient_dob, patient_gender, patient_age,
            date, start_min, end_min, start_ms, end_ms, status, video_url, manage_token
       FROM telemed_appointments WHERE doctor_id=? ORDER BY start_ms ASC LIMIT 500`,
  ).bind(doc.id).all();
  const items = (results ?? []).map((a: any) => ({ ...a, time: minToHHMM(a.start_min), type_label: APPT_TYPES[a.appt_type as ApptType]?.label || a.appt_type }));
  return c.json({ ok: true, items, total: items.length }, 200, { 'Cache-Control': 'no-store' });
});

// POST /panel/appointments/:id/status — doctor drives the clinical lifecycle.
telemedScheduling.post('/panel/appointments/:id/status', async (c) => {
  const b: any = (await c.req.json().catch(() => ({}))) || {};
  const doc = await verifyDoctor(c.env, String(b.doctor_id || ''), String(b.token || ''));
  if (!doc) return c.json({ error: 'unauthorized' }, 401);
  const id = String(c.req.param('id') || '').trim().slice(0, 64);
  const to = String(b.status || '');
  if (!isStatus(to)) return c.json({ error: 'bad_status' }, 400);
  const a = await c.env.DB.prepare(`SELECT * FROM telemed_appointments WHERE id=? AND doctor_id=? LIMIT 1`).bind(id, doc.id).first<any>().catch(() => null);
  if (!a) return c.json({ error: 'not_your_appointment' }, 403);
  if (!canTransition(a.status as ApptStatus, to as ApptStatus, 'doctor')) return c.json({ error: 'bad_transition', from: a.status, to }, 409);
  const now = Date.now();
  await c.env.DB.prepare(`UPDATE telemed_appointments SET status=?, updated_ms=? WHERE id=?`).bind(to, now, id).run();
  await c.env.DB.prepare(`INSERT INTO telemed_appt_status (id, appointment_id, status, actor, note, at_ms) VALUES (?,?,?,?,?,?)`)
    .bind(uid('sh'), id, to, 'doctor', b.note ? String(b.note).slice(0, 300) : null, now).run();
  // Notify the patient on the meaningful transitions.
  if (a.patient_email && (to === 'in_progress' || to === 'completed' || to === 'cancelled' || to === 'no_show')) {
    c.executionCtx?.waitUntil?.(sendEmail(c.env, a.patient_email, telemedApptStatusEmail({
      toName: firstName(a.patient_name), kind: to, doctorName: doc.full_name, whenText: whenText(a.start_ms),
      videoUrl: a.video_url, manageUrl: trackUrl(c, a.manage_token),
    })).then(() => {}));
  }
  await audit(c, 'telemed.appt_status', { id, to, actor: 'doctor' }).catch(() => {});
  return c.json({ ok: true, id, status: to }, 200);
});

// GET /panel/availability?doc=&t= — current weekly hours, prefs, and upcoming blocks.
telemedScheduling.get('/panel/availability', async (c) => {
  const doc = await verifyDoctor(c.env, String(c.req.query('doc') || ''), String(c.req.query('t') || ''));
  if (!doc) return c.json({ error: 'unauthorized' }, 401);
  const prefs = await loadPrefs(c.env, doc.id);
  const [weekly, blocks] = await Promise.all([
    c.env.DB.prepare(`SELECT id, weekday, start_min, end_min FROM telemed_availability WHERE doctor_id=? ORDER BY weekday, start_min`).bind(doc.id).all(),
    c.env.DB.prepare(`SELECT id, date, start_min, end_min, reason FROM telemed_blocks WHERE doctor_id=? ORDER BY date`).bind(doc.id).all(),
  ]);
  return c.json({ ok: true, prefs, weekly: weekly.results ?? [], blocks: blocks.results ?? [] }, 200, { 'Cache-Control': 'no-store' });
});

// PUT /panel/availability — replace prefs + weekly windows in one call.
telemedScheduling.put('/panel/availability', async (c) => {
  const b: any = (await c.req.json().catch(() => ({}))) || {};
  const doc = await verifyDoctor(c.env, String(b.doctor_id || ''), String(b.token || ''));
  if (!doc) return c.json({ error: 'unauthorized' }, 401);
  const slotMin = [15, 20, 30, 45, 60].includes(Number(b.slot_minutes)) ? Number(b.slot_minutes) : 30;
  const accepting = b.accepting === false ? 0 : 1;
  let types: ApptType[] = Array.isArray(b.appt_types) ? b.appt_types.filter(isApptType) : [...APPT_TYPE_KEYS];
  if (!types.length) types = [...APPT_TYPE_KEYS];
  const windows: { weekday: number; start_min: number; end_min: number }[] = Array.isArray(b.weekly) ? b.weekly : [];
  const clean = windows
    .map((w) => ({ weekday: Number(w.weekday), start_min: Number(w.start_min), end_min: Number(w.end_min) }))
    .filter((w) => Number.isInteger(w.weekday) && w.weekday >= 0 && w.weekday <= 6
      && Number.isInteger(w.start_min) && Number.isInteger(w.end_min)
      && w.start_min >= 0 && w.end_min <= 1440 && w.end_min > w.start_min)
    .slice(0, 60);
  const now = Date.now();
  const stmts = [
    c.env.DB.prepare(`INSERT INTO telemed_doctor_prefs (doctor_id, slot_minutes, accepting, appt_types, updated_ms)
       VALUES (?,?,?,?,?) ON CONFLICT(doctor_id) DO UPDATE SET slot_minutes=excluded.slot_minutes, accepting=excluded.accepting, appt_types=excluded.appt_types, updated_ms=excluded.updated_ms`)
      .bind(doc.id, slotMin, accepting, JSON.stringify(types), now),
    c.env.DB.prepare(`DELETE FROM telemed_availability WHERE doctor_id=?`).bind(doc.id),
    ...clean.map((w) => c.env.DB.prepare(`INSERT INTO telemed_availability (id, doctor_id, weekday, start_min, end_min, created_ms) VALUES (?,?,?,?,?,?)`)
      .bind(uid('av'), doc.id, w.weekday, w.start_min, w.end_min, now)),
  ];
  await c.env.DB.batch(stmts);
  await audit(c, 'telemed.availability', { doctor_id: doc.id, windows: clean.length, accepting }).catch(() => {});
  return c.json({ ok: true, prefs: { slot_minutes: slotMin, accepting: !!accepting, appt_types: types }, windows: clean.length }, 200);
});

// POST /panel/blocks — add a blocked date/range (start/end omitted = whole day).
telemedScheduling.post('/panel/blocks', async (c) => {
  const b: any = (await c.req.json().catch(() => ({}))) || {};
  const doc = await verifyDoctor(c.env, String(b.doctor_id || ''), String(b.token || ''));
  if (!doc) return c.json({ error: 'unauthorized' }, 401);
  const date = String(b.date || '').trim();
  if (!DATE_RE.test(date)) return c.json({ error: 'bad_date' }, 400);
  const hasRange = b.start_min != null && b.end_min != null;
  const startMin = hasRange ? Number(b.start_min) : null;
  const endMin = hasRange ? Number(b.end_min) : null;
  if (hasRange && !(Number.isInteger(startMin) && Number.isInteger(endMin) && startMin! >= 0 && endMin! <= 1440 && endMin! > startMin!)) {
    return c.json({ error: 'bad_range' }, 400);
  }
  const id = uid('blk');
  await c.env.DB.prepare(`INSERT INTO telemed_blocks (id, doctor_id, date, start_min, end_min, reason, created_ms) VALUES (?,?,?,?,?,?,?)`)
    .bind(id, doc.id, date, startMin, endMin, b.reason ? String(b.reason).slice(0, 200) : null, Date.now()).run();
  return c.json({ ok: true, id }, 201);
});

// DELETE /panel/blocks/:id — remove a block (must belong to the doctor).
telemedScheduling.delete('/panel/blocks/:id', async (c) => {
  const b: any = (await c.req.json().catch(() => ({}))) || {};
  const doc = await verifyDoctor(c.env, String(b.doctor_id || ''), String(b.token || ''));
  if (!doc) return c.json({ error: 'unauthorized' }, 401);
  const id = String(c.req.param('id') || '').trim().slice(0, 64);
  const res = await c.env.DB.prepare(`DELETE FROM telemed_blocks WHERE id=? AND doctor_id=?`).bind(id, doc.id).run();
  if (!res.meta || res.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true, id }, 200);
});

// ---------------------------------------------------------------------------
// CLINICAL WORKSPACE (doctor, panel_token-gated) — history/notes, checklist,
// and an informational prescription record. Notes + prescriptions are
// append-only = the audit trail.
// ---------------------------------------------------------------------------

// Verify the doctor AND that the appointment is theirs. Returns {doc, appt} or null.
async function ownAppt(c: any, body: any): Promise<{ doc: any; appt: any } | null> {
  const doc = await verifyDoctor(c.env, String(body.doctor_id || c.req.query('doc') || ''), String(body.token || c.req.query('t') || ''));
  if (!doc) return null;
  const id = String(c.req.param('id') || '').trim().slice(0, 64);
  const appt = await c.env.DB.prepare(`SELECT * FROM telemed_appointments WHERE id=? AND doctor_id=? LIMIT 1`).bind(id, doc.id).first().catch(() => null);
  if (!appt) return null;
  return { doc, appt };
}

// GET /panel/appointment/:id?doc=&t= — full consult workspace for one appointment.
telemedScheduling.get('/panel/appointment/:id', async (c) => {
  const o = await ownAppt(c, {});
  if (!o) return c.json({ error: 'unauthorized' }, 401);
  const id = o.appt.id;
  const [notes, rx, consult] = await Promise.all([
    c.env.DB.prepare(`SELECT id, body, at_ms FROM telemed_consult_notes WHERE appointment_id=? ORDER BY at_ms ASC`).bind(id).all(),
    c.env.DB.prepare(`SELECT id, items, notes, issued_ms FROM telemed_prescriptions WHERE appointment_id=? ORDER BY issued_ms ASC`).bind(id).all(),
    c.env.DB.prepare(`SELECT summary, checklist, updated_ms FROM telemed_consults WHERE appointment_id=?`).bind(id).first<any>().catch(() => null),
  ]);
  const a = o.appt;
  return c.json({
    ok: true,
    appointment: {
      id, patient_name: a.patient_name, patient_email: a.patient_email, patient_phone: a.patient_phone,
      patient_cedula: a.patient_cedula, patient_age: a.patient_age, patient_gender: a.patient_gender,
      patient_location: a.patient_location, patient_dob: a.patient_dob, specialty: a.specialty,
      appt_type: a.appt_type, type_label: APPT_TYPES[a.appt_type as ApptType]?.label || a.appt_type,
      reason: a.reason, status: a.status, when: whenText(a.start_ms), video_url: a.video_url, manage_token: a.manage_token,
    },
    notes: notes.results ?? [],
    prescriptions: (rx.results ?? []).map((r: any) => ({ id: r.id, items: safeJson(r.items, []), notes: r.notes, issued_ms: r.issued_ms })),
    consult: consult ? { summary: consult.summary, checklist: safeJson(consult.checklist, {}), updated_ms: consult.updated_ms } : { summary: '', checklist: {}, updated_ms: null },
  }, 200, { 'Cache-Control': 'no-store' });
});

// POST /panel/appointment/:id/note — append a clinical history/notes entry (trail).
telemedScheduling.post('/panel/appointment/:id/note', async (c) => {
  const b: any = (await c.req.json().catch(() => ({}))) || {};
  const o = await ownAppt(c, b);
  if (!o) return c.json({ error: 'unauthorized' }, 401);
  const body = String(b.body || '').trim();
  if (body.length < 1) return c.json({ error: 'empty' }, 400);
  const nid = uid('cn'); const now = Date.now();
  await c.env.DB.prepare(`INSERT INTO telemed_consult_notes (id, appointment_id, doctor_id, body, at_ms) VALUES (?,?,?,?,?)`)
    .bind(nid, o.appt.id, o.doc.id, body.slice(0, 4000), now).run();
  await audit(c, 'telemed.consult_note', { id: o.appt.id }).catch(() => {});
  return c.json({ ok: true, id: nid, at_ms: now }, 201);
});

// PUT /panel/appointment/:id/consult — upsert the consult summary + checklist.
telemedScheduling.put('/panel/appointment/:id/consult', async (c) => {
  const b: any = (await c.req.json().catch(() => ({}))) || {};
  const o = await ownAppt(c, b);
  if (!o) return c.json({ error: 'unauthorized' }, 401);
  const summary = b.summary != null ? String(b.summary).slice(0, 4000) : null;
  const checklist = b.checklist && typeof b.checklist === 'object' ? JSON.stringify(b.checklist) : '{}';
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO telemed_consults (appointment_id, summary, checklist, updated_ms, updated_by) VALUES (?,?,?,?,?)
     ON CONFLICT(appointment_id) DO UPDATE SET summary=excluded.summary, checklist=excluded.checklist, updated_ms=excluded.updated_ms, updated_by=excluded.updated_by`,
  ).bind(o.appt.id, summary, checklist, now, o.doc.id).run();
  return c.json({ ok: true, updated_ms: now }, 200);
});

// POST /panel/appointment/:id/prescription — issue an informational récipe (trail).
telemedScheduling.post('/panel/appointment/:id/prescription', async (c) => {
  const b: any = (await c.req.json().catch(() => ({}))) || {};
  const o = await ownAppt(c, b);
  if (!o) return c.json({ error: 'unauthorized' }, 401);
  const rawItems = Array.isArray(b.items) ? b.items : [];
  const items = rawItems.map((it: any) => ({
    med: String(it.med || '').slice(0, 160), dose: String(it.dose || '').slice(0, 80),
    freq: String(it.freq || '').slice(0, 80), duration: String(it.duration || '').slice(0, 80),
    notes: String(it.notes || '').slice(0, 200),
  })).filter((it: any) => it.med);
  if (!items.length) return c.json({ error: 'no_items', hint: 'Agrega al menos un medicamento.' }, 400);
  const rid = uid('rx'); const now = Date.now();
  await c.env.DB.prepare(`INSERT INTO telemed_prescriptions (id, appointment_id, doctor_id, items, notes, issued_ms) VALUES (?,?,?,?,?,?)`)
    .bind(rid, o.appt.id, o.doc.id, JSON.stringify(items), b.notes ? String(b.notes).slice(0, 1000) : null, now).run();
  await audit(c, 'telemed.prescription', { id: o.appt.id, items: items.length }).catch(() => {});
  // Let the patient know a récipe is available.
  if (o.appt.patient_email) c.executionCtx?.waitUntil?.(sendEmail(c.env, o.appt.patient_email, telemedApptStatusEmail({
    toName: firstName(o.appt.patient_name), kind: 'completed', doctorName: o.doc.full_name, whenText: whenText(o.appt.start_ms),
    manageUrl: trackUrl(c, o.appt.manage_token),
  })).then(() => {}));
  return c.json({ ok: true, id: rid, issued_ms: now }, 201);
});

// GET /appt/:id/ics?t=<manage_token | panel_token> — calendar invite for a booking.
telemedScheduling.get('/appt/:id/ics', async (c) => {
  const id = String(c.req.param('id') || '').trim().slice(0, 64);
  const t = String(c.req.query('t') || '').trim().slice(0, 64);
  const a = await c.env.DB.prepare(
    `SELECT a.*, d.full_name AS doctor_name, d.panel_token AS doctor_token FROM telemed_appointments a
       LEFT JOIN telemed_doctors d ON d.id = a.doctor_id WHERE a.id=? LIMIT 1`,
  ).bind(id).first<any>().catch(() => null);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (t !== a.manage_token && t !== a.doctor_token) return c.json({ error: 'unauthorized' }, 401);
  const summary = icsEscape(`Telemedicina SISMO911 — ${APPT_TYPES[a.appt_type as ApptType]?.label || 'Consulta'}${a.doctor_name ? ' · Dr(a). ' + a.doctor_name : ''}`);
  const desc = icsEscape(`Videoconsulta de telemedicina.\nEntra a la videollamada: ${a.video_url}\nPaciente: ${a.patient_name}\nMotivo: ${a.reason || ''}`);
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SISMO911//Telemedicina//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:${id}@sismo911.com`, `DTSTAMP:${icsStamp(Date.now())}`,
    `DTSTART:${icsStamp(a.start_ms)}`, `DTEND:${icsStamp(a.end_ms || a.start_ms + 1800000)}`,
    `SUMMARY:${summary}`, `DESCRIPTION:${desc}`, `URL:${a.video_url || ''}`, `LOCATION:${icsEscape(a.video_url || 'Videollamada')}`,
    'STATUS:CONFIRMED',
    'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'DESCRIPTION:Videoconsulta SISMO911 en 15 min', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return c.body(lines.join('\r\n'), 200, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': `attachment; filename="sismo911-cita-${id}.ics"`,
    'Cache-Control': 'no-store',
  });
});
