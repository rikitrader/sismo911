import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { rateLimit, validLatLon, nameHasSpam, textHasLink, isImageBytes } from '../lib/security';
import { getUserFromRequest } from '../lib/auth';
import { audit } from '../lib/audit';

// Attachment limits (shared by report-photo + per-case files).
const MAX_UPLOAD = 8_000_000; // 8 MB
const DOC_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/plain'];
async function readUpload(c: any): Promise<{ body: any; bytes: Uint8Array | null; ctype: string; filename: string }> {
  let body: any = {}; let bytes: Uint8Array | null = null; let ctype = 'application/octet-stream'; let filename = '';
  if ((c.req.header('content-type') || '').includes('multipart/form-data')) {
    const f = await c.req.formData();
    for (const [k, v] of f.entries()) if (typeof v === 'string') body[k] = v;
    const file = (f.get('file') || f.get('photo')) as any;
    if (file && typeof file !== 'string' && typeof file.arrayBuffer === 'function') {
      bytes = new Uint8Array(await file.arrayBuffer()); ctype = file.type || ctype; filename = file.name || '';
    }
  } else { body = (await c.req.json().catch(() => ({}))) || {}; }
  return { body, bytes, ctype, filename };
}

// Lost-pet CASE TRACKING — the /mascotas docket, mirroring the desaparecidos
// person-docket (src/routes/persons.ts). A pet case is a rav_reports row
// (kind='mascota'); its cronología lives in mascota_events.
//
// Public reads see moderation='approved' reports + review='approved' events.
// Citizen updates/sightings land review='pending' (never change the case status);
// operators apply changes immediately. App-owned columns (case_status, reunited_at,
// case_note, …) are never overwritten by the RAV ingest (see migration 0027).

export const mascotas = new Hono<{ Bindings: Env }>();

const STATUSES = ['perdida', 'avistada', 'en_transito', 'reunida', 'encontrada', 'fallecida'];
const clamp = (s: any, n: number) => String(s ?? '').slice(0, n);
const isOp = (u: any) => !!u && (u.role === 'operator' || u.role === 'admin');
// Display status: app-owned case_status wins; else derive from the RAV category/status.
const estadoOf = (r: any) => (r.case_status || r.category || r.status || 'perdida');

// GET /api/mascotas/queue — operator: pending citizen updates + pending reports.
// MUST be registered before the /:id route (same method/length) or it'd be shadowed.
mascotas.get('/api/mascotas/queue', async (c) => {
  const user = await getUserFromRequest(c.env, c).catch(() => null);
  if (!isOp(user)) return c.json({ error: 'unauthorized' }, 401);
  const { results: events } = await c.env.DB.prepare(
    `SELECT e.id, e.report_id, e.kind, e.status_to, e.detail, e.location, e.contact, e.created_ms, r.title pet_title
     FROM mascota_events e JOIN rav_reports r ON r.id = e.report_id
     WHERE e.review = 'pending' ORDER BY e.created_ms ASC LIMIT 300`,
  ).all();
  const { results: reports } = await c.env.DB.prepare(
    `SELECT id, title, description, category, city, state, contact, created_at
     FROM rav_reports WHERE kind = 'mascota' AND moderation = 'pending' ORDER BY created_at ASC LIMIT 300`,
  ).all();
  return c.json({ ok: true, events: events ?? [], reports: reports ?? [] }, 200, { 'Cache-Control': 'no-store' });
});

// GET /api/mascotas/:id — pet case file: profile + cronología (public, redacted).
mascotas.get('/api/mascotas/:id', async (c) => {
  const id = c.req.param('id');
  const user = await getUserFromRequest(c.env, c).catch(() => null);
  const op = isOp(user);
  const modOk = op ? '' : `AND coalesce(moderation,'approved') = 'approved'`;
  const r: any = await c.env.DB.prepare(
    `SELECT id, kind, category, title, description, city, state, area, lat, lng,
            ${op ? 'contact,' : ''} status, photo_url, photo_r2, tags, created_at,
            case_status, reunited_at, case_note, reports_count, case_updated_ms, moderation
     FROM rav_reports WHERE id = ? AND kind = 'mascota' ${modOk}`,
  ).bind(id).first();
  if (!r) return c.json({ error: 'not_found' }, 404);
  if (r.photo_r2) r.photo_url = `/api/mascotas/photo/${r.id}`;   // self-hosted hero photo
  delete r.photo_r2;

  const evWhere = op ? '' : `AND review = 'approved'`;
  const { results: events } = await c.env.DB.prepare(
    `SELECT id, kind, status_from, status_to, detail, location, ${op ? 'contact,' : ''} lat, lng, source, ${op ? 'actor,' : ''} created_ms, review
     FROM mascota_events WHERE report_id = ? ${evWhere} ORDER BY created_ms ASC`,
  ).bind(id).all();

  return c.json({
    ok: true, operator: op,
    pet: { ...r, estado: estadoOf(r) },
    timeline: events ?? [],
  }, 200, { 'Cache-Control': 'no-store' });
});

