import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { rateLimit, validLatLon, blurCoord } from '../lib/security';
import { audit } from '../lib/audit';
import { getUserFromRequest } from '../lib/auth';

export const persons = new Hono<{ Bindings: Env }>();

// True when the current request is from a signed-in operator/admin.
async function isOperator(c: any): Promise<boolean> {
  const me = await getUserFromRequest(c.env, c).catch(() => null);
  return !!me && (me.role === 'operator' || me.role === 'admin');
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
  const limit = Math.min(1000, Math.max(1, Number(c.req.query('limit') || 500) || 500));
  const where: string[] = []; const binds: unknown[] = [];
  if (q) { where.push('(p.full_name LIKE ? OR p.last_seen LIKE ? OR p.case_number LIKE ?' + (op ? ' OR p.contact_phone LIKE ?' : '') + ')'); const l = `%${q}%`; binds.push(l, l, l); if (op) binds.push(l); }
  if (status && ['missing', 'found_safe', 'found_deceased', 'unknown'].includes(status)) { where.push('p.status = ?'); binds.push(status); }
  if (priority && ['alta', 'media', 'baja'].includes(priority)) { where.push('p.priority = ?'); binds.push(priority); }
  if (since > 0) { where.push('p.created_ms >= ?'); binds.push(since); }
  if (!op) { where.push("p.review = 'approved'"); }                                  // public: approved cases only
  else if (review && ['pending', 'approved', 'rejected'].includes(review)) { where.push('p.review = ?'); binds.push(review); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  // Public docket count = approved entries only; operators count everything.
  const dCount = op ? '' : " AND pe.review='approved'";
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.case_number, p.full_name, p.age, p.sex, p.last_seen, p.last_seen_lat, p.last_seen_lon,
            p.status, p.priority, p.incident_type, p.assigned_to, p.review, p.photo_url, p.contact_phone, p.reported_by, p.notes,
            p.event_id, p.created_ms, p.updated_ms,
            e.place_es AS event_place, e.place AS event_place_en, e.mag AS event_mag, e.time_ms AS event_time,
            (SELECT COUNT(*) FROM person_events pe WHERE pe.person_id = p.id${dCount}) AS docket_count,
            (SELECT COUNT(*) FROM case_attachments a WHERE a.person_id = p.id) AS evidence_count,
            (SELECT MAX(pe.created_ms) FROM person_events pe WHERE pe.person_id = p.id${dCount}) AS last_activity_ms
     FROM persons p LEFT JOIN events e ON e.id = p.event_id
     ${w} ORDER BY p.updated_ms DESC LIMIT ?`
  ).bind(...binds, limit).all<any>();
  const cases = (results ?? []).map((r) => op ? r : {
    id: r.id, case_number: r.case_number, full_name: r.full_name, age: r.age, sex: r.sex, last_seen: r.last_seen,
    status: r.status, incident_type: r.incident_type, review: r.review, photo_url: r.photo_url, notes: r.notes,
    event_id: r.event_id, created_ms: r.created_ms, updated_ms: r.updated_ms,
    event_place: r.event_place, event_place_en: r.event_place_en, event_mag: r.event_mag, event_time: r.event_time,
    docket_count: r.docket_count, last_activity_ms: r.last_activity_ms,
    // redacted for the public: contact_phone, reported_by, last_seen_lat/lon, priority, assigned_to
  });
  const sum: any = await c.env.DB.prepare(
    `SELECT
       SUM(CASE WHEN status='missing' THEN 1 ELSE 0 END) AS missing,
       SUM(CASE WHEN status='found_safe' THEN 1 ELSE 0 END) AS found_safe,
       SUM(CASE WHEN status='found_deceased' THEN 1 ELSE 0 END) AS deceased,
       SUM(CASE WHEN review='pending' THEN 1 ELSE 0 END) AS pending,
       COUNT(*) AS total
     FROM persons${op ? '' : " WHERE review='approved'"}`
  ).first();
  c.header('Cache-Control', 'no-store'); c.header('Vary', 'Cookie');
  return c.json({ cases, summary: sum ?? {}, operator: op });
});

// GET /api/persons/docket/queue — pending citizen-submitted updates awaiting
// approval (operator-gated in index.ts).
persons.get('/docket/queue', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT pe.id, pe.person_id, pe.kind, pe.status_from, pe.status_to, pe.detail, pe.location,
            pe.source, pe.actor, pe.created_ms, p.full_name
     FROM person_events pe JOIN persons p ON p.id = pe.person_id
     WHERE pe.review='pending' ORDER BY pe.created_ms ASC LIMIT 300`
  ).all();
  c.header('Cache-Control', 'no-store'); c.header('Vary', 'Cookie');
  return c.json({ updates: results ?? [] });
});

