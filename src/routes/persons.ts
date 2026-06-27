import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { rateLimit, validLatLon, blurCoord, nameHasSpam, textHasLink, requestIp, isImageBytes } from '../lib/security';
import { audit } from '../lib/audit';
import { getUserFromRequest } from '../lib/auth';
import { scoreCase } from '../lib/case-score';
import { recomputeCaseScore } from '../lib/case-score-sync';
import { edgeCached } from '../lib/edge-cache';

export const persons = new Hono<{ Bindings: Env }>();

// Attach the live FEMA-triage score to a case/person object (compute-on-read,
// so it always reflects the current status + new info). Derived priority wins
// over any stored value. Reads non-PII signals only → safe for public payloads.
function withScore<T extends Record<string, any>>(x: T, now = Date.now()): T & {
  score: number; priority: string; triage: string; triage_label: string; triage_color: string; score_reasons: string[];
} {
  const sc = scoreCase({
    status: x.status, age: x.age ?? null, incidentType: x.incident_type ?? null,
    createdMs: x.created_ms ?? null, lastActivityMs: x.last_activity_ms ?? null,
    docketCount: x.docket_count ?? 0, eventMag: x.event_mag ?? null, eventAlert: x.event_alert ?? null, now,
  });
  return { ...x, score: sc.score, priority: sc.priority, triage: sc.triage, triage_label: sc.label, triage_color: sc.color, score_reasons: sc.reasons };
}

// True when the current request is from a signed-in operator/admin.
async function isOperator(c: any): Promise<boolean> {
  const me = await getUserFromRequest(c.env, c).catch(() => null);
  return !!me && (me.role === 'operator' || me.role === 'admin');
}