// POST /api/mascotas/:id/update — add a sighting/update to a pet case.
// Operator (logged in): applies the status immediately, event review='approved'.
// Citizen (public): event review='pending', case status unchanged until approved.
mascotas.post('/api/mascotas/:id/update', async (c) => {
  const id = c.req.param('id');
  const user = await getUserFromRequest(c.env, c).catch(() => null);
  const op = isOp(user);

  const pet: any = await c.env.DB.prepare(`SELECT id, case_status, category, status FROM rav_reports WHERE id = ? AND kind = 'mascota'`).bind(id).first();
  if (!pet) return c.json({ error: 'not_found' }, 404);

  let b: any = {};
  try { b = await c.req.json(); } catch { return c.json({ error: 'bad_json' }, 400); }
  const status = STATUSES.includes(String(b.status || '').toLowerCase()) ? String(b.status).toLowerCase() : '';
  const detail = clamp(b.detail, 2000).trim();
  const location = clamp(b.location, 200).trim();
  const contact = clamp(b.contact, 120).trim();
  const kind = status ? 'estado' : 'avistamiento';
  if (!status && !detail && !location) return c.json({ error: 'empty', hint: 'Indica un avistamiento, una nota o un estado.' }, 400);
  if (nameHasSpam(detail) || textHasLink(detail) || textHasLink(contact)) return c.json({ error: 'spam' }, 400);
  const lat = validLatLon(b.lat, b.lng) ? Number(b.lat) : null;
  const lng = validLatLon(b.lat, b.lng) ? Number(b.lng) : null;

  if (!op) {
    const limited = await rateLimit(c.env, c, 'mascota_update', 8, 600);
    if (limited) return c.json({ error: 'rate_limited' }, 429);
  }

  const now = Date.now();
  const from = estadoOf(pet);
  const review = op ? 'approved' : 'pending';
  await c.env.DB.prepare(
    `INSERT INTO mascota_events (id, report_id, kind, status_from, status_to, detail, location, lat, lng, contact, source, actor, created_ms, review)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(uid('me'), id, kind, status ? from : null, status || null, detail || null, location || null, lat, lng, contact || null,
    op ? 'operator' : 'citizen', op ? (user!.email || user!.id || 'operator') : null, now, review).run();

  // Operator: apply the status to the case immediately + bump activity.
  if (op && status) {
    await c.env.DB.prepare(
      `UPDATE rav_reports SET case_status = ?, reunited_at = ?, case_updated_ms = ?, reports_count = coalesce(reports_count,0) + 1 WHERE id = ?`,
    ).bind(status, status === 'reunida' ? now : pet.reunited_at ?? null, now, id).run();
  } else if (op) {
    await c.env.DB.prepare(`UPDATE rav_reports SET case_updated_ms = ?, reports_count = coalesce(reports_count,0) + 1 WHERE id = ?`).bind(now, id).run();
  }
  await audit(c, 'mascota.update', { id, kind, review, status: status || null });
  return c.json({ ok: true, review }, 201);
});

// POST /api/mascotas/report — citizen creates a new lost/found pet report.
// Lands moderation='pending'; visible after an operator approves. Accepts JSON or
// multipart/form-data with a `photo` file (stored in PERSON_PHOTOS → photo_r2).
mascotas.post('/api/mascotas/report', async (c) => {
  const { body: b, bytes, ctype } = await readUpload(c);
  const title = clamp(b.title, 200).trim();
  const description = clamp(b.description, 3000).trim();
  const category = ['perdida', 'encontrada'].includes(String(b.category || '').toLowerCase()) ? String(b.category).toLowerCase() : 'perdida';
  if (!title && !description) return c.json({ error: 'empty', hint: 'Describe a la mascota.' }, 400);
  if (nameHasSpam(title) || textHasLink(title) || textHasLink(b.contact)) return c.json({ error: 'spam' }, 400);
  const limited = await rateLimit(c.env, c, 'mascota_report', 5, 600);
  if (limited) return limited;

  const id = uid('sismo');
  const nowIso = new Date().toISOString();
  const lat = validLatLon(b.lat, b.lng) ? Number(b.lat) : null;
  const lng = validLatLon(b.lat, b.lng) ? Number(b.lng) : null;
  // Store an uploaded photo in R2 (validated by magic bytes), else accept a URL.
  let photo_r2: string | null = null;
  if (bytes && bytes.length) {
    if (bytes.length > MAX_UPLOAD) return c.json({ error: 'image_too_large', maxBytes: MAX_UPLOAD }, 413);
    const t = ['image/jpeg', 'image/png', 'image/webp'].includes(ctype) ? ctype : 'image/jpeg';
    if (!isImageBytes(bytes, t)) return c.json({ error: 'unsupported_image_type' }, 415);
    photo_r2 = `mascotas/${id}.jpg`;
    await c.env.PERSON_PHOTOS.put(photo_r2, bytes, { httpMetadata: { contentType: t } });
  }
  await c.env.DB.prepare(
    `INSERT INTO rav_reports (id, kind, category, title, description, city, state, area, lat, lng, contact, status, photo_url, photo_r2,
        meta, tags, origen, created_at, synced_at, pulled_at, case_status, moderation, reports_count)
     VALUES (?, 'mascota', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'activo', ?, ?, '{}', '["sismo911"]', 'sismo911', ?, ?, ?, ?, 'pending', 0)`,
  ).bind(id, category, title, description, clamp(b.city, 120) || null, clamp(b.state, 120) || null, clamp(b.area, 120) || null,
    lat, lng, clamp(b.contact, 120) || null, photo_r2 ? null : (clamp(b.photo_url, 600) || null), photo_r2, nowIso, nowIso, nowIso, category).run();
  await audit(c, 'mascota.report', { id, category, photo: !!photo_r2 });
  return c.json({ ok: true, id, review: 'pending', message: 'Recibido. Aparecerá tras la revisión de un moderador.' }, 201);
});

// GET /api/mascotas/photo/:id — serve a self-hosted pet photo from R2 (fallback to
// the external URL for RAV-sourced rows). Public.
mascotas.get('/api/mascotas/photo/:id', async (c) => {
  const r: any = await c.env.DB.prepare(`SELECT photo_r2, photo_url FROM rav_reports WHERE id = ? AND kind='mascota'`).bind(c.req.param('id')).first();
  if (!r) return c.notFound();
  if (r.photo_r2) {
    const obj = await c.env.PERSON_PHOTOS.get(r.photo_r2);
    if (obj) return new Response(obj.body, { headers: { 'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
  }
  if (r.photo_url) return c.redirect(r.photo_url, 302);
  return c.notFound();
});

// ---- Per-case attachments (documents / pictures / files) ----
// GET /api/mascotas/:id/attachments — public sees approved; operator sees all.
mascotas.get('/api/mascotas/:id/attachments', async (c) => {
  const id = c.req.param('id');
  const op = isOp(await getUserFromRequest(c.env, c).catch(() => null));
  const where = op ? '' : `AND review = 'approved'`;
  const { results } = await c.env.DB.prepare(
    `SELECT id, kind, filename, content_type, size, description, category, source, review, created_ms
     FROM mascota_attachments WHERE report_id = ? ${where} ORDER BY created_ms DESC`,
  ).bind(id).all();
  return c.json({ ok: true, operator: op, items: results ?? [] }, 200, { 'Cache-Control': 'no-store' });
});

// POST /api/mascotas/:id/attachments — upload a file (citizen→pending / operator→approved).
mascotas.post('/api/mascotas/:id/attachments', async (c) => {
  const id = c.req.param('id');
  const op = isOp(await getUserFromRequest(c.env, c).catch(() => null));
  const pet = await c.env.DB.prepare(`SELECT id FROM rav_reports WHERE id = ? AND kind='mascota'`).bind(id).first();
  if (!pet) return c.json({ error: 'not_found' }, 404);
  if (!op) { const limited = await rateLimit(c.env, c, 'mascota_attach', 6, 600); if (limited) return limited; }
  const { body: b, bytes, ctype, filename } = await readUpload(c);
  if (!bytes || !bytes.length) return c.json({ error: 'file_required' }, 400);
  if (bytes.length > MAX_UPLOAD) return c.json({ error: 'file_too_large', maxBytes: MAX_UPLOAD }, 413);
  const isImg = ['image/jpeg', 'image/png', 'image/webp'].includes(ctype);
  if (isImg && !isImageBytes(bytes, ctype)) return c.json({ error: 'unsupported_image_type' }, 415);
  if (!isImg && !DOC_TYPES.includes(ctype)) return c.json({ error: 'unsupported_file_type', allowed: DOC_TYPES }, 415);
  const aid = uid('ma');
  const r2_key = `mascota-att/${id}/${aid}`;
  await c.env.PERSON_PHOTOS.put(r2_key, bytes, { httpMetadata: { contentType: ctype } });
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO mascota_attachments (id, report_id, kind, r2_key, filename, content_type, size, description, category, source, review, uploaded_by, created_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(aid, id, isImg ? 'photo' : 'document', r2_key, clamp(filename, 200) || null, ctype, bytes.length,
    clamp(b.description, 500) || null, clamp(b.category, 40) || null, op ? 'operator' : 'citizen', op ? 'approved' : 'pending', null, now).run();
  await audit(c, 'mascota.attachment', { id, aid, review: op ? 'approved' : 'pending' });
  return c.json({ ok: true, id: aid, review: op ? 'approved' : 'pending' }, 201);
});

// GET /api/mascotas/:id/attachments/:aid/file — serve the file (public only if approved).
mascotas.get('/api/mascotas/:id/attachments/:aid/file', async (c) => {
  const op = isOp(await getUserFromRequest(c.env, c).catch(() => null));
  const a: any = await c.env.DB.prepare(`SELECT r2_key, content_type, filename, review FROM mascota_attachments WHERE id = ? AND report_id = ?`).bind(c.req.param('aid'), c.req.param('id')).first();
  if (!a || (!op && a.review !== 'approved')) return c.notFound();
  const obj = await c.env.PERSON_PHOTOS.get(a.r2_key);
  if (!obj) return c.notFound();
  return new Response(obj.body, { headers: { 'Content-Type': a.content_type || 'application/octet-stream', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
});

// POST /api/mascotas/attachments/:aid/approve|reject — operator moderation (gated via /approve|/reject).
mascotas.post('/api/mascotas/attachments/:aid/approve', async (c) => {
  await c.env.DB.prepare(`UPDATE mascota_attachments SET review='approved' WHERE id = ?`).bind(c.req.param('aid')).run();
  await audit(c, 'mascota.attachment.approve', { aid: c.req.param('aid') });
  return c.json({ ok: true });
});
mascotas.post('/api/mascotas/attachments/:aid/reject', async (c) => {
  await c.env.DB.prepare(`UPDATE mascota_attachments SET review='rejected' WHERE id = ?`).bind(c.req.param('aid')).run();
  return c.json({ ok: true });
});

// POST /api/mascotas/events/:eid/approve — operator approves a pending event.
// If it proposes a status, apply it to the case. (Operator gate via /approve.)
mascotas.post('/api/mascotas/events/:eid/approve', async (c) => {
  const eid = c.req.param('eid');
  const ev: any = await c.env.DB.prepare(`SELECT * FROM mascota_events WHERE id = ?`).bind(eid).first();
  if (!ev) return c.json({ error: 'not_found' }, 404);
  const now = Date.now();
  await c.env.DB.prepare(`UPDATE mascota_events SET review = 'approved' WHERE id = ?`).bind(eid).run();
  if (ev.status_to && STATUSES.includes(ev.status_to)) {
    await c.env.DB.prepare(
      `UPDATE rav_reports SET case_status = ?, reunited_at = ?, case_updated_ms = ?, reports_count = coalesce(reports_count,0) + 1 WHERE id = ?`,
    ).bind(ev.status_to, ev.status_to === 'reunida' ? now : null, now, ev.report_id).run();
  } else {
    await c.env.DB.prepare(`UPDATE rav_reports SET case_updated_ms = ?, reports_count = coalesce(reports_count,0) + 1 WHERE id = ?`).bind(now, ev.report_id).run();
  }
  await audit(c, 'mascota.event.approve', { eid, report_id: ev.report_id });
  return c.json({ ok: true });
});

// POST /api/mascotas/events/:eid/reject — operator rejects a pending event.
mascotas.post('/api/mascotas/events/:eid/reject', async (c) => {
  const eid = c.req.param('eid');
  const r = await c.env.DB.prepare(`UPDATE mascota_events SET review = 'rejected' WHERE id = ?`).bind(eid).run();
  await audit(c, 'mascota.event.reject', { eid });
  return c.json({ ok: !!r });
});

// POST /api/mascotas/:id/approve — operator publishes a pending citizen report.
mascotas.post('/api/mascotas/:id/approve', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare(`UPDATE rav_reports SET moderation = 'approved' WHERE id = ? AND kind = 'mascota'`).bind(id).run();
  await audit(c, 'mascota.report.approve', { id });
  return c.json({ ok: true });
});
