import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { rateLimit, nameHasSpam, textHasLink, requestIp } from '../lib/security';
import { audit } from '../lib/audit';
import {
  sendEmail, randomToken,
  telemedDoctorWelcomeEmail, telemedRequestReceivedEmail, telemedClaimedEmail, telemedScheduledEmail,
} from '../lib/email';

export const telemedicina = new Hono<{ Bindings: Env }>();

// Canonical specialties (form + filters share this list).
const SPECIALTIES = [
  'general', 'pediatria', 'medicina_interna', 'cardiologia', 'ginecologia', 'traumatologia',
  'psicologia', 'psiquiatria', 'dermatologia', 'neurologia', 'nutricion', 'enfermeria', 'farmacia', 'otra',
];
const LANGS = ['es', 'en', 'pt', 'it', 'fr'];
const URGENCY = ['baja', 'normal', 'alta', 'critica'];

function baseUrl(c: any): string {
  return (c.env.PUBLIC_BASE_URL || 'https://sismo911.com').replace(/\/+$/, '');
}
function firstName(s: string): string {
  return String(s || '').trim().split(/\s+/)[0] || '';
}
// Free, no-key, browser-based video room. Works worldwide, embeddable in an iframe.
function jitsiUrl(token: string): string {
  return `https://meet.jit.si/sismo911-tm-${token}`;
}
// Verify a doctor by id + their private panel token. Returns the row or null.
async function verifyDoctor(env: Env, doctorId: string, token: string): Promise<any | null> {
  if (!doctorId || !token) return null;
  const r = await env.DB.prepare(
    `SELECT * FROM telemed_doctors WHERE id = ? AND panel_token = ? AND status='activo' AND moderation='approved' LIMIT 1`,
  ).bind(doctorId, token).first<any>().catch(() => null);
  return r || null;
}
// ICS UTC stamp: 20260627T143000Z
function icsStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
function icsEscape(s: string): string {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// ---------------------------------------------------------------------------
// DOCTORS
// ---------------------------------------------------------------------------

// POST /api/telemedicina/doctors/register — physician self-registration.
// Returns the private panel_token (shown once + emailed) used to access the panel.
telemedicina.post('/doctors/register', async (c) => {
  const limited = await rateLimit(c.env, c, 'telemed_doctor_register', 8, 600);
  if (limited) return limited;
  const b: any = (await c.req.json().catch(() => ({}))) || {};
  const name = String(b.full_name || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  if (!name) return c.json({ error: 'full_name_required', hint: 'Indica tu nombre.' }, 400);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: 'email_required', hint: 'Indica un correo válido (lo usamos para tu panel y avisos).' }, 400);
  if (nameHasSpam(name) || textHasLink(b.bio)) {
    await audit(c, 'spam_blocked', { ip: requestIp(c), src: 'telemed_doctor' }).catch(() => {});
    return c.json({ error: 'spam_blocked', hint: 'No incluyas enlaces.' }, 400);
  }
  const specialty = SPECIALTIES.includes(String(b.specialty)) ? String(b.specialty) : 'general';
  let languages: string[] = Array.isArray(b.languages) ? b.languages : String(b.languages || 'es').split(',');
  languages = languages.map((s) => String(s).trim().toLowerCase()).filter((s) => LANGS.includes(s)).slice(0, 5);
  if (!languages.length) languages = ['es'];

  // Idempotent: same email returns the existing doctor + token (re-sends panel link).
  const existing = await c.env.DB.prepare(`SELECT id, full_name, panel_token FROM telemed_doctors WHERE email = ? LIMIT 1`)
    .bind(email).first<any>().catch(() => null);
  if (existing?.id) {
    const panelUrl = `${baseUrl(c)}/telemedicina-panel?doc=${existing.id}&t=${existing.panel_token}`;
    c.executionCtx?.waitUntil?.(sendEmail(c.env, email, telemedDoctorWelcomeEmail(existing.full_name, panelUrl)).then(() => {}));
    return c.json({ ok: true, id: existing.id, panel_token: existing.panel_token, panel_url: panelUrl, duplicate: true }, 200);
  }

  const id = uid('doc'); const token = randomToken(24); const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO telemed_doctors (id, full_name, email, phone, country, specialty, license_no, languages, bio,
        panel_token, verified, moderation, status, ip, created_at, created_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id, name.slice(0, 120), email.slice(0, 160), b.phone ? String(b.phone).slice(0, 60) : null,
    b.country ? String(b.country).slice(0, 80) : null, specialty,
    b.license_no ? String(b.license_no).slice(0, 80) : null, JSON.stringify(languages),
    b.bio ? String(b.bio).slice(0, 800) : null, token, 0, 'approved', 'activo',
    requestIp(c), new Date(now).toISOString(), now,
  ).run();
  const panelUrl = `${baseUrl(c)}/telemedicina-panel?doc=${id}&t=${token}`;
  c.executionCtx?.waitUntil?.(sendEmail(c.env, email, telemedDoctorWelcomeEmail(name, panelUrl)).then(() => {}));
  await audit(c, 'telemed.doctor_register', { id, specialty }).catch(() => {});
  return c.json({ ok: true, id, panel_token: token, panel_url: panelUrl, status: 'approved' }, 201);
});