// ---- Familia bridge -------------------------------------------------
// The 33k Familia registry lives in the DESAP `personas` DB. We federate those
// records into the case system as cases with id "fam-<personas.id>", anchored to
// the terremoto event so each docket starts at the date of the quake. Docket
// entries / evidence / tasks for a Familia case are stored in the main DB keyed
// by the "fam-" id (no row is copied into `persons`).
const FAM = 'fam-';
const isFam = (id: string) => id.startsWith(FAM);
const famKey = (id: string) => id.slice(FAM.length);
// Hospital intakes (rav_reports kind=hospital) federate into the docket as cases
// with id "hosp-<id>", so they paginate/search alongside missing-person cases.
const HOSP = 'hosp-';
const isHosp = (id: string) => id.startsWith(HOSP);
const hospKey = (id: string) => id.slice(HOSP.length);
const hospCaseNo = (rid: string) => 'HOSP-' + String(rid).replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase();
// Normalize a name for cross-matching a desaparecido against a hospital intake.
const normName = (s: string | null | undefined) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
// Best-effort hospital/centro name from an intake report's free-text fields.
function hospNameFrom(r: any): string {
  const hit = String(r.description || '').split(/\n|\.|·|\//).map((s: string) => s.trim())
    .find((s: string) => /hospital|cl[ií]nic|cdi|ambulatori|perif[eé]ric|materni|centro de salud|seguro social/i.test(s));
  const parts = [hit, r.contact, r.city, r.state].filter((x: any) => x && !/^\+?\d[\d\s-]{5,}$/.test(String(x)));
  return parts[0] || 'Hospital no indicado';
}
// Synthesize a case-shaped person object from a hospital intake row.
function hospPerson(r: any, op: boolean): any {
  const ms = Date.parse(r.created_at) || Date.now();
  const p: any = {
    id: HOSP + r.id, case_number: hospCaseNo(r.id), full_name: r.title || 'Hospitalizado',
    status: 'hospitalizado', incident_type: 'hospitalizado', hospital_name: hospNameFrom(r),
    last_seen: [r.city, r.state].filter(Boolean).join(', ') || null, photo_url: r.photo_url || null,
    notes: r.description || null, source: 'hospital', review: 'approved',
    created_ms: ms, updated_ms: ms, docket_count: 0, last_activity_ms: ms,
  };
  if (op) p.contact_phone = r.contact || null;
  return p;
}
const estadoToStatus = (e: string) =>
  e === 'localizado' ? 'found_safe'
  : e === 'aparecido' ? 'aparecido'
  : e === 'hospitalizado' ? 'hospitalizado'
  : e === 'fallecido' ? 'found_deceased'
  : 'missing';
const statusToEstado = (s: string) =>
  s === 'found_safe' ? 'localizado'
  : s === 'aparecido' ? 'aparecido'
  : s === 'hospitalizado' ? 'hospitalizado'
  : s === 'found_deceased' ? 'fallecido'
  : 'sin-contacto';
// Canonical case status vocabulary (shared across PATCH, docket, /cases, /update).
const CASE_STATUSES = ['missing', 'found_safe', 'aparecido', 'hospitalizado', 'found_deceased', 'unknown'];
const FOUND_ALIVE = ['found_safe', 'aparecido', 'hospitalizado'];
const famCaseNumber = (pid: string) => 'FAM-' + String(pid).replace(/[^a-zA-Z0-9]/g, '').slice(-8).toUpperCase();

// The reference earthquake every case is anchored to (Yumare M7.5, 2026-06-24),
// falling back to the strongest event on record.
async function quakeRef(env: any): Promise<any> {
  return (await env.DB.prepare(`SELECT id, mag, place, place_es, time_ms, depth_km, alert, lat, lon, url FROM events WHERE id = 'us6000t7zp'`).first())
    || (await env.DB.prepare(`SELECT id, mag, place, place_es, time_ms, depth_km, alert, lat, lon, url FROM events ORDER BY mag DESC LIMIT 1`).first());
}

// Does a case id exist (native persons OR Familia personas)?
async function caseExists(env: any, id: string): Promise<boolean> {
  if (isFam(id)) return !!(await env.DB.prepare(`SELECT id FROM personas WHERE id = ?`).bind(famKey(id)).first());
  return !!(await env.DB.prepare(`SELECT id FROM persons WHERE id = ?`).bind(id).first());
}

// Build the case "person" object for a Familia record + its metadata overlay.
async function famPerson(env: any, id: string, op: boolean): Promise<any> {
  const row: any = await env.DB.prepare(`SELECT * FROM personas WHERE id = ?`).bind(famKey(id)).first();
  if (!row) return null;
  const meta: any = await env.DB.prepare(`SELECT priority, incident_type, assigned_to FROM case_meta WHERE person_id = ?`).bind(id).first().catch(() => null);
  const base: any = {
    id, case_number: famCaseNumber(row.id), full_name: row.nombre, age: row.edad, sex: null,
    last_seen: row.ubicacion, status: estadoToStatus(row.estado), review: 'approved',
    priority: meta?.priority || 'media', incident_type: meta?.incident_type || 'persona_desaparecida', assigned_to: meta?.assigned_to || null,
    photo_url: row.foto_r2 ? `/api/familia/photo/${row.id}` : (row.foto || null),
    notes: row.descripcion, created_ms: row.created_at, updated_ms: row.updated_at, source: 'familia',
    contact_phone: row.contacto || null, reported_by: null, last_seen_lat: null, last_seen_lon: null,
  };
  if (op) return base;
  const { contact_phone, reported_by, last_seen_lat, last_seen_lon, priority, assigned_to, ...pub } = base;
  return pub;
}

// Append a tracing entry to a person's case docket. Best-effort: a docket write
// must never break the underlying status/report operation, so failures are
// logged and swallowed. `review` defaults to 'approved' (system/operator); a
// citizen-submitted update passes 'pending'.
async function logDocket(
  c: any,
  person_id: string,
  kind: string,
  f: { status_from?: string | null; status_to?: string | null; detail?: string | null; location?: string | null; lat?: number | null; lon?: number | null; source?: string | null; review?: string } = {}
) {
  try {
    const actor = await getUserFromRequest(c.env, c).catch(() => null);
    await c.env.DB.prepare(
      `INSERT INTO person_events (id, person_id, kind, status_from, status_to, detail, location, lat, lon, source, actor, review, created_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      uid('pev'), person_id, kind,
      f.status_from ?? null, f.status_to ?? null,
      f.detail ?? null, f.location ?? null, f.lat ?? null, f.lon ?? null,
      f.source ?? 'operator', actor?.email ?? actor?.id ?? null, f.review ?? 'approved', Date.now()
    ).run();
  } catch (e: any) {
    console.error('[docket] log failed:', e?.message ?? e);
  }
}

// GET /api/persons/stats — live missing/found counters (approved only).
persons.get('/stats', async (c) => edgeCached(c, 60, async () => {
  const row: any = await c.env.DB.prepare(
    `SELECT
       SUM(CASE WHEN status='missing' THEN 1 ELSE 0 END) AS missing,
       SUM(CASE WHEN status IN ('found_safe','aparecido','hospitalizado','found_deceased') THEN 1 ELSE 0 END) AS found,
       SUM(CASE WHEN status='hospitalizado' THEN 1 ELSE 0 END) AS hospitalized,
       COUNT(*) AS total
     FROM persons WHERE review='approved'`
  ).first();
  // Federate the Familia (DESAP personas) registry so /personas reflects ALL cases.
  let f: any = {};
  try { f = await c.env.DB.prepare(`SELECT SUM(CASE WHEN estado NOT IN('localizado','aparecido','hospitalizado','fallecido') THEN 1 ELSE 0 END) AS missing, SUM(CASE WHEN estado IN('localizado','aparecido','hospitalizado','fallecido') THEN 1 ELSE 0 END) AS found, SUM(CASE WHEN estado='hospitalizado' THEN 1 ELSE 0 END) AS hospitalized, COUNT(*) AS total FROM personas`).first() || {}; } catch {}
  return {
    missing: (row?.missing ?? 0) + (f?.missing ?? 0),
    found: (row?.found ?? 0) + (f?.found ?? 0),
    hospitalized: (row?.hospitalized ?? 0) + (f?.hospitalized ?? 0),
    total: (row?.total ?? 0) + (f?.total ?? 0),
  };
}));

// GET /api/persons/cases — case index. PUBLIC (read-only): non-operators see only
// approved cases with PII redacted (no phone / reporter / coordinates) and a
// count of only-approved docket entries. Operators see everything + filters.
persons.get('/cases', async (c) => {
  const op = await isOperator(c);
  const q = (c.req.query('q') ?? '').trim();
  const status = c.req.query('status') ?? '';
  const priority = c.req.query('priority') ?? '';
  const review = c.req.query('review') ?? '';
  const since = Number(c.req.query('since') || 0) || 0;   // created since (epoch ms)
  const sort = c.req.query('sort') ?? 'recent';
  // Fixed 500-per-page docket window; `page` is 1-based and `total`/`pages` are
  // returned so the client can jump anywhere across the whole registry (52k+).
  const pageSize = Math.min(500, Math.max(1, Number(c.req.query('limit') || 500) || 500));
  const page = Math.max(1, Number(c.req.query('page') || 1) || 1);
  const offset = (page - 1) * pageSize;
  const l = `%${q}%`;

  // ---------- filters: native `persons` table ----------
  const pWhere: string[] = []; const pBind: unknown[] = [];
  if (q) { pWhere.push('(p.full_name LIKE ? OR p.last_seen LIKE ? OR p.case_number LIKE ?' + (op ? ' OR p.contact_phone LIKE ?' : '') + ')'); pBind.push(l, l, l); if (op) pBind.push(l); }
  if (status && CASE_STATUSES.includes(status)) { pWhere.push('p.status = ?'); pBind.push(status); }
  if (priority && ['alta', 'media', 'baja'].includes(priority)) { pWhere.push('p.priority = ?'); pBind.push(priority); }
  if (since > 0) { pWhere.push('p.created_ms >= ?'); pBind.push(since); }
  if (!op) { pWhere.push("p.review = 'approved'"); }                                  // public: approved cases only
  else if (review && ['pending', 'approved', 'rejected'].includes(review)) { pWhere.push('p.review = ?'); pBind.push(review); }
  const pW = pWhere.length ? 'WHERE ' + pWhere.join(' AND ') : '';

  // ---------- filters: federated Familia `personas` table ----------
  // Familia priority lives in case_meta (not personas), so a priority filter can't
  // be expressed in SQL here — drop Familia rows when one is active so the paged
  // total stays consistent with what the operator filtered for.
  const includeFam = !(priority && ['alta', 'media', 'baja'].includes(priority));
  const fWhere: string[] = []; const fBind: unknown[] = [];
  if (q) { fWhere.push('(nombre LIKE ? OR ubicacion LIKE ?' + (op ? ' OR contacto LIKE ?' : '') + ')'); fBind.push(l, l); if (op) fBind.push(l); }
  if (status === 'found_safe') fWhere.push("estado = 'localizado'");
  else if (status === 'aparecido') fWhere.push("estado = 'aparecido'");
  else if (status === 'hospitalizado') fWhere.push("estado = 'hospitalizado'");
  else if (status === 'found_deceased') fWhere.push("estado = 'fallecido'");
  else if (status === 'missing') fWhere.push("estado NOT IN ('localizado','aparecido','hospitalizado','fallecido')");
  else if (status === 'unknown') fWhere.push('1=0');                                   // personas have no 'unknown' bucket
  if (since > 0) { fWhere.push('created_at >= ?'); fBind.push(since); }
  const fW = fWhere.length ? 'WHERE ' + fWhere.join(' AND ') : '';

  // /casos is the REAL expediente docket: native `persons` + federated Familia
  // `personas` only. Crowdsourced hospital reports are NOT merged as pseudo-rows;
  // a matched report is surfaced as a `hospital_match` badge + pending docket note
  // on the real expediente (persisted in hospital_matches by the hospital-match
  // cron), and unmatched ones live on /hospitales. This keeps the count honest.

  // ---------- total filtered count (matches the union below exactly) ----------
  const pCnt: any = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM persons p ${pW}`).bind(...pBind).first().catch(() => ({ n: 0 }));
  let fCnt: any = { n: 0 };
  if (includeFam) fCnt = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM personas ${fW}`).bind(...fBind).first().catch(() => ({ n: 0 }));
  const total = (pCnt?.n || 0) + (fCnt?.n || 0);
  const pages = Math.max(1, Math.ceil(total / pageSize));

  // ---------- page window: union of case ids ordered by the chosen key ----------
  // Only `recent`/`opened`/`name` can be ordered in SQL across both tables (the
  // triage score & movement count are computed on read); other sorts fall back to
  // recency here and are refined client-side within the page.
  const SORT: Record<string, { p: string; f: string; dir: 'ASC' | 'DESC'; text?: boolean }> = {
    recent: { p: 'p.updated_ms', f: 'updated_at', dir: 'DESC' },
    opened: { p: 'p.created_ms', f: 'created_at', dir: 'DESC' },
    name: { p: 'p.full_name', f: 'nombre', dir: 'ASC', text: true },
  };
  const sk = SORT[sort] || SORT.recent;
  const orderBy = (sk.text ? `k COLLATE NOCASE ${sk.dir}` : `k ${sk.dir}`) + ', src ASC, id DESC';
  const unionSql =
    `SELECT id, src FROM (` +
    `SELECT p.id AS id, 0 AS src, ${sk.p} AS k FROM persons p ${pW}` +
    (includeFam ? ` UNION ALL SELECT ('fam-'||id) AS id, 1 AS src, ${sk.f} AS k FROM personas ${fW}` : '') +
    `) ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  const { results: pageRows } = await c.env.DB.prepare(unionSql)
    .bind(...pBind, ...(includeFam ? fBind : []), pageSize, offset).all<any>();
  const order = (pageRows ?? []).map((r) => String(r.id));
  const personIds = (pageRows ?? []).filter((r) => r.src === 0).map((r) => String(r.id));
  const famIds = (pageRows ?? []).filter((r) => r.src === 1).map((r) => String(r.id));
  const famKeys = famIds.map((id) => id.slice(FAM.length));

  // D1 caps bound parameters per query (~100) → hydrate the page's rows in chunks.
  const chunk = <T>(a: T[], n: number) => { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
  const dCount = op ? '' : " AND pe.review='approved'";  // public docket count = approved entries only

  // ---------- hydrate native `persons` rows on this page ----------
  let personRows: any[] = [];
  if (personIds.length) {
    const stmts = chunk(personIds, 90).map((ids) => c.env.DB.prepare(
      `SELECT p.id, p.case_number, p.full_name, p.age, p.sex, p.last_seen, p.last_seen_lat, p.last_seen_lon,
              p.status, p.priority, p.incident_type, p.assigned_to, p.review, p.photo_url, p.contact_phone, p.reported_by, p.notes,
              p.event_id, p.created_ms, p.updated_ms,
              e.place_es AS event_place, e.place AS event_place_en, e.mag AS event_mag, e.alert AS event_alert, e.time_ms AS event_time,
              (SELECT COUNT(*) FROM person_events pe WHERE pe.person_id = p.id${dCount}) AS docket_count,
              (SELECT COUNT(*) FROM case_attachments a WHERE a.person_id = p.id) AS evidence_count,
              (SELECT MAX(pe.created_ms) FROM person_events pe WHERE pe.person_id = p.id${dCount}) AS last_activity_ms
       FROM persons p LEFT JOIN events e ON e.id = p.event_id
       WHERE p.id IN (${ids.map(() => '?').join(',')})`
    ).bind(...ids));
    const res = await c.env.DB.batch<any>(stmts);
    personRows = res.flatMap((r) => r.results ?? []);
  }
  const personCases = personRows.map((r) => op ? r : {
    id: r.id, case_number: r.case_number, full_name: r.full_name, age: r.age, sex: r.sex, last_seen: r.last_seen,
    status: r.status, incident_type: r.incident_type, review: r.review, photo_url: r.photo_url, notes: r.notes,
    event_id: r.event_id, created_ms: r.created_ms, updated_ms: r.updated_ms,
    event_place: r.event_place, event_place_en: r.event_place_en, event_mag: r.event_mag, event_alert: r.event_alert, event_time: r.event_time,
    docket_count: r.docket_count, last_activity_ms: r.last_activity_ms,
    // redacted for the public: contact_phone, reported_by, last_seen_lat/lon, assigned_to.
    // priority is NOT redacted — it's the derived triage level (non-PII), re-attached by withScore().
  });

  // ---------- hydrate federated Familia rows on this page ----------
  let famCases: any[] = [];
  if (includeFam && famKeys.length) {
    try {
      const quake = await quakeRef(c.env);
      const famRowsRes = await c.env.DB.batch<any>(chunk(famKeys, 90).map((ks) => c.env.DB.prepare(
        `SELECT id, nombre, edad, ubicacion, descripcion, contacto, foto, foto_r2, estado, created_at, updated_at
         FROM personas WHERE id IN (${ks.map(() => '?').join(',')})`
      ).bind(...ks)));
      const famRows = famRowsRes.flatMap((r) => r.results ?? []);
      // Docket counts + metadata overlay, keyed by the fam-<id> case id.
      const cnt: any = {};
      const cntStmts = chunk(famIds, 90).map((ids) => c.env.DB.prepare(
        `SELECT person_id, COUNT(*) AS c FROM person_events WHERE person_id IN (${ids.map(() => '?').join(',')})${op ? '' : " AND review='approved'"} GROUP BY person_id`
      ).bind(...ids));
      if (cntStmts.length) (await c.env.DB.batch<any>(cntStmts)).forEach((r) => (r.results ?? []).forEach((x: any) => cnt[x.person_id] = x.c));
      const metaMap: any = {};
      const metaStmts = chunk(famIds, 90).map((ids) => c.env.DB.prepare(
        `SELECT person_id, priority, incident_type, assigned_to FROM case_meta WHERE person_id IN (${ids.map(() => '?').join(',')})`
      ).bind(...ids));
      if (metaStmts.length) (await c.env.DB.batch<any>(metaStmts)).forEach((r) => (r.results ?? []).forEach((m: any) => metaMap[m.person_id] = m));
      famCases = famRows.map((r: any) => {
        const id = FAM + r.id; const m = metaMap[id] || {};
        const full: any = {
          id, case_number: famCaseNumber(r.id), full_name: r.nombre, age: r.edad, sex: null,
          last_seen: r.ubicacion, status: estadoToStatus(r.estado), review: 'approved',
          priority: m.priority || 'media', incident_type: m.incident_type || 'persona_desaparecida', assigned_to: m.assigned_to || null,
          photo_url: r.foto_r2 ? `/api/familia/photo/${r.id}` : (r.foto || null), notes: r.descripcion,
          event_id: quake?.id || null, created_ms: r.created_at, updated_ms: r.updated_at,
          event_place: quake?.place_es || quake?.place || null, event_place_en: quake?.place || null, event_mag: quake?.mag || null, event_alert: quake?.alert || null, event_time: quake?.time_ms || null,
          docket_count: cnt[id] || 0, evidence_count: 0, last_activity_ms: null, source: 'familia',
          contact_phone: op ? (r.contacto || null) : undefined, reported_by: null,
        };
        if (op) return full;
        const { contact_phone, priority, assigned_to, ...pub } = full; return pub;
      });
    } catch (e: any) { console.error('[cases] familia bridge failed:', e?.message ?? e); }
  }

  // ---------- cross-match badge: read persisted hospital_matches for this page ----------
  // The match is computed durably by the hospital-match backfill (cron-drained) and
  // stored in hospital_matches, so here we only join the page's case ids — cheap,
  // and consistent with the pending docket note shown on the case timeline.
  if (personCases.length || famCases.length) {
    try {
      const pageIds = [...personCases, ...famCases].map((x) => String(x.id));
      const found: Record<string, string> = {};
      for (let i = 0; i < pageIds.length; i += 90) {
        const slice = pageIds.slice(i, i + 90);
        const { results: hm } = await c.env.DB.prepare(
          `SELECT person_id, hospital_name FROM hospital_matches WHERE person_id IN (${slice.map(() => '?').join(',')})`,
        ).bind(...slice).all<any>();
        (hm ?? []).forEach((r: any) => { if (!found[r.person_id]) found[r.person_id] = r.hospital_name; });
      }
      for (const x of [...personCases, ...famCases]) { if (found[x.id]) x.hospital_match = found[x.id]; }
    } catch (e: any) { console.error('[cases] hospital match badge failed:', e?.message ?? e); }
  }

  // ---------- stitch back into the union order + live triage score ----------
  const nowMs = Date.now();
  const byId: any = {};
  [...personCases, ...famCases].forEach((x) => byId[x.id] = x);
  const cases = order.map((id) => byId[id]).filter(Boolean).map((x) => withScore(x, nowMs));

  // ---------- global summary (whole registry, not just this page) ----------
  const sum: any = await c.env.DB.prepare(
    `SELECT
       SUM(CASE WHEN status='missing' THEN 1 ELSE 0 END) AS missing,
       SUM(CASE WHEN status='found_safe' THEN 1 ELSE 0 END) AS found_safe,
       SUM(CASE WHEN status='found_deceased' THEN 1 ELSE 0 END) AS deceased,
       SUM(CASE WHEN review='pending' THEN 1 ELSE 0 END) AS pending,
       COUNT(*) AS total
     FROM persons${op ? '' : " WHERE review='approved'"}`
  ).first();
  let fsum: any = {};
  try { fsum = await c.env.DB.prepare(`SELECT SUM(CASE WHEN estado NOT IN('localizado','aparecido','hospitalizado','fallecido') THEN 1 ELSE 0 END) AS missing, SUM(CASE WHEN estado IN('localizado','aparecido','hospitalizado') THEN 1 ELSE 0 END) AS found_safe, SUM(CASE WHEN estado='fallecido' THEN 1 ELSE 0 END) AS deceased, COUNT(*) AS total FROM personas`).first() || {}; } catch {}
  const summary = {
    missing: (sum?.missing || 0) + (fsum?.missing || 0),
    found_safe: (sum?.found_safe || 0) + (fsum?.found_safe || 0),
    deceased: (sum?.deceased || 0) + (fsum?.deceased || 0),
    pending: sum?.pending || 0,
    total: (sum?.total || 0) + (fsum?.total || 0),
  };
  c.header('Cache-Control', 'no-store'); c.header('Vary', 'Cookie');
  return c.json({ cases, summary, operator: op, page, pageSize, total, pages });
});

// GET /api/persons/docket/queue — pending citizen-submitted updates awaiting
// approval (operator-gated in index.ts).
persons.get('/docket/queue', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT pe.id, pe.person_id, pe.kind, pe.status_from, pe.status_to, pe.detail, pe.location,
            pe.source, pe.actor, pe.created_ms, p.full_name
     FROM person_events pe LEFT JOIN persons p ON p.id = pe.person_id
     WHERE pe.review='pending' ORDER BY pe.created_ms ASC LIMIT 300`
  ).all<any>();
  const updates = results ?? [];
  // Resolve names for Familia-origin pending updates (no row in persons).
  for (const u of updates) {
    if (!u.full_name && isFam(u.person_id)) {
      const r: any = await c.env.DB.prepare(`SELECT nombre FROM personas WHERE id = ?`).bind(famKey(u.person_id)).first().catch(() => null);
      u.full_name = r?.nombre || u.person_id;
    }
  }
  c.header('Cache-Control', 'no-store'); c.header('Vary', 'Cookie');
  return c.json({ updates });
});

// POST /api/persons/docket/:eid/approve|reject — moderate a pending update
// (operator-gated in index.ts). Approving a status-change update applies it.
persons.post('/docket/:eid/approve', async (c) => {
  const eid = c.req.param('eid');
  const ev = await c.env.DB.prepare(`SELECT * FROM person_events WHERE id = ?`).bind(eid).first<any>();
  if (!ev) return c.json({ error: 'not_found' }, 404);
  await c.env.DB.prepare(`UPDATE person_events SET review='approved' WHERE id = ?`).bind(eid).run();
  // If the update proposed a status change, apply it to the person now (native
  // persons row, or the Familia personas record for bridged cases).
  if (ev.status_to && ['missing', 'found_safe', 'found_deceased', 'unknown'].includes(ev.status_to)) {
    if (isFam(ev.person_id)) await c.env.DB.prepare(`UPDATE personas SET estado = ?, updated_at = ? WHERE id = ?`).bind(statusToEstado(ev.status_to), Date.now(), famKey(ev.person_id)).run();
    else await c.env.DB.prepare(`UPDATE persons SET status = ?, updated_ms = ? WHERE id = ?`).bind(ev.status_to, Date.now(), ev.person_id).run();
  } else if (!isFam(ev.person_id)) {
    await c.env.DB.prepare(`UPDATE persons SET updated_ms = ? WHERE id = ?`).bind(Date.now(), ev.person_id).run();
  }
  // Autonomous auto-update: a newly-approved status change / new info re-scores the case.
  await recomputeCaseScore(c.env, ev.person_id).catch(() => {});
  await audit(c, 'persons.docket_approve', { eid, person_id: ev.person_id });
  return c.json({ ok: true });
});
persons.post('/docket/:eid/reject', async (c) => {
  const r = await c.env.DB.prepare(`UPDATE person_events SET review='rejected' WHERE id = ?`).bind(c.req.param('eid')).run();
  await audit(c, 'persons.docket_reject', { eid: c.req.param('eid') });
  return c.json({ ok: true, changed: r.meta.changes });
});

// GET /api/persons/:id/docket — full case file: person record, originating sismo,
// chronological tracing timeline. PUBLIC: non-operators only see approved cases,
// approved timeline entries, with PII (phone/reporter/coords/operator identity)
// redacted. Operators see everything, including pending entries.
persons.get('/:id/docket', async (c) => {
  const op = await isOperator(c);
  const id = c.req.param('id');
  // Hospital intake → full case profile (same shell as a person case, empty docket).
  if (isHosp(id)) {
    const r: any = await c.env.DB.prepare(
      `SELECT * FROM rav_reports WHERE id = ? AND kind='hospital' AND coalesce(hidden,0)=0`,
    ).bind(hospKey(id)).first();
    if (!r) return c.notFound();
    const person = hospPerson(r, op);
    const scored = withScore({ ...person, docket_count: 0, last_activity_ms: person.created_ms });
    c.header('Cache-Control', 'no-store');
    return c.json({ person: scored, event: null, docket: [], operator: op, hospital: true });
  }
  let person: any; let event: any;
  if (isFam(id)) {
    person = await famPerson(c.env, id, op);
    if (!person) return c.notFound();
    event = await quakeRef(c.env);
  } else {
    person = await c.env.DB.prepare(`SELECT * FROM persons WHERE id = ?`).bind(id).first();
    if (!person) return c.notFound();
    if (!op && person.review !== 'approved') return c.notFound();   // public: approved cases only
    event = person.event_id
      ? await c.env.DB.prepare(`SELECT id, mag, place, place_es, time_ms, depth_km, alert, lat, lon, url FROM events WHERE id = ?`).bind(person.event_id).first()
      : null;
  }
  const { results: rows } = await c.env.DB.prepare(
    `SELECT id, kind, status_from, status_to, detail, location, lat, lon, source, actor, review, created_ms
     FROM person_events WHERE person_id = ?${op ? '' : " AND review='approved'"} ORDER BY created_ms ASC`
  ).bind(id).all<any>();
  const docket = (rows ?? []).map((d) => op ? d : {
    id: d.id, kind: d.kind, status_from: d.status_from, status_to: d.status_to,
    detail: d.detail, location: d.location, source: d.source, created_ms: d.created_ms,
    // redacted for the public: actor (operator identity), lat/lon
  });
  // Familia person objects are already shaped per role by famPerson(); native
  // ones get redacted here for the public.
  const pubPerson = (isFam(id) || op) ? person : {
    id: person.id, case_number: person.case_number, full_name: person.full_name, age: person.age, sex: person.sex,
    last_seen: person.last_seen, status: person.status, review: person.review,
    priority: person.priority, incident_type: person.incident_type,
    photo_url: person.photo_url, notes: person.notes, event_id: person.event_id,
    created_ms: person.created_ms, updated_ms: person.updated_ms,
    // redacted: contact_phone, reported_by, last_seen_lat/lon, assigned_to
  };
  // Live FEMA-triage score for the case file (uses the docket for activity signals).
  const lastActivityMs = docket.length ? Math.max(...docket.map((d: any) => d.created_ms || 0)) : null;
  const scored = withScore({
    ...pubPerson, event_mag: event?.mag ?? null, event_alert: event?.alert ?? null,
    docket_count: docket.length, last_activity_ms: lastActivityMs,
  });
  c.header('Cache-Control', 'no-store'); c.header('Vary', 'Cookie');
  return c.json({ person: scored, event, docket, operator: op });
});

// POST /api/persons/:id/docket — submit a tracing update (LOGIN REQUIRED, any
// role — gated in index.ts). Operator/admin updates are applied immediately
// (review='approved'); citizen updates land as 'pending' for operator approval
// and do NOT change the person's status until approved.
persons.post('/:id/docket', async (c) => {
  const id = c.req.param('id');
  const op = await isOperator(c);
  const b = await c.req.json().catch(() => ({} as any));
  const fam = isFam(id);
  let curStatus: string;
  if (fam) {
    const row = await c.env.DB.prepare(`SELECT estado FROM personas WHERE id = ?`).bind(famKey(id)).first<any>();
    if (!row) return c.json({ error: 'not_found' }, 404);
    curStatus = estadoToStatus(row.estado);
  } else {
    const exists = await c.env.DB.prepare(`SELECT id, status FROM persons WHERE id = ?`).bind(id).first<any>();
    if (!exists) return c.json({ error: 'not_found' }, 404);
    curStatus = exists.status;
  }
  const allowed = ['note', 'sighting', 'contact', 'shelter', 'hospital', 'morgue', 'review', 'status_change'];
  const kind = allowed.includes(b.kind) ? b.kind : 'note';
  const lat = b.lat == null ? null : Number(b.lat);
  const lon = b.lon == null ? null : Number(b.lon);
  if ((lat != null || lon != null) && !validLatLon(lat, lon)) return c.json({ error: 'bad_lat_lon' }, 400);
  const wantsStatus = b.status && CASE_STATUSES.includes(b.status) && b.status !== curStatus;
  let status_from: string | null = null; let status_to: string | null = null;
  if (wantsStatus) { status_from = curStatus; status_to = b.status; }
  // Operators: apply immediately + approved. Citizens: pending, status untouched.
  if (op) {
    if (status_to) {
      if (fam) await c.env.DB.prepare(`UPDATE personas SET estado = ?, updated_at = ? WHERE id = ?`).bind(statusToEstado(status_to), Date.now(), famKey(id)).run();
      else await c.env.DB.prepare(`UPDATE persons SET status = ?, updated_ms = ? WHERE id = ?`).bind(status_to, Date.now(), id).run();
    } else if (!fam) {
      await c.env.DB.prepare(`UPDATE persons SET updated_ms = ? WHERE id = ?`).bind(Date.now(), id).run();
    }
  } else {
    const limited = await rateLimit(c.env, c, 'docket_submit', 10, 300);
    if (limited) return limited;
  }
  await logDocket(c, id, status_to ? 'status_change' : kind, {
    status_from, status_to,
    detail: b.detail ? String(b.detail).slice(0, 2000) : null,
    location: b.location ? String(b.location).slice(0, 200) : null,
    lat, lon, source: op ? (b.source ? String(b.source).slice(0, 30) : 'operator') : 'citizen',
    review: op ? 'approved' : 'pending',
  });
  // Autonomous auto-update: operator updates are live immediately → re-score now.
  // Citizen updates are pending (no status/score change until approved).
  if (op) await recomputeCaseScore(c.env, id).catch(() => {});
  await audit(c, 'persons.docket_add', { id, kind: status_to ? 'status_change' : kind, review: op ? 'approved' : 'pending' });
  return c.json({ ok: true, review: op ? 'approved' : 'pending' }, 201);
});

// ===================================================================
//  COURT-DOCKET CASE DETAIL (operator-only; gated in index.ts)
// ===================================================================

// PATCH /api/persons/:id/case — update case metadata (priority, incident, assignee).
persons.patch('/:id/case', async (c) => {
  const id = c.req.param('id'); const b = await c.req.json().catch(() => ({} as any));
  const priority = ['alta', 'media', 'baja'].includes(b.priority) ? b.priority : null;
  const incident_type = typeof b.incident_type === 'string' ? b.incident_type.slice(0, 60) : null;
  const assigned_to = typeof b.assigned_to === 'string' ? b.assigned_to.slice(0, 120) : null;
  if (isFam(id)) {
    // Familia cases have no persons row → store meta in the overlay table.
    await c.env.DB.prepare(
      `INSERT INTO case_meta (person_id, priority, incident_type, assigned_to, updated_ms) VALUES (?,?,?,?,?)
       ON CONFLICT(person_id) DO UPDATE SET
         priority=COALESCE(excluded.priority, case_meta.priority),
         incident_type=COALESCE(excluded.incident_type, case_meta.incident_type),
         assigned_to=COALESCE(excluded.assigned_to, case_meta.assigned_to),
         updated_ms=excluded.updated_ms`
    ).bind(id, priority, incident_type, assigned_to, Date.now()).run();
    await audit(c, 'persons.case_update', { id, priority, incident_type, assigned_to });
    return c.json({ ok: true });
  }
  const sets: string[] = []; const binds: unknown[] = [];
  if (priority) { sets.push('priority = ?'); binds.push(priority); }
  if (incident_type != null) { sets.push('incident_type = ?'); binds.push(incident_type); }
  if (assigned_to != null) { sets.push('assigned_to = ?'); binds.push(assigned_to); }
  if (!sets.length) return c.json({ error: 'nothing_to_update' }, 400);
  sets.push('updated_ms = ?'); binds.push(Date.now());
  const r = await c.env.DB.prepare(`UPDATE persons SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id).run();
  await audit(c, 'persons.case_update', { id, priority, incident_type, assigned_to });
  return c.json({ ok: true, changed: r.meta.changes });
});

