import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { rateLimit, validLatLon, blurCoord } from '../lib/security';
import { audit } from '../lib/audit';
import { getUserFromRequest } from '../lib/auth';

export const persons = new Hono<{ Bindings: Env }>();

// Append a tracing entry to a person's case docket. Best-effort: a docket write
// must never break the underlying status/report operation, so failures are
// logged and swallowed.
async function logDocket(
  c: any,
  person_id: string,
  kind: string,
  f: { status_from?: string | null; status_to?: string | null; detail?: string | null; location?: string | null; lat?: number | null; lon?: number | null; source?: string | null } = {}
) {
  try {
    const actor = await getUserFromRequest(c.env, c).catch(() => null);
    await c.env.DB.prepare(
      `INSERT INTO person_events (id, person_id, kind, status_from, status_to, detail, location, lat, lon, source, actor, created_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      uid('pev'), person_id, kind,
      f.status_from ?? null, f.status_to ?? null,
      f.detail ?? null, f.location ?? null, f.lat ?? null, f.lon ?? null,
      f.source ?? 'operator', actor?.email ?? actor?.id ?? null, Date.now()
    ).run();
  } catch (e: any) {
    console.error('[docket] log failed:', e?.message ?? e);
  }
}

// GET /api/persons/stats — live missing/found counters (approved only).
persons.get('/stats', async (c) => {
  const row: any = await c.env.DB.prepare(
    `SELECT
       SUM(CASE WHEN status='missing' THEN 1 ELSE 0 END) AS missing,
       SUM(CASE WHEN status IN ('found_safe','found_deceased') THEN 1 ELSE 0 END) AS found,
       COUNT(*) AS total
     FROM persons WHERE review='approved'`
  ).first();
  return c.json({ missing: row?.missing ?? 0, found: row?.found ?? 0, total: row?.total ?? 0 });
});

// GET /api/persons/cases — operator CRM/docket index (operator-gated in index.ts).
// Full PII + case metadata: linked sismo event, docket entry count, days open,
// last activity. Filters: q (name/location), status, review.
persons.get('/cases', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const status = c.req.query('status') ?? '';
  const review = c.req.query('review') ?? '';
  const limit = Math.min(1000, Math.max(1, Number(c.req.query('limit') || 500) || 500));
  const where: string[] = []; const binds: unknown[] = [];
  if (q) { where.push('(p.full_name LIKE ? OR p.last_seen LIKE ? OR p.contact_phone LIKE ?)'); const l = `%${q}%`; binds.push(l, l, l); }
  if (status && ['missing', 'found_safe', 'found_deceased', 'unknown'].includes(status)) { where.push('p.status = ?'); binds.push(status); }
  if (review && ['pending', 'approved', 'rejected'].includes(review)) { where.push('p.review = ?'); binds.push(review); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.full_name, p.age, p.sex, p.last_seen, p.last_seen_lat, p.last_seen_lon,
            p.status, p.review, p.photo_url, p.contact_phone, p.reported_by, p.notes,
            p.event_id, p.created_ms, p.updated_ms,
            e.place_es AS event_place, e.place AS event_place_en, e.mag AS event_mag, e.time_ms AS event_time,
            (SELECT COUNT(*) FROM person_events pe WHERE pe.person_id = p.id) AS docket_count,
            (SELECT MAX(pe.created_ms) FROM person_events pe WHERE pe.person_id = p.id) AS last_activity_ms
     FROM persons p LEFT JOIN events e ON e.id = p.event_id
     ${w} ORDER BY p.updated_ms DESC LIMIT ?`
  ).bind(...binds, limit).all();
  // Summary counters for the dashboard header (respect filters except status).
  const sum: any = await c.env.DB.prepare(
    `SELECT
       SUM(CASE WHEN status='missing' THEN 1 ELSE 0 END) AS missing,
       SUM(CASE WHEN status='found_safe' THEN 1 ELSE 0 END) AS found_safe,
       SUM(CASE WHEN status='found_deceased' THEN 1 ELSE 0 END) AS deceased,
       SUM(CASE WHEN review='pending' THEN 1 ELSE 0 END) AS pending,
       COUNT(*) AS total
     FROM persons`
  ).first();
  c.header('Cache-Control', 'no-store'); c.header('Vary', 'Cookie');
  return c.json({ cases: results ?? [], summary: sum ?? {} });
});