// GET /api/telemedicina/doctors — public directory (no PII beyond name/specialty/country).
telemedicina.get('/doctors', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, full_name, specialty, country, languages, bio, verified, created_ms
       FROM telemed_doctors WHERE status='activo' AND moderation='approved'
       ORDER BY verified DESC, created_ms DESC LIMIT 300`,
  ).all();
  return c.json({ ok: true, items: results ?? [], total: results?.length ?? 0 }, 200, { 'Cache-Control': 'public, max-age=60' });
});

// GET /api/telemedicina/doctors/me?doc=&t= — panel bootstrap: profile + this doctor's cases.
telemedicina.get('/doctors/me', async (c) => {
  const doc = await verifyDoctor(c.env, String(c.req.query('doc') || ''), String(c.req.query('t') || ''));
  if (!doc) return c.json({ error: 'unauthorized' }, 401);
  const { results } = await c.env.DB.prepare(
    `SELECT id, patient_name, patient_email, patient_phone, requester_country, patient_state, patient_city,
            specialty, urgency, preferred_lang, description, status, scheduled_start_ms, scheduled_end_ms,
            video_url, manage_token, created_ms
       FROM telemed_requests WHERE doctor_id = ? ORDER BY scheduled_start_ms IS NULL, scheduled_start_ms ASC, created_ms DESC LIMIT 300`,
  ).bind(doc.id).all();
  let languages: string[] = []; try { languages = JSON.parse(doc.languages || '[]'); } catch { languages = []; }
  return c.json({
    ok: true,
    doctor: { id: doc.id, full_name: doc.full_name, email: doc.email, specialty: doc.specialty, country: doc.country, languages, verified: !!doc.verified },
    cases: results ?? [],
  }, 200, { 'Cache-Control': 'no-store' });
});

// ---------------------------------------------------------------------------
// REQUESTS (patient intake)
// ---------------------------------------------------------------------------

// POST /api/telemedicina/requests — patient/relative submits a help request.
telemedicina.post('/requests', async (c) => {
  const limited = await rateLimit(c.env, c, 'telemed_request', 12, 600);
  if (limited) return limited;
  const b: any = (await c.req.json().catch(() => ({}))) || {};
  const name = String(b.patient_name || '').trim();
  if (!name) return c.json({ error: 'patient_name_required', hint: 'Indica el nombre del paciente.' }, 400);
  const email = String(b.patient_email || '').trim().toLowerCase();
  const phone = String(b.patient_phone || '').trim();
  if (!email && !phone) return c.json({ error: 'contact_required', hint: 'Indica un correo o teléfono para coordinar la consulta.' }, 400);
  if (nameHasSpam(name) || textHasLink(b.description)) {
    await audit(c, 'spam_blocked', { ip: requestIp(c), src: 'telemed_request' }).catch(() => {});
    return c.json({ error: 'spam_blocked', hint: 'No incluyas enlaces.' }, 400);
  }
  const specialty = SPECIALTIES.includes(String(b.specialty)) ? String(b.specialty) : 'general';
  const urgency = URGENCY.includes(String(b.urgency)) ? String(b.urgency) : 'normal';
  const lang = LANGS.includes(String(b.preferred_lang)) ? String(b.preferred_lang) : 'es';

  const id = uid('req'); const manageToken = randomToken(20); const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO telemed_requests (id, patient_name, patient_email, patient_phone, requester_country,
        patient_state, patient_city, specialty, urgency, preferred_lang, description, status,
        manage_token, ip, created_at, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id, name.slice(0, 120), email.slice(0, 160) || null, phone.slice(0, 60) || null,
    b.requester_country ? String(b.requester_country).slice(0, 80) : null,
    b.patient_state ? String(b.patient_state).slice(0, 80) : null,
    b.patient_city ? String(b.patient_city).slice(0, 80) : null,
    specialty, urgency, lang, b.description ? String(b.description).slice(0, 2000) : null,
    'open', manageToken, requestIp(c), new Date(now).toISOString(), now, now,
  ).run();

  const manageUrl = `${baseUrl(c)}/telemedicina?caso=${manageToken}`;
  if (email) c.executionCtx?.waitUntil?.(sendEmail(c.env, email, telemedRequestReceivedEmail({ name: firstName(name), refId: id, manageUrl, specialty })).then(() => {}));
  await audit(c, 'telemed.request', { id, specialty, urgency }).catch(() => {});
  return c.json({ ok: true, id, manage_token: manageToken, manage_url: manageUrl, status: 'open' }, 201);
});

// GET /api/telemedicina/requests — open queue board for doctors (PII redacted; safe public).
telemedicina.get('/requests', async (c) => {
  const specialty = String(c.req.query('specialty') || '').trim();
  const conds = ["status = 'open'"]; const binds: unknown[] = [];
  if (specialty && SPECIALTIES.includes(specialty)) { conds.push('specialty = ?'); binds.push(specialty); }
  const { results } = await c.env.DB.prepare(
    `SELECT id, patient_state, patient_city, requester_country, specialty, urgency, preferred_lang,
            substr(coalesce(description,''),0,280) AS description, created_ms
       FROM telemed_requests WHERE ${conds.join(' AND ')} ORDER BY
         CASE urgency WHEN 'critica' THEN 0 WHEN 'alta' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
         created_ms DESC LIMIT 200`,
  ).bind(...binds).all();
  return c.json({ ok: true, items: results ?? [], total: results?.length ?? 0 }, 200, { 'Cache-Control': 'public, max-age=20' });
});

// GET /api/telemedicina/request/:token — patient views their own request by manage_token.
telemedicina.get('/request/:token', async (c) => {
  const token = String(c.req.param('token') || '').trim().slice(0, 64);
  if (!token) return c.json({ error: 'token_required' }, 400);
  const r = await c.env.DB.prepare(
    `SELECT r.id, r.patient_name, r.specialty, r.urgency, r.status, r.scheduled_start_ms, r.scheduled_end_ms,
            r.video_url, r.created_ms, d.full_name AS doctor_name, d.specialty AS doctor_specialty, d.country AS doctor_country
       FROM telemed_requests r LEFT JOIN telemed_doctors d ON d.id = r.doctor_id
      WHERE r.manage_token = ? LIMIT 1`,
  ).bind(token).first<any>().catch(() => null);
  if (!r) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true, request: r }, 200, { 'Cache-Control': 'no-store' });
});

// ---------------------------------------------------------------------------
// DOCTOR ACTIONS (claim / schedule / complete) — gated by doc + panel token
// ---------------------------------------------------------------------------

// POST /api/telemedicina/requests/:id/claim — doctor accepts an open request.
telemedicina.post('/requests/:id/claim', async (c) => {
  const b: any = (await c.req.json().catch(() => ({}))) || {};
  const doc = await verifyDoctor(c.env, String(b.doctor_id || ''), String(b.token || ''));
  if (!doc) return c.json({ error: 'unauthorized' }, 401);
  const id = String(c.req.param('id') || '').trim().slice(0, 64);
  const r = await c.env.DB.prepare(`SELECT * FROM telemed_requests WHERE id = ? LIMIT 1`).bind(id).first<any>().catch(() => null);
  if (!r) return c.json({ error: 'not_found' }, 404);
  if (r.status !== 'open') return c.json({ error: 'already_taken', hint: 'Otra persona ya tomó este caso.' }, 409);
  const now = Date.now();
  await c.env.DB.prepare(`UPDATE telemed_requests SET status='claimed', doctor_id=?, updated_ms=? WHERE id=? AND status='open'`)
    .bind(doc.id, now, id).run();
  const manageUrl = `${baseUrl(c)}/telemedicina?caso=${r.manage_token}`;
  if (r.patient_email) c.executionCtx?.waitUntil?.(sendEmail(c.env, r.patient_email,
    telemedClaimedEmail({ patientName: firstName(r.patient_name), doctorName: doc.full_name, specialty: doc.specialty, manageUrl })).then(() => {}));
  await audit(c, 'telemed.claim', { id, doctor_id: doc.id }).catch(() => {});
  return c.json({ ok: true, id, status: 'claimed' }, 200);
});

// POST /api/telemedicina/requests/:id/schedule — doctor sets the appointment;
// generates the video room and emails BOTH parties the link + calendar invite.
telemedicina.post('/requests/:id/schedule', async (c) => {
  const b: any = (await c.req.json().catch(() => ({}))) || {};
  const doc = await verifyDoctor(c.env, String(b.doctor_id || ''), String(b.token || ''));
  if (!doc) return c.json({ error: 'unauthorized' }, 401);
  const id = String(c.req.param('id') || '').trim().slice(0, 64);
  const start = Number(b.start_ms);
  if (!Number.isFinite(start) || start < Date.now() - 60_000) return c.json({ error: 'bad_start', hint: 'Elige una fecha y hora futura.' }, 400);
  const durMin = Math.min(Math.max(Number(b.duration_min) || 30, 10), 120);
  const end = start + durMin * 60_000;
  const r = await c.env.DB.prepare(`SELECT * FROM telemed_requests WHERE id = ? LIMIT 1`).bind(id).first<any>().catch(() => null);
  if (!r) return c.json({ error: 'not_found' }, 404);
  if (r.doctor_id && r.doctor_id !== doc.id) return c.json({ error: 'not_your_case' }, 403);
  if (!['open', 'claimed', 'scheduled'].includes(r.status)) return c.json({ error: 'bad_status' }, 409);

  const videoUrl = r.video_url || jitsiUrl(r.manage_token);
  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE telemed_requests SET status='scheduled', doctor_id=?, scheduled_start_ms=?, scheduled_end_ms=?, video_url=?, updated_ms=? WHERE id=?`,
  ).bind(doc.id, start, end, videoUrl, now, id).run();

  const whenText = new Date(start).toLocaleString('es-VE', { timeZone: 'America/Caracas', dateStyle: 'full', timeStyle: 'short' }) + ' (hora de Venezuela)';
  const manageUrl = `${baseUrl(c)}/telemedicina?caso=${r.manage_token}`;
  const icsUrl = `${baseUrl(c)}/api/telemedicina/appointment/${id}/ics?t=${r.manage_token}`;
  // Patient
  if (r.patient_email) c.executionCtx?.waitUntil?.(sendEmail(c.env, r.patient_email,
    telemedScheduledEmail({ toName: firstName(r.patient_name), counterpartName: doc.full_name, whenText, videoUrl, icsUrl, manageUrl, forDoctor: false })).then(() => {}));
  // Doctor
  if (doc.email) c.executionCtx?.waitUntil?.(sendEmail(c.env, doc.email,
    telemedScheduledEmail({ toName: firstName(doc.full_name), counterpartName: r.patient_name, whenText, videoUrl, icsUrl, manageUrl: `${baseUrl(c)}/telemedicina-panel?doc=${doc.id}&t=${doc.panel_token}`, forDoctor: true })).then(() => {}));
  await audit(c, 'telemed.schedule', { id, doctor_id: doc.id, start }).catch(() => {});
  return c.json({ ok: true, id, status: 'scheduled', scheduled_start_ms: start, scheduled_end_ms: end, video_url: videoUrl, ics_url: icsUrl }, 200);
});