// ---------- Evidence / attachments ----------
const ATT_KINDS = ['photo', 'video', 'document', 'voice', 'gps', 'report'];
persons.get('/:id/attachments', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, kind, filename, content_type, size, description, category, source, verification, uploaded_by, lat, lon, created_ms
     FROM case_attachments WHERE person_id = ? ORDER BY created_ms DESC`
  ).bind(c.req.param('id')).all();
  c.header('Cache-Control', 'no-store');
  return c.json({ attachments: results ?? [] });
});
persons.post('/:id/attachments', async (c) => {
  const id = c.req.param('id');
  if (!(await caseExists(c.env, id))) return c.json({ error: 'not_found' }, 404);
  if (!(c.req.header('content-type') || '').includes('multipart/form-data')) return c.json({ error: 'multipart_required' }, 415);
  const f = await c.req.formData();
  const meta: any = {};
  for (const [k, v] of f.entries()) if (typeof v === 'string') meta[k] = v;
  const file = f.get('file') as any;
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') return c.json({ error: 'no_file' }, 400);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length) return c.json({ error: 'no_file' }, 400);
  if (bytes.length > 26_214_400) return c.json({ error: 'file_too_large', maxBytes: 26_214_400 }, 413);
  const filename = file.name || null; const fileType = file.type || 'application/octet-stream';
  const kind = ATT_KINDS.includes(meta.kind) ? meta.kind : 'document';
  const attId = uid('att');
  const ext = filename && filename.includes('.') ? filename.split('.').pop().slice(0, 8) : 'bin';
  const key = `cases/${id}/${attId}.${ext}`;
  await c.env.PERSON_PHOTOS.put(key, bytes, { httpMetadata: { contentType: fileType } });
  const me = await getUserFromRequest(c.env, c).catch(() => null);
  await c.env.DB.prepare(
    `INSERT INTO case_attachments (id, person_id, kind, r2_key, filename, content_type, size, description, category, source, verification, uploaded_by, lat, lon, created_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    attId, id, kind, key, filename ? String(filename).slice(0, 200) : null, fileType, bytes.length,
    meta.description ? String(meta.description).slice(0, 1000) : null,
    meta.category ? String(meta.category).slice(0, 40) : null,
    meta.source ? String(meta.source).slice(0, 40) : 'operator',
    'unverified', me?.email ?? me?.id ?? null,
    meta.lat ? Number(meta.lat) : null, meta.lon ? Number(meta.lon) : null, Date.now()
  ).run();
  await c.env.DB.prepare(`UPDATE persons SET updated_ms = ? WHERE id = ?`).bind(Date.now(), id).run();
  await audit(c, 'persons.attachment_add', { id, attId, kind });
  return c.json({ ok: true, id: attId }, 201);
});
persons.get('/:id/attachments/:aid/file', async (c) => {
  const row: any = await c.env.DB.prepare(`SELECT r2_key, content_type, filename FROM case_attachments WHERE id = ? AND person_id = ?`).bind(c.req.param('aid'), c.req.param('id')).first();
  if (!row) return c.notFound();
  const obj = await c.env.PERSON_PHOTOS.get(row.r2_key);
  if (!obj) return c.notFound();
  return new Response(obj.body, { headers: { 'Content-Type': row.content_type || 'application/octet-stream', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `inline; filename="${String(row.filename || 'archivo').replace(/"/g, '')}"` } });
});

