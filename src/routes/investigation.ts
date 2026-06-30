/**
 * Investigation CRM + identity verification for the missing-person case file.
 * Mounted on /api/persons (alongside persons + evidence routers).
 *
 * GATING (src/rbac/route-policy.ts):
 *   - /:id/intel*  and /:id/identity*  → persons:moderate (operator), all methods
 *   - POST /:id/tip                    → PUBLIC (rate-limited + spam-gated)
 *   - GET /identity/sources            → operator (inline guard; no :id segment)
 * The public never sees the cédula or any verification record — only the derived
 * "identity_verified" badge surfaced through GET /:id/docket (in persons.ts).
 */
import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { rateLimit, nameHasSpam, textHasLink } from '../lib/security';
import { audit } from '../lib/audit';
import { getUserFromRequest } from '../lib/auth';
import { identitySources, verifyCedula, normalizeCedula, type IdentitySource } from '../lib/identity';
import { linkPatientToPerson, setCaseStatus, recordCaseEvent, isCaseStatus, registerConsultPatient, syncCaseFromAppointmentStatus, type CaseStatus } from '../lib/patients';

export const investigation = new Hono<{ Bindings: Env }>();

const FAM = 'fam-';
const HOSP = 'hosp-';
async function caseExists(env: Env, id: string): Promise<boolean> {
  if (id.startsWith(FAM)) return !!(await env.DB.prepare(`SELECT id FROM personas WHERE id = ?`).bind(id.slice(FAM.length)).first().catch(() => null));
  if (id.startsWith(HOSP)) return !!(await env.DB.prepare(`SELECT id FROM rav_reports WHERE id = ? AND kind='hospital'`).bind(id.slice(HOSP.length)).first().catch(() => null));
  return !!(await env.DB.prepare(`SELECT id FROM persons WHERE id = ?`).bind(id).first().catch(() => null));
}
async function isOperator(c: any): Promise<boolean> {
  const me = await getUserFromRequest(c.env, c).catch(() => null);
  return !!me && (me.role === 'operator' || me.role === 'admin');
}

const INTEL_TYPES = ['photo', 'social', 'link', 'sighting', 'tip', 'doc'];
const INTEL_STATUS = ['pending', 'verified', 'dismissed'];

// ---- Investigation leads (operator) -------------------------------------
// GET /api/persons/:id/intel — every lead (incl. pending tips) for triage.
investigation.get('/:id/intel', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, type, url, platform, title, detail, lat, lon, source, status, submitted_by, created_ms, updated_ms
     FROM case_intel WHERE person_id = ? ORDER BY (status='pending') DESC, created_ms DESC LIMIT 500`
  ).bind(c.req.param('id')).all();
  c.header('Cache-Control', 'no-store');
  return c.json({ leads: results ?? [] });
});

// POST /api/persons/:id/intel — operator adds a verified lead.
investigation.post('/:id/intel', async (c) => {
  const id = c.req.param('id');
  if (!(await caseExists(c.env, id))) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({} as any));
  const type = INTEL_TYPES.includes(b.type) ? b.type : 'link';
  const url = b.url ? String(b.url).slice(0, 600) : null;
  if (url && !/^https?:\/\//i.test(url)) return c.json({ error: 'bad_url' }, 400);
  const me = await getUserFromRequest(c.env, c).catch(() => null);
  const now = Date.now(); const lid = uid('intl');
  await c.env.DB.prepare(
    `INSERT INTO case_intel (id, person_id, type, url, platform, title, detail, lat, lon, source, status, submitted_by, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    lid, id, type, url,
    b.platform ? String(b.platform).slice(0, 40) : null,
    b.title ? String(b.title).slice(0, 160) : null,
    b.detail ? String(b.detail).slice(0, 2000) : null,
    b.lat == null ? null : Number(b.lat), b.lon == null ? null : Number(b.lon),
    'operator', 'verified', me?.email ?? me?.id ?? null, now, now
  ).run();
  await audit(c, 'persons.intel_add', { id, lid, type });
  return c.json({ ok: true, id: lid }, 201);
});

// PATCH /api/persons/:id/intel/:lid — operator sets verified|dismissed.
investigation.patch('/:id/intel/:lid', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  if (!INTEL_STATUS.includes(b.status)) return c.json({ error: 'bad_status' }, 400);
  const r = await c.env.DB.prepare(`UPDATE case_intel SET status = ?, updated_ms = ? WHERE id = ? AND person_id = ?`)
    .bind(b.status, Date.now(), c.req.param('lid'), c.req.param('id')).run();
  await audit(c, 'persons.intel_update', { id: c.req.param('id'), lid: c.req.param('lid'), status: b.status });
  return c.json({ ok: true, changed: r.meta.changes });
});