// POST /api/persons/docket/:eid/approve|reject — moderate a pending update
// (operator-gated in index.ts). Approving a status-change update applies it.
persons.post('/docket/:eid/approve', async (c) => {
  const eid = c.req.param('eid');
  const ev = await c.env.DB.prepare(`SELECT * FROM person_events WHERE id = ?`).bind(eid).first<any>();
  if (!ev) return c.json({ error: 'not_found' }, 404);
  await c.env.DB.prepare(`UPDATE person_events SET review='approved' WHERE id = ?`).bind(eid).run();
  // If the update proposed a status change, apply it to the person now.
  if (ev.status_to && ['missing', 'found_safe', 'found_deceased', 'unknown'].includes(ev.status_to)) {
    await c.env.DB.prepare(`UPDATE persons SET status = ?, updated_ms = ? WHERE id = ?`).bind(ev.status_to, Date.now(), ev.person_id).run();
  } else {
    await c.env.DB.prepare(`UPDATE persons SET updated_ms = ? WHERE id = ?`).bind(Date.now(), ev.person_id).run();
  }
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
  const person: any = await c.env.DB.prepare(`SELECT * FROM persons WHERE id = ?`).bind(id).first();
  if (!person) return c.notFound();
  if (!op && person.review !== 'approved') return c.notFound();   // public: approved cases only
  const event: any = person.event_id
    ? await c.env.DB.prepare(`SELECT id, mag, place, place_es, time_ms, depth_km, alert, lat, lon, url FROM events WHERE id = ?`).bind(person.event_id).first()
    : null;
  const { results: rows } = await c.env.DB.prepare(
    `SELECT id, kind, status_from, status_to, detail, location, lat, lon, source, actor, review, created_ms
     FROM person_events WHERE person_id = ?${op ? '' : " AND review='approved'"} ORDER BY created_ms ASC`
  ).bind(id).all<any>();
  const docket = (rows ?? []).map((d) => op ? d : {
    id: d.id, kind: d.kind, status_from: d.status_from, status_to: d.status_to,
    detail: d.detail, location: d.location, source: d.source, created_ms: d.created_ms,
    // redacted for the public: actor (operator identity), lat/lon
  });
  const pubPerson = op ? person : {
    id: person.id, full_name: person.full_name, age: person.age, sex: person.sex,
    last_seen: person.last_seen, status: person.status, review: person.review,
    photo_url: person.photo_url, notes: person.notes, event_id: person.event_id,
    created_ms: person.created_ms, updated_ms: person.updated_ms,
    // redacted: contact_phone, reported_by, last_seen_lat/lon
  };
  c.header('Cache-Control', 'no-store'); c.header('Vary', 'Cookie');
  return c.json({ person: pubPerson, event, docket, operator: op });
});

// POST /api/persons/:id/docket — submit a tracing update (LOGIN REQUIRED, any
// role — gated in index.ts). Operator/admin updates are applied immediately
// (review='approved'); citizen updates land as 'pending' for operator approval
// and do NOT change the person's status until approved.
persons.post('/:id/docket', async (c) => {
  const id = c.req.param('id');
  const op = await isOperator(c);
  const b = await c.req.json().catch(() => ({} as any));
  const exists = await c.env.DB.prepare(`SELECT id, status FROM persons WHERE id = ?`).bind(id).first<any>();
  if (!exists) return c.json({ error: 'not_found' }, 404);
  const allowed = ['note', 'sighting', 'contact', 'shelter', 'hospital', 'morgue', 'review', 'status_change'];
  const kind = allowed.includes(b.kind) ? b.kind : 'note';
  const lat = b.lat == null ? null : Number(b.lat);
  const lon = b.lon == null ? null : Number(b.lon);
  if ((lat != null || lon != null) && !validLatLon(lat, lon)) return c.json({ error: 'bad_lat_lon' }, 400);
  const wantsStatus = b.status && ['missing', 'found_safe', 'found_deceased', 'unknown'].includes(b.status) && b.status !== exists.status;
  let status_from: string | null = null; let status_to: string | null = null;
  if (wantsStatus) { status_from = exists.status; status_to = b.status; }
  // Operators: apply immediately + approved. Citizens: pending, status untouched.
  if (op) {
    if (status_to) await c.env.DB.prepare(`UPDATE persons SET status = ?, updated_ms = ? WHERE id = ?`).bind(status_to, Date.now(), id).run();
    else await c.env.DB.prepare(`UPDATE persons SET updated_ms = ? WHERE id = ?`).bind(Date.now(), id).run();
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
  await audit(c, 'persons.docket_add', { id, kind: status_to ? 'status_change' : kind, review: op ? 'approved' : 'pending' });
  return c.json({ ok: true, review: op ? 'approved' : 'pending' }, 201);
});

// ===================================================================
//  COURT-DOCKET CASE DETAIL (operator-only; gated in index.ts)
// ===================================================================

// PATCH /api/persons/:id/case — update case metadata (priority, incident, assignee).
persons.patch('/:id/case', async (c) => {
  const id = c.req.param('id'); const b = await c.req.json().catch(() => ({} as any));
  const sets: string[] = []; const binds: unknown[] = [];
  if (b.priority && ['alta', 'media', 'baja'].includes(b.priority)) { sets.push('priority = ?'); binds.push(b.priority); }
  if (typeof b.incident_type === 'string') { sets.push('incident_type = ?'); binds.push(b.incident_type.slice(0, 60)); }
  if (typeof b.assigned_to === 'string') { sets.push('assigned_to = ?'); binds.push(b.assigned_to.slice(0, 120)); }
  if (!sets.length) return c.json({ error: 'nothing_to_update' }, 400);
  sets.push('updated_ms = ?'); binds.push(Date.now());
  const r = await c.env.DB.prepare(`UPDATE persons SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id).run();
  await audit(c, 'persons.case_update', { id, priority: b.priority, incident_type: b.incident_type, assigned_to: b.assigned_to });
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
  const exists = await c.env.DB.prepare(`SELECT id FROM persons WHERE id = ?`).bind(id).first();
  if (!exists) return c.json({ error: 'not_found' }, 404);
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