// ---- PUBLIC citizen contributions ("aportes": documents/pictures/files) ----
// Separate from the confidential operator /attachments surface above: aportes are
// citizen uploads that land review='pending' and only become PUBLIC after an
// operator approves. The public never sees operator evidence (source='operator').
const APORTE_DOC_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/plain'];

// GET /api/persons/:id/aportes — public: approved citizen contributions only.
// Operators additionally see pending ones (to moderate).
persons.get('/:id/aportes', async (c) => {
  const op = !!(await getUserFromRequest(c.env, c).catch(() => null))?.role?.match(/operator|admin/);
  const where = op ? `source='citizen'` : `source='citizen' AND review='approved'`;
  const { results } = await c.env.DB.prepare(
    `SELECT id, kind, filename, content_type, size, description, category, review, created_ms
     FROM case_attachments WHERE person_id = ? AND ${where} ORDER BY created_ms DESC`,
  ).bind(c.req.param('id')).all();
  return c.json({ ok: true, operator: op, items: results ?? [] }, 200, { 'Cache-Control': 'no-store' });
});

// POST /api/persons/:id/aportes — citizen uploads a file (lands pending). Public, rate-limited.
persons.post('/:id/aportes', async (c) => {
  const id = c.req.param('id');
  if (!(c.req.header('content-type') || '').includes('multipart/form-data')) return c.json({ error: 'multipart_required' }, 415);
  const limited = await rateLimit(c.env, c, 'person_aporte', 6, 600);
  if (limited) return limited;
  const f = await c.req.formData();
  const meta: any = {}; for (const [k, v] of f.entries()) if (typeof v === 'string') meta[k] = v;
  const file = f.get('file') as any;
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') return c.json({ error: 'no_file' }, 400);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length) return c.json({ error: 'no_file' }, 400);
  if (bytes.length > 8_000_000) return c.json({ error: 'file_too_large', maxBytes: 8_000_000 }, 413);
  const ctype = file.type || 'application/octet-stream';
  const isImg = ['image/jpeg', 'image/png', 'image/webp'].includes(ctype);
  if (isImg && !isImageBytes(bytes, ctype)) return c.json({ error: 'unsupported_image_type' }, 415);
  if (!isImg && !APORTE_DOC_TYPES.includes(ctype)) return c.json({ error: 'unsupported_file_type', allowed: APORTE_DOC_TYPES }, 415);
  const attId = uid('apt');
  const key = `aportes/${id}/${attId}`;
  await c.env.PERSON_PHOTOS.put(key, bytes, { httpMetadata: { contentType: ctype } });
  await c.env.DB.prepare(
    `INSERT INTO case_attachments (id, person_id, kind, r2_key, filename, content_type, size, description, category, source, verification, review, uploaded_by, created_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(attId, id, isImg ? 'photo' : 'document', key, file.name ? String(file.name).slice(0, 200) : null, ctype, bytes.length,
    meta.description ? String(meta.description).slice(0, 500) : null, meta.category ? String(meta.category).slice(0, 40) : null,
    'citizen', 'unverified', 'pending', null, Date.now()).run();
  await audit(c, 'persons.aporte_add', { id, attId, review: 'pending' });
  return c.json({ ok: true, id: attId, review: 'pending', message: 'Recibido. Aparecerá tras la revisión de un moderador.' }, 201);
});

// GET /api/persons/:id/aportes/:aid/file — serve an approved citizen file (operator: any).
persons.get('/:id/aportes/:aid/file', async (c) => {
  const op = !!(await getUserFromRequest(c.env, c).catch(() => null))?.role?.match(/operator|admin/);
  const row: any = await c.env.DB.prepare(`SELECT r2_key, content_type, filename, review, source FROM case_attachments WHERE id = ? AND person_id = ?`).bind(c.req.param('aid'), c.req.param('id')).first();
  if (!row || row.source !== 'citizen' || (!op && row.review !== 'approved')) return c.notFound();
  const obj = await c.env.PERSON_PHOTOS.get(row.r2_key);
  if (!obj) return c.notFound();
  return new Response(obj.body, { headers: { 'Content-Type': row.content_type || 'application/octet-stream', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `inline; filename="${String(row.filename || 'archivo').replace(/"/g, '')}"` } });
});