// POST /api/telemedicina/requests/:id/complete — doctor closes the case.
telemedicina.post('/requests/:id/complete', async (c) => {
  const b: any = (await c.req.json().catch(() => ({}))) || {};
  const doc = await verifyDoctor(c.env, String(b.doctor_id || ''), String(b.token || ''));
  if (!doc) return c.json({ error: 'unauthorized' }, 401);
  const id = String(c.req.param('id') || '').trim().slice(0, 64);
  const res = await c.env.DB.prepare(`UPDATE telemed_requests SET status='completed', updated_ms=? WHERE id=? AND doctor_id=?`)
    .bind(Date.now(), id, doc.id).run();
  if (!res.meta || res.meta.changes === 0) return c.json({ error: 'not_your_case' }, 403);
  await audit(c, 'telemed.complete', { id, doctor_id: doc.id }).catch(() => {});
  return c.json({ ok: true, id, status: 'completed' }, 200);
});

// ---------------------------------------------------------------------------
// CALENDAR
// ---------------------------------------------------------------------------

// GET /api/telemedicina/calendar?doc=&t= — this doctor's scheduled appointments (calendar feed).
telemedicina.get('/calendar', async (c) => {
  const doc = await verifyDoctor(c.env, String(c.req.query('doc') || ''), String(c.req.query('t') || ''));
  if (!doc) return c.json({ error: 'unauthorized' }, 401);
  const { results } = await c.env.DB.prepare(
    `SELECT id, patient_name, specialty, urgency, status, scheduled_start_ms, scheduled_end_ms, video_url, manage_token
       FROM telemed_requests WHERE doctor_id=? AND scheduled_start_ms IS NOT NULL AND status IN ('scheduled','completed')
       ORDER BY scheduled_start_ms ASC LIMIT 300`,
  ).bind(doc.id).all();
  return c.json({ ok: true, items: results ?? [], total: results?.length ?? 0 }, 200, { 'Cache-Control': 'no-store' });
});