// GET /api/persons/:id/docket — full case file: person record, originating sismo,
// and the chronological tracing timeline (operator-gated in index.ts).
persons.get('/:id/docket', async (c) => {
  const id = c.req.param('id');
  const person: any = await c.env.DB.prepare(
    `SELECT * FROM persons WHERE id = ?`
  ).bind(id).first();
  if (!person) return c.notFound();
  const event: any = person.event_id
    ? await c.env.DB.prepare(`SELECT id, mag, place, place_es, time_ms, depth_km, alert, lat, lon, url FROM events WHERE id = ?`).bind(person.event_id).first()
    : null;
  const { results: docket } = await c.env.DB.prepare(
    `SELECT id, kind, status_from, status_to, detail, location, lat, lon, source, actor, created_ms
     FROM person_events WHERE person_id = ? ORDER BY created_ms ASC`
  ).bind(id).all();
  c.header('Cache-Control', 'no-store'); c.header('Vary', 'Cookie');
  return c.json({ person, event, docket: docket ?? [] });
});

// POST /api/persons/:id/docket — add a tracing entry to a case (operator-gated).
persons.post('/:id/docket', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => ({} as any));
  const exists = await c.env.DB.prepare(`SELECT id, status FROM persons WHERE id = ?`).bind(id).first<any>();
  if (!exists) return c.json({ error: 'not_found' }, 404);
  const allowed = ['note', 'sighting', 'contact', 'shelter', 'hospital', 'morgue', 'review', 'status_change'];
  const kind = allowed.includes(b.kind) ? b.kind : 'note';
  const lat = b.lat == null ? null : Number(b.lat);
  const lon = b.lon == null ? null : Number(b.lon);
  if ((lat != null || lon != null) && !validLatLon(lat, lon)) return c.json({ error: 'bad_lat_lon' }, 400);
  // A docket entry may carry a status change; if so, apply it to the person too.
  let status_from: string | null = null; let status_to: string | null = null;
  if (b.status && ['missing', 'found_safe', 'found_deceased', 'unknown'].includes(b.status) && b.status !== exists.status) {
    status_from = exists.status; status_to = b.status;
    await c.env.DB.prepare(`UPDATE persons SET status = ?, updated_ms = ? WHERE id = ?`).bind(b.status, Date.now(), id).run();
  } else {
    await c.env.DB.prepare(`UPDATE persons SET updated_ms = ? WHERE id = ?`).bind(Date.now(), id).run();
  }
  await logDocket(c, id, status_to ? 'status_change' : kind, {
    status_from, status_to,
    detail: b.detail ? String(b.detail).slice(0, 2000) : null,
    location: b.location ? String(b.location).slice(0, 200) : null,
    lat, lon, source: b.source ? String(b.source).slice(0, 30) : 'operator',
  });
  await audit(c, 'persons.docket_add', { id, kind: status_to ? 'status_change' : kind });
  return c.json({ ok: true }, 201);
});

// GET /api/persons/search?q= — name lookup (approved only, redacted).
persons.get('/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  if (q.length < 2) return c.json({ persons: [] });
  const like = `%${q}%`;
  const { results } = await c.env.DB.prepare(
    `SELECT id, full_name, age, sex, last_seen, status, photo_url, updated_ms
     FROM persons WHERE review='approved' AND full_name LIKE ?
     ORDER BY updated_ms DESC LIMIT 100`
  ).bind(like).all();
  return c.json({ persons: results ?? [] });
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
persons.get('/', async (c) => {
  const status = c.req.query('status');
  const q = status
    ? c.env.DB.prepare(`SELECT id,full_name,age,sex,last_seen,status,photo_url,created_ms,updated_ms FROM persons WHERE review='approved' AND status = ? ORDER BY updated_ms DESC LIMIT 500`).bind(status)
    : c.env.DB.prepare(`SELECT id,full_name,age,sex,last_seen,status,photo_url,created_ms,updated_ms FROM persons WHERE review='approved' ORDER BY updated_ms DESC LIMIT 500`);
  const { results } = await q.all();
  return c.json({ persons: results ?? [] });
});

// POST /api/persons — PUBLIC missing-person report → moderation queue (pending).
persons.post('/', async (c) => {
  const limited = await rateLimit(c.env, c, 'persons_post', 10, 300);
  if (limited) return limited;
  const b = await c.req.json().catch(() => null);
  if (!b?.full_name) return c.json({ error: 'nombre requerido' }, 400);
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
  if (!['missing', 'found_safe', 'found_deceased', 'unknown'].includes(b.status)) return c.json({ error: 'bad_status' }, 400);
  const id = c.req.param('id');
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