// POST /api/persons/aportes/:aid/approve|reject — operator moderation (gated via /approve|/reject).
persons.post('/aportes/:aid/approve', async (c) => {
  await c.env.DB.prepare(`UPDATE case_attachments SET review='approved' WHERE id = ? AND source='citizen'`).bind(c.req.param('aid')).run();
  await audit(c, 'persons.aporte.approve', { aid: c.req.param('aid') });
  return c.json({ ok: true });
});
persons.post('/aportes/:aid/reject', async (c) => {
  await c.env.DB.prepare(`UPDATE case_attachments SET review='rejected' WHERE id = ? AND source='citizen'`).bind(c.req.param('aid')).run();
  return c.json({ ok: true });
});
persons.patch('/:id/attachments/:aid', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  if (!['unverified', 'verified', 'disputed'].includes(b.verification)) return c.json({ error: 'bad_verification' }, 400);
  const r = await c.env.DB.prepare(`UPDATE case_attachments SET verification = ? WHERE id = ? AND person_id = ?`).bind(b.verification, c.req.param('aid'), c.req.param('id')).run();
  await audit(c, 'persons.attachment_verify', { id: c.req.param('id'), aid: c.req.param('aid'), verification: b.verification });
  return c.json({ ok: true, changed: r.meta.changes });
});
persons.delete('/:id/attachments/:aid', async (c) => {
  const row: any = await c.env.DB.prepare(`SELECT r2_key FROM case_attachments WHERE id = ? AND person_id = ?`).bind(c.req.param('aid'), c.req.param('id')).first();
  if (row?.r2_key) await c.env.PERSON_PHOTOS.delete(row.r2_key).catch(() => {});
  const r = await c.env.DB.prepare(`DELETE FROM case_attachments WHERE id = ? AND person_id = ?`).bind(c.req.param('aid'), c.req.param('id')).run();
  await audit(c, 'persons.attachment_delete', { id: c.req.param('id'), aid: c.req.param('aid') });
  return c.json({ ok: true, changed: r.meta.changes });
});