// DELETE /api/persons/:id/intel/:lid — operator removes a lead.
investigation.delete('/:id/intel/:lid', async (c) => {
  const r = await c.env.DB.prepare(`DELETE FROM case_intel WHERE id = ? AND person_id = ?`)
    .bind(c.req.param('lid'), c.req.param('id')).run();
  await audit(c, 'persons.intel_delete', { id: c.req.param('id'), lid: c.req.param('lid') });
  return c.json({ ok: true, changed: r.meta.changes });
});

// POST /api/persons/:id/tip — PUBLIC citizen lead. Lands status='pending' for
// operator triage; never auto-published. Rate-limited + link/spam gated.
investigation.post('/:id/tip', async (c) => {
  const id = c.req.param('id');
  if (!(await caseExists(c.env, id))) return c.json({ error: 'not_found' }, 404);
  const limited = await rateLimit(c.env, c, 'case_tip', 8, 600);
  if (limited) return limited;
  const b = await c.req.json().catch(() => ({} as any));
  const type = ['sighting', 'photo', 'social', 'link'].includes(b.type) ? b.type : 'sighting';
  const url = b.url ? String(b.url).slice(0, 600) : null;
  if (url && !/^https?:\/\//i.test(url)) return c.json({ error: 'bad_url' }, 400);
  const detail = b.detail ? String(b.detail).slice(0, 2000) : null;
  const title = b.title ? String(b.title).slice(0, 160) : null;
  if ((detail && (textHasLink(detail) || nameHasSpam(detail))) || (title && nameHasSpam(title))) {
    await audit(c, 'spam_blocked', { id, src: 'case_tip' }).catch(() => {});
    return c.json({ error: 'spam_blocked', hint: 'No incluyas enlaces ni spam en el texto.' }, 400);
  }
  if (!url && !detail) return c.json({ error: 'nothing_to_submit', hint: 'Indica un enlace o una descripción.' }, 400);
  const now = Date.now(); const lid = uid('intl');
  await c.env.DB.prepare(
    `INSERT INTO case_intel (id, person_id, type, url, platform, title, detail, lat, lon, source, status, submitted_by, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    lid, id, type, url, b.platform ? String(b.platform).slice(0, 40) : null, title, detail,
    b.lat == null ? null : Number(b.lat), b.lon == null ? null : Number(b.lon),
    'citizen', 'pending', null, now, now
  ).run();
  await audit(c, 'persons.tip_add', { id, lid, type });
  return c.json({ ok: true, id: lid, status: 'pending', message: 'Gracias. Tu pista quedó pendiente de verificación por un operador.' }, 201);
});

// POST /api/persons/:id/protect — operator flags a case as PROTECTED (responder-
// only): it is suppressed from every PUBLIC surface (list, gallery, photo, detail,
// docket, shareable article, sitemap). Body { protected?: boolean } — default true;
// pass false to lift. Handles native (per_) + Familia (fam-) cases. Gated
// persons:moderate (route-policy: path ends with /protect). See lib/minor-protect.
investigation.post('/:id/protect', async (c) => {
  const id = c.req.param('id');
  if (!(await caseExists(c.env, id))) return c.json({ error: 'not_found' }, 404);
  if (id.startsWith(HOSP)) return c.json({ error: 'unsupported', hint: 'Las altas hospitalarias no se protegen aquí.' }, 400);
  const b = await c.req.json().catch(() => ({} as any));
  const flag = b?.protected === false ? 0 : 1;
  if (id.startsWith(FAM)) {
    await c.env.DB.prepare(`UPDATE personas SET protected = ?, updated_at = ? WHERE id = ?`).bind(flag, Date.now(), id.slice(FAM.length)).run();
  } else {
    await c.env.DB.prepare(`UPDATE persons SET protected = ?, updated_ms = ? WHERE id = ?`).bind(flag, Date.now(), id).run();
  }
  await audit(c, 'persons.protect', { id, protected: !!flag });
  return c.json({ ok: true, protected: !!flag });
});

// ---- Identity verification (operator-only) ------------------------------
// GET /api/persons/identity/sources — honest per-institution status.
investigation.get('/identity/sources', async (c) => {
  if (!(await isOperator(c))) return c.json({ error: 'unauthorized' }, 401);
  c.header('Cache-Control', 'no-store');
  return c.json({ sources: identitySources(c.env) });
});

// GET /api/persons/:id/identity — full verification records (operator-only; the
// route is gated persons:moderate, so reaching here means operator).
investigation.get('/:id/identity', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, cedula, source, result, matched_name, detail_json, snapshot_r2, verified_by, created_ms
     FROM case_identity WHERE person_id = ? ORDER BY created_ms DESC`
  ).bind(c.req.param('id')).all();
  const verified = (results ?? []).some((r: any) => r.result === 'match');
  c.header('Cache-Control', 'no-store');
  return c.json({ records: results ?? [], verified });
});

// POST /api/persons/:id/identity/verify — operator verifies a cédula against an
// institution (CNE wired to the external resolver; others honest-unavailable),
// or records a manual confirmation. Stores the result (cédula operator-only).
investigation.post('/:id/identity/verify', async (c) => {
  const id = c.req.param('id');
  if (!(await caseExists(c.env, id))) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({} as any));
  const source = (['cne', 'rif', 'saime', 'ivss', 'manual'] as IdentitySource[]).includes(b.source) ? b.source as IdentitySource : 'cne';
  const cedula = normalizeCedula(b.cedula || '');
  if (!cedula) return c.json({ error: 'cedula_required' }, 400);

  // Best-effort case name for match classification.
  let expectedName: string | null = null;
  if (id.startsWith(FAM)) expectedName = (await c.env.DB.prepare(`SELECT nombre FROM personas WHERE id = ?`).bind(id.slice(FAM.length)).first<any>().catch(() => null))?.nombre ?? null;
  else if (!id.startsWith(HOSP)) expectedName = (await c.env.DB.prepare(`SELECT full_name FROM persons WHERE id = ?`).bind(id).first<any>().catch(() => null))?.full_name ?? null;

  let outcome;
  if (source === 'manual') {
    // Operator asserts a manual confirmation (e.g. verified offline). result=match.
    outcome = { result: 'match' as const, matched_name: b.matched_name ? String(b.matched_name).slice(0, 160) : expectedName, detail: b.detail ? { note: String(b.detail).slice(0, 500) } : null };
  } else {
    outcome = await verifyCedula(c.env, source, cedula, expectedName);
  }

  const me = await getUserFromRequest(c.env, c).catch(() => null);
  const rid = uid('idv');
  await c.env.DB.prepare(
    `INSERT INTO case_identity (id, person_id, cedula, source, result, matched_name, detail_json, snapshot_r2, verified_by, created_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    rid, id, cedula, source, outcome.result, outcome.matched_name ?? null,
    outcome.detail ? JSON.stringify(outcome.detail) : null, null, me?.email ?? me?.id ?? null, Date.now()
  ).run();
  // Audit records WHO verified WHICH case against WHICH source — never the cédula plaintext.
  await audit(c, 'persons.identity_verify', { id, source, result: outcome.result });
  return c.json({ ok: true, id: rid, result: outcome.result, matched_name: outcome.matched_name ?? null, reason: (outcome as any).reason ?? null }, 201);
});

// ---- Telemedicina ↔ casos bridge (operator) -----------------------------
// The medical layer (patients + patient_cases + patient_case_events) lives in
// the SAME D1 as the public case file; these surfaces let operators follow up
// medical cases and attach a patient to a public person case. All paths here are
// gated persons:moderate (route-policy isMedicalCases / isCaseAdmin). Medical PII
// is never exposed on the citizen-facing /familia pages — only this operator API.
const MED_CASE_COLS = `id, patient_id, status, priority, specialty, assigned_doctor_id, opening_appointment_id, person_id, summary, opened_ms, updated_ms, last_activity_ms, closed_ms`;

// POST /medical-cases/backfill — one-time (idempotent) migration of EXISTING
// consults: register each patient + open/follow its case using the exact runtime
// logic (so cédula dedup never drifts). Batched (≤50/call) to stay under the
// Workers subrequest budget; returns `remaining` so the operator re-calls until 0.
investigation.post('/medical-cases/backfill', async (c) => {
  const batch = Math.min(Math.max(Number((await c.req.json().catch(() => ({})))?.batch) || 50, 1), 50);
  let appts = 0, reqs = 0;
  const apptRows = await c.env.DB.prepare(
    `SELECT id, patient_name, patient_cedula, patient_email, patient_phone, patient_dob, patient_gender, patient_location, specialty, doctor_id, status
       FROM telemed_appointments WHERE patient_id IS NULL ORDER BY created_ms ASC LIMIT ?`,
  ).bind(batch).all<any>();
  for (const a of apptRows.results ?? []) {
    await registerConsultPatient(c.env, {
      appointmentId: a.id, kind: 'appointment', patient_name: a.patient_name,
      patient_cedula: a.patient_cedula, patient_email: a.patient_email, patient_phone: a.patient_phone,
      patient_dob: a.patient_dob, patient_gender: a.patient_gender, patient_city: a.patient_location,
      specialty: a.specialty, doctor_id: a.doctor_id,
    });
    // Reflect the consult's final status onto its case (e.g. old completed → resuelto).
    if (a.status && a.status !== 'scheduled') await syncCaseFromAppointmentStatus(c.env, a.id, a.status, 'backfill').catch(() => null);
    appts++;
  }
  const remainAppts = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM telemed_appointments WHERE patient_id IS NULL`).first<{ n: number }>();
  // Only touch legacy requests once appointments are fully migrated, to keep each call small.
  let remainReqs = 1;
  if ((remainAppts?.n ?? 0) === 0) {
    const reqRows = await c.env.DB.prepare(
      `SELECT id, patient_name, patient_email, patient_phone, patient_state, patient_city, specialty
         FROM telemed_requests WHERE patient_id IS NULL ORDER BY created_ms ASC LIMIT ?`,
    ).bind(batch).all<any>();
    for (const r of reqRows.results ?? []) {
      await registerConsultPatient(c.env, {
        appointmentId: r.id, kind: 'request', patient_name: r.patient_name,
        patient_email: r.patient_email, patient_phone: r.patient_phone,
        patient_state: r.patient_state, patient_city: r.patient_city, specialty: r.specialty,
      });
      reqs++;
    }
    remainReqs = (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM telemed_requests WHERE patient_id IS NULL`).first<{ n: number }>())?.n ?? 0;
  }
  const remaining = (remainAppts?.n ?? 0) + (remainReqs ?? 0);
  await audit(c, 'medcase.backfill', { appts, reqs, remaining }).catch(() => {});
  return c.json({ ok: true, migrated: { appointments: appts, requests: reqs }, remaining, done: remaining === 0 });
});

// GET /medical-cases?status=&q=&limit= — operator list of medical cases.
investigation.get('/medical-cases', async (c) => {
  const status = String(c.req.query('status') || '').trim();
  const q = String(c.req.query('q') || '').trim().slice(0, 80);
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 100, 1), 200);
  const where: string[] = []; const binds: any[] = [];
  if (isCaseStatus(status)) { where.push('mc.status = ?'); binds.push(status); }
  if (q) { where.push('(p.full_name LIKE ? OR p.cedula LIKE ?)'); binds.push(`%${q}%`, `%${q}%`); }
  const sql = `SELECT mc.id, mc.status, mc.priority, mc.specialty, mc.assigned_doctor_id, mc.person_id,
                      mc.opened_ms, mc.last_activity_ms, mc.closed_ms,
                      p.id AS patient_id, p.full_name, p.cedula, p.email, p.phone
                 FROM patient_cases mc JOIN patients p ON p.id = mc.patient_id
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY (mc.status NOT IN ('resuelto','cancelado')) DESC, mc.last_activity_ms DESC LIMIT ?`;
  const { results } = await c.env.DB.prepare(sql).bind(...binds, limit).all();
  c.header('Cache-Control', 'no-store');
  return c.json({ cases: results ?? [] });
});

// GET /medical-cases/:caseId — full medical case: patient, timeline, consults.
investigation.get('/medical-cases/:caseId', async (c) => {
  const caseId = c.req.param('caseId');
  const mc = await c.env.DB.prepare(`SELECT ${MED_CASE_COLS} FROM patient_cases WHERE id = ?`).bind(caseId).first<any>();
  if (!mc) return c.json({ error: 'not_found' }, 404);
  const patient = await c.env.DB.prepare(
    `SELECT id, full_name, cedula, email, phone, dob, gender, state, city, person_id FROM patients WHERE id = ?`,
  ).bind(mc.patient_id).first<any>();
  const [events, consults] = await Promise.all([
    c.env.DB.prepare(`SELECT id, kind, appointment_id, detail, actor, at_ms FROM patient_case_events WHERE case_id = ? ORDER BY at_ms DESC LIMIT 200`).bind(caseId).all(),
    c.env.DB.prepare(`SELECT id, specialty, appt_type, status, date, start_ms, reason FROM telemed_appointments WHERE patient_id = ? ORDER BY start_ms DESC LIMIT 100`).bind(mc.patient_id).all(),
  ]);
  c.header('Cache-Control', 'no-store');
  return c.json({ case: mc, patient: patient ?? null, events: events.results ?? [], consults: consults.results ?? [] });
});

// POST /medical-cases/:caseId/status — operator advances the case lifecycle.
investigation.post('/medical-cases/:caseId/status', async (c) => {
  const caseId = c.req.param('caseId');
  const b: any = (await c.req.json().catch(() => ({}))) || {};
  const status = String(b.status || '');
  if (!isCaseStatus(status)) return c.json({ error: 'bad_status', allowed: ['abierto', 'en_consulta', 'seguimiento', 'resuelto', 'cancelado'] }, 400);
  const exists = await c.env.DB.prepare(`SELECT id FROM patient_cases WHERE id = ?`).bind(caseId).first().catch(() => null);
  if (!exists) return c.json({ error: 'not_found' }, 404);
  const me = await getUserFromRequest(c.env, c).catch(() => null);
  const actor = me?.email ?? me?.id ?? 'operator';
  await setCaseStatus(c.env, caseId, status as CaseStatus);
  await recordCaseEvent(c.env, caseId, status === 'resuelto' ? 'resolved' : 'status_change', { detail: status, actor });
  await audit(c, 'medcase.status', { id: caseId, status }).catch(() => {});
  return c.json({ ok: true, id: caseId, status });
});

// GET /:id/medical — the medical follow-up attached to a public case file.
investigation.get('/:id/medical', async (c) => {
  const id = c.req.param('id');
  const [patients, cases] = await Promise.all([
    c.env.DB.prepare(`SELECT id, full_name, cedula, email, phone FROM patients WHERE person_id = ? ORDER BY updated_ms DESC LIMIT 50`).bind(id).all(),
    c.env.DB.prepare(`SELECT ${MED_CASE_COLS} FROM patient_cases WHERE person_id = ? ORDER BY last_activity_ms DESC LIMIT 50`).bind(id).all(),
  ]);
  c.header('Cache-Control', 'no-store');
  return c.json({ person_id: id, patients: patients.results ?? [], cases: cases.results ?? [] });
});

// POST /:id/medical/link — attach a patient to this public case.
investigation.post('/:id/medical/link', async (c) => {
  const id = c.req.param('id');
  if (!(await caseExists(c.env, id))) return c.json({ error: 'case_not_found' }, 404);
  const b: any = (await c.req.json().catch(() => ({}))) || {};
  const patientId = String(b.patient_id || '').trim().slice(0, 64);
  if (!patientId) return c.json({ error: 'patient_id_required' }, 400);
  const exists = await c.env.DB.prepare(`SELECT id FROM patients WHERE id = ?`).bind(patientId).first().catch(() => null);
  if (!exists) return c.json({ error: 'patient_not_found' }, 404);
  const me = await getUserFromRequest(c.env, c).catch(() => null);
  await linkPatientToPerson(c.env, patientId, id, me?.email ?? me?.id ?? 'operator');
  await audit(c, 'medcase.link', { person_id: id, patient_id: patientId }).catch(() => {});
  return c.json({ ok: true, person_id: id, patient_id: patientId });
});

// POST /:id/medical/unlink — detach a patient from this public case.
investigation.post('/:id/medical/unlink', async (c) => {
  const id = c.req.param('id');
  const b: any = (await c.req.json().catch(() => ({}))) || {};
  const patientId = String(b.patient_id || '').trim().slice(0, 64);
  if (!patientId) return c.json({ error: 'patient_id_required' }, 400);
  const now = Date.now();
  await c.env.DB.prepare(`UPDATE patients SET person_id = NULL, updated_ms = ? WHERE id = ? AND person_id = ?`).bind(now, patientId, id).run();
  await c.env.DB.prepare(`UPDATE patient_cases SET person_id = NULL, updated_ms = ? WHERE patient_id = ? AND person_id = ?`).bind(now, patientId, id).run();
  const me = await getUserFromRequest(c.env, c).catch(() => null);
  const open = await c.env.DB.prepare(
    `SELECT id FROM patient_cases WHERE patient_id = ? AND status NOT IN ('resuelto','cancelado') ORDER BY opened_ms DESC LIMIT 1`,
  ).bind(patientId).first<any>().catch(() => null);
  if (open) await recordCaseEvent(c.env, open.id, 'unlinked_person', { detail: id, actor: me?.email ?? me?.id ?? 'operator' });
  await audit(c, 'medcase.unlink', { person_id: id, patient_id: patientId }).catch(() => {});
  return c.json({ ok: true });
});