// GET /api/telemedicina/appointment/:id/ics?t=<manage_token | panel_token> — downloadable calendar invite.
telemedicina.get('/appointment/:id/ics', async (c) => {
  const id = String(c.req.param('id') || '').trim().slice(0, 64);
  const t = String(c.req.query('t') || '').trim().slice(0, 64);
  const r = await c.env.DB.prepare(
    `SELECT r.*, d.full_name AS doctor_name, d.panel_token AS doctor_token
       FROM telemed_requests r LEFT JOIN telemed_doctors d ON d.id = r.doctor_id WHERE r.id = ? LIMIT 1`,
  ).bind(id).first<any>().catch(() => null);
  if (!r || !r.scheduled_start_ms) return c.json({ error: 'not_found' }, 404);
  // Authorize: patient's manage_token OR the assigned doctor's panel_token.
  if (t !== r.manage_token && t !== r.doctor_token) return c.json({ error: 'unauthorized' }, 401);
  const uidStr = `${id}@sismo911.com`;
  const summary = icsEscape(`Telemedicina SISMO911 — ${r.doctor_name ? 'Dr(a). ' + r.doctor_name : 'Consulta médica'}`);
  const desc = icsEscape(`Videoconsulta de telemedicina.\nEntra a la videollamada: ${r.video_url}\nPaciente: ${r.patient_name}`);
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SISMO911//Telemedicina//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:${uidStr}`, `DTSTAMP:${icsStamp(Date.now())}`,
    `DTSTART:${icsStamp(r.scheduled_start_ms)}`, `DTEND:${icsStamp(r.scheduled_end_ms || r.scheduled_start_ms + 1800000)}`,
    `SUMMARY:${summary}`, `DESCRIPTION:${desc}`, `URL:${r.video_url || ''}`, `LOCATION:${icsEscape(r.video_url || 'Videollamada')}`,
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