// ---------- Tasks ----------
persons.get('/:id/tasks', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM case_tasks WHERE person_id = ? ORDER BY (status='done'), created_ms DESC`).bind(c.req.param('id')).all();
  return c.json({ tasks: results ?? [] });
});
persons.post('/:id/tasks', async (c) => {
  const id = c.req.param('id'); const b = await c.req.json().catch(() => ({} as any));
  if (!b.title) return c.json({ error: 'title_required' }, 400);
  const me = await getUserFromRequest(c.env, c).catch(() => null); const now = Date.now(); const tid = uid('tsk');
  await c.env.DB.prepare(
    `INSERT INTO case_tasks (id, person_id, title, detail, assignee, status, priority, due_ms, created_by, created_ms, updated_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(tid, id, String(b.title).slice(0, 200), b.detail ? String(b.detail).slice(0, 1000) : null, b.assignee ? String(b.assignee).slice(0, 120) : null, 'open', ['alta', 'media', 'baja'].includes(b.priority) ? b.priority : 'media', b.due_ms ? Number(b.due_ms) : null, me?.email ?? me?.id ?? null, now, now).run();
  await audit(c, 'persons.task_add', { id, tid });
  return c.json({ ok: true, id: tid }, 201);
});
persons.patch('/:id/tasks/:tid', async (c) => {
  const b = await c.req.json().catch(() => ({} as any)); const sets: string[] = []; const binds: unknown[] = [];
  if (b.status && ['open', 'in_progress', 'done'].includes(b.status)) { sets.push('status = ?'); binds.push(b.status); }
  if (typeof b.assignee === 'string') { sets.push('assignee = ?'); binds.push(b.assignee.slice(0, 120)); }
  if (b.priority && ['alta', 'media', 'baja'].includes(b.priority)) { sets.push('priority = ?'); binds.push(b.priority); }
  if (!sets.length) return c.json({ error: 'nothing_to_update' }, 400);
  sets.push('updated_ms = ?'); binds.push(Date.now());
  const r = await c.env.DB.prepare(`UPDATE case_tasks SET ${sets.join(', ')} WHERE id = ? AND person_id = ?`).bind(...binds, c.req.param('tid'), c.req.param('id')).run();
  return c.json({ ok: true, changed: r.meta.changes });
});

