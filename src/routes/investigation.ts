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