// ---------- Messages (internal coordination) ----------
persons.get('/:id/messages', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT id, author, body, created_ms FROM case_messages WHERE person_id = ? ORDER BY created_ms ASC LIMIT 500`).bind(c.req.param('id')).all();
  return c.json({ messages: results ?? [] });
});
persons.post('/:id/messages', async (c) => {
  const id = c.req.param('id'); const b = await c.req.json().catch(() => ({} as any));
  if (!b.body) return c.json({ error: 'body_required' }, 400);
  const me = await getUserFromRequest(c.env, c).catch(() => null);
  await c.env.DB.prepare(`INSERT INTO case_messages (id, person_id, author, body, created_ms) VALUES (?,?,?,?,?)`).bind(uid('msg'), id, me?.name ?? me?.email ?? 'operador', String(b.body).slice(0, 2000), Date.now()).run();
  return c.json({ ok: true }, 201);
});

// ---------- Victims / contacts ----------
persons.get('/:id/victims', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM case_victims WHERE person_id = ? ORDER BY created_ms ASC`).bind(c.req.param('id')).all();
  return c.json({ victims: results ?? [] });
});
persons.post('/:id/victims', async (c) => {
  const id = c.req.param('id'); const b = await c.req.json().catch(() => ({} as any));
  if (!b.name) return c.json({ error: 'name_required' }, 400);
  await c.env.DB.prepare(`INSERT INTO case_victims (id, person_id, name, role, phone, relation, notes, created_ms) VALUES (?,?,?,?,?,?,?,?)`).bind(
    uid('vic'), id, String(b.name).slice(0, 120), ['victima', 'contacto', 'testigo', 'familiar'].includes(b.role) ? b.role : 'contacto',
    b.phone ? String(b.phone).slice(0, 40) : null, b.relation ? String(b.relation).slice(0, 80) : null, b.notes ? String(b.notes).slice(0, 500) : null, Date.now()).run();
  await audit(c, 'persons.victim_add', { id });
  return c.json({ ok: true }, 201);
});
persons.delete('/:id/victims/:vid', async (c) => {
  const r = await c.env.DB.prepare(`DELETE FROM case_victims WHERE id = ? AND person_id = ?`).bind(c.req.param('vid'), c.req.param('id')).run();
  return c.json({ ok: true, changed: r.meta.changes });
});

// ---------- Per-case audit log ----------
persons.get('/:id/audit', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT id, actor, action, detail, created_ms FROM audit WHERE detail LIKE ? ORDER BY created_ms DESC LIMIT 200`).bind(`%${c.req.param('id')}%`).all();
  c.header('Cache-Control', 'no-store');
  return c.json({ audit: results ?? [] });
});

// GET /api/persons/search?q= — name lookup (approved only, redacted).
persons.get('/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  if (q.length < 2) return c.json({ persons: [] });
  const like = `%${q}%`;
  const { results } = await c.env.DB.prepare(
    `SELECT id, full_name, age, sex, last_seen, status, photo_url, updated_ms
     FROM persons WHERE review='approved' AND full_name LIKE ?
     ORDER BY updated_ms DESC LIMIT 60`
  ).bind(like).all<any>();
  // Federate the Familia registry so a search on /personas covers ALL cases.
  let fam: any[] = [];
  try {
    const { results: fr } = await c.env.DB.prepare(
      `SELECT id, nombre, edad, ubicacion, estado, foto, foto_r2, updated_at FROM personas WHERE nombre LIKE ? ORDER BY updated_at DESC LIMIT 60`
    ).bind(like).all<any>();
    fam = (fr || []).map((r: any) => ({
      id: FAM + r.id, full_name: r.nombre, age: r.edad, sex: null,
      last_seen: r.ubicacion, status: estadoToStatus(r.estado),
      photo_url: r.foto_r2 ? `/api/familia/photo/${r.id}` : (r.foto || null),
      updated_ms: r.updated_at, source: 'familia',
    }));
  } catch (e: any) { console.error('[search] familia', e?.message ?? e); }
  const persons = [...(results ?? []), ...fam].slice(0, 100);
  return c.json({ persons });
});

// GET /api/persons/queue — pending submissions (operator-gated in index.ts).
persons.get('/queue', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM persons WHERE review='pending' ORDER BY created_ms ASC LIMIT 300`
  ).all();
  c.header('Cache-Control', 'no-store'); c.header('Vary', 'Cookie');
  return c.json({ persons: results ?? [] });
});

// GET /api/persons?status=missing — approved registry.
persons.get('/', async (c) => edgeCached(c, 30, async () => {
  const status = c.req.query('status');
  const q = status
    ? c.env.DB.prepare(`SELECT id,full_name,age,sex,last_seen,status,photo_url,created_ms,updated_ms FROM persons WHERE review='approved' AND status = ? ORDER BY updated_ms DESC LIMIT 500`).bind(status)
    : c.env.DB.prepare(`SELECT id,full_name,age,sex,last_seen,status,photo_url,created_ms,updated_ms FROM persons WHERE review='approved' ORDER BY updated_ms DESC LIMIT 500`);
  const { results } = await q.all();
  return { persons: results ?? [] };
}));

// POST /api/persons — PUBLIC missing-person report → moderation queue (pending).
persons.post('/', async (c) => {
  const limited = await rateLimit(c.env, c, 'persons_post', 10, 300);
  if (limited) return limited;
  const b = await c.req.json().catch(() => null);
  if (!b?.full_name) return c.json({ error: 'nombre requerido' }, 400);
  // Link-spam gate (see lib/security): names/notes/contact never carry websites.
  if (nameHasSpam(b.full_name) || textHasLink(b.notes) || textHasLink(b.contact_phone)) {
    await audit(c, 'spam_blocked', { ip: requestIp(c), src: 'persons' }).catch(() => {});
    return c.json({ error: 'spam_blocked', hint: 'No incluyas enlaces ni sitios web en el reporte.' }, 400);
  }
  if (b.status && !['missing', 'found_safe', 'found_deceased', 'unknown'].includes(b.status)) return c.json({ error: 'bad_status' }, 400);
  const lat = b.last_seen_lat == null ? null : Number(b.last_seen_lat);
  const lon = b.last_seen_lon == null ? null : Number(b.last_seen_lon);
  if ((lat != null || lon != null) && !validLatLon(lat, lon)) return c.json({ error: 'bad_lat_lon' }, 400);
  const now = Date.now();
  const id = uid('per');
  await c.env.DB.prepare(
    `INSERT INTO persons (id, full_name, age, sex, last_seen, last_seen_lat, last_seen_lon, event_id, status, contact_phone, notes, photo_url, reported_by, review, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, String(b.full_name).slice(0, 120), b.age ?? null, b.sex ?? null, b.last_seen ? String(b.last_seen).slice(0, 500) : null,
    blurCoord(lat, 2), blurCoord(lon, 2), b.event_id ?? null,
    b.status ?? 'missing', b.contact_phone ? String(b.contact_phone).slice(0, 40) : null, b.notes ? String(b.notes).slice(0, 2000) : null,
    b.photo_url ? String(b.photo_url).slice(0, 500) : null, b.reported_by ? String(b.reported_by).slice(0, 120) : null, 'pending', now, now
  ).run();
  await logDocket(c, id, 'report_filed', {
    status_to: b.status ?? 'missing',
    location: b.last_seen ? String(b.last_seen).slice(0, 200) : null,
    detail: 'Reporte ciudadano recibido — en revisión',
    source: 'citizen',
  });
  return c.json({ ok: true, id, review: 'pending', message: 'Recibido. Aparecerá tras revisión.' }, 201);
});

// PATCH /api/persons/:id — PUBLIC status update (e.g. found_safe). Low-risk.
persons.patch('/:id', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!b.status) return c.json({ error: 'status_required' }, 400);
  if (!CASE_STATUSES.includes(b.status)) return c.json({ error: 'bad_status' }, 400);
  const id = c.req.param('id');
  // Familia-bridged case: write status to the DESAP personas record.
  if (isFam(id)) {
    const row = await c.env.DB.prepare(`SELECT estado FROM personas WHERE id = ?`).bind(famKey(id)).first<any>();
    if (!row) return c.json({ error: 'not_found' }, 404);
    const prevStatus = estadoToStatus(row.estado);
    await c.env.DB.prepare(`UPDATE personas SET estado = ?, updated_at = ? WHERE id = ?`).bind(statusToEstado(b.status), Date.now(), famKey(id)).run();
    if (prevStatus !== b.status) await logDocket(c, id, 'status_change', { status_from: prevStatus, status_to: b.status, source: 'operator' });
    await audit(c, 'persons.status_update', { id, status: b.status });
    return c.json({ ok: true, changed: 1 });
  }
  const prev = await c.env.DB.prepare(`SELECT status FROM persons WHERE id = ?`).bind(id).first<any>();
  const r = await c.env.DB.prepare(
    `UPDATE persons SET status = ?, notes = COALESCE(?, notes), updated_ms = ? WHERE id = ? AND review='approved'`
  ).bind(b.status, b.notes ?? null, Date.now(), id).run();
  if (r.meta.changes && prev && prev.status !== b.status) {
    await logDocket(c, id, 'status_change', { status_from: prev.status, status_to: b.status, detail: b.notes ? String(b.notes).slice(0, 2000) : null, source: 'operator' });
  }
  await audit(c, 'persons.status_update', { id, status: b.status });
  return c.json({ ok: true, changed: r.meta.changes });
});

// POST /api/persons/:id/update — PUBLIC status update proposal (no login needed).
// Anyone can report that a person APARECIÓ (con vida), fue HOSPITALIZADO (con el
// hospital), está FALLECIDA, o aportar un detalle. Lands as a PENDING docket entry
// (review='pending') for operator approval — approving applies the status to the
// case (see POST /docket/:eid/approve). Rate-limited + spam-gated; never applies
// directly. Operators apply directly via PATCH /:id or POST /:id/docket.
// NOTE: this path is intentionally OUTSIDE the operator gate in index.ts (it is
// not /queue, not PATCH, not *.approve/reject/localizar).
persons.post('/:id/update', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => ({} as any));
  let curStatus: string;
  if (isFam(id)) {
    const row = await c.env.DB.prepare(`SELECT estado FROM personas WHERE id = ? AND moderation='approved'`).bind(famKey(id)).first<any>();
    if (!row) return c.json({ error: 'not_found' }, 404);
    curStatus = estadoToStatus(row.estado);
  } else {
    const row = await c.env.DB.prepare(`SELECT status FROM persons WHERE id = ? AND review='approved'`).bind(id).first<any>();
    if (!row) return c.json({ error: 'not_found' }, 404);
    curStatus = row.status;
  }
  const limited = await rateLimit(c.env, c, 'person_update', 8, 600);
  if (limited) return limited;

  const wantsStatus = b.status && CASE_STATUSES.includes(b.status) && b.status !== curStatus;
  const hospital = b.hospital ? String(b.hospital).slice(0, 160) : '';
  const detail = [hospital ? `Hospital: ${hospital}` : '', b.detail ? String(b.detail) : '']
    .filter(Boolean).join(' — ').slice(0, 2000);
  if (detail && (textHasLink(detail) || nameHasSpam(detail))) return c.json({ error: 'spam_blocked' }, 400);
  if (!wantsStatus && !detail) return c.json({ error: 'nothing_to_update', hint: 'Indica un nuevo estado o un detalle.' }, 400);

  const lat = b.lat == null ? null : Number(b.lat);
  const lon = b.lon == null ? null : Number(b.lon);
  if ((lat != null || lon != null) && !validLatLon(lat, lon)) return c.json({ error: 'bad_lat_lon' }, 400);

  const kind = b.status === 'hospitalizado' ? 'hospital' : (wantsStatus ? 'status_change' : 'note');
  await logDocket(c, id, kind, {
    status_from: wantsStatus ? curStatus : null,
    status_to: wantsStatus ? b.status : null,
    detail: detail || null,
    location: b.location ? String(b.location).slice(0, 200) : (hospital || null),
    lat, lon,
    source: 'citizen',
    review: 'pending',
  });
  await audit(c, 'persons.public_update', { id, status: wantsStatus ? b.status : null });
  return c.json({ ok: true, pending: true, message: 'Gracias. Tu actualización quedó pendiente de verificación por un operador.' });
});

// POST /api/persons/:id/approve | /reject — moderation (operator-gated in index.ts).
persons.post('/:id/approve', async (c) => {
  const r = await c.env.DB.prepare(`UPDATE persons SET review='approved', updated_ms=? WHERE id=?`)
    .bind(Date.now(), c.req.param('id')).run();
  await logDocket(c, c.req.param('id'), 'review', { detail: 'Reporte aprobado y publicado', source: 'operator' });
  await audit(c, 'persons.approve', { id: c.req.param('id') });
  return c.json({ ok: true, changed: r.meta.changes });
});
persons.post('/:id/reject', async (c) => {
  const r = await c.env.DB.prepare(`UPDATE persons SET review='rejected', updated_ms=? WHERE id=?`)
    .bind(Date.now(), c.req.param('id')).run();
  await logDocket(c, c.req.param('id'), 'review', { detail: 'Reporte rechazado en moderación', source: 'operator' });
  await audit(c, 'persons.reject', { id: c.req.param('id') });
  return c.json({ ok: true, changed: r.meta.changes });
});
