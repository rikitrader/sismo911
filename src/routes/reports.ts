import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { rateLimit, burstLimit, validLatLon, isImageBytes, nameHasSpam, textHasLink } from '../lib/security';
import { audit } from '../lib/audit';

// Citizen damage-report map (the "movement" core). PUBLIC reads of APPROVED
// reports; PUBLIC submission enters a moderation queue (status='pending').
// Moderation (PATCH/DELETE) is gated by the Access middleware in index.ts.
export const reports = new Hono<{ Bindings: Env }>();

const CATEGORIES = new Set([
  'damaged_building', 'collapsed_building', 'trapped_people', 'gas_leak',
  'aid_point', 'medical_need', 'water_point', 'shelter', 'other',
]);
const SEVERITIES = new Set(['rojo', 'naranja', 'amarillo']);

// Round published coords to ~100 m so exact home/location is never exposed.
const blur = (n: any) => (n == null ? null : Math.round(Number(n) * 1000) / 1000);

// GET /api/reports?status=approved&category=&severity=&since=&limit=
reports.get('/', async (c) => {
  const status = 'approved';
  const category = c.req.query('category');
  const severity = c.req.query('severity');
  const since = Number(c.req.query('since') ?? 0);
  const limit = Math.min(Number(c.req.query('limit') ?? 500), 1000);
  const where: string[] = ['status = ?']; const args: any[] = [status];
  if (category) { where.push('category = ?'); args.push(category); }
  if (severity) { where.push('severity = ?'); args.push(severity); }
  if (since) { where.push('created_ms > ?'); args.push(since); }
  const { results } = await c.env.DB.prepare(
    `SELECT id, category, severity, verification, title, description, lat, lon,
            estado, municipio, parroquia, building_type, people_trapped,
            source, source_url, image_key, reactions_up, created_ms
     FROM map_reports WHERE ${where.join(' AND ')} ORDER BY created_ms DESC LIMIT ?`
  ).bind(...args, limit).all();
  return c.json(results ?? []);
});

// GET /api/reports/stats — live counters for the dashboard/movement banner.
reports.get('/stats', async (c) => {
  const row: any = await c.env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN severity='rojo' THEN 1 ELSE 0 END) AS critical,
       SUM(CASE WHEN category IN ('aid_point','water_point','shelter','medical_need') THEN 1 ELSE 0 END) AS resources,
       SUM(CASE WHEN category='trapped_people' THEN 1 ELSE 0 END) AS trapped
     FROM map_reports WHERE status='approved'`
  ).first();
  const pending: any = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM map_reports WHERE status='pending'`
  ).first();
  return c.json({
    total: row?.total ?? 0, critical: row?.critical ?? 0,
    resources: row?.resources ?? 0, trapped: row?.trapped ?? 0,
    pending: pending?.n ?? 0,
  });
});

// GET /api/reports/:id — single approved report (for the detail page).
reports.get('/:id', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT id, category, severity, verification, title, description, lat, lon,
            estado, municipio, parroquia, building_type, people_trapped,
            source, source_url, image_key, reactions_up, created_ms
     FROM map_reports WHERE id = ? AND status='approved'`
  ).bind(c.req.param('id')).first();
  if (!row) return c.json({ error: 'no encontrado' }, 404);
  return c.json(row);
});

// POST /api/reports — citizen submission → moderation queue. Accepts JSON or
// multipart/form-data (the latter carries an optional "photo" image field).
reports.post('/', async (c) => {
  const limited = await rateLimit(c.env, c, 'reports_post', 20, 300);
  if (limited) return limited;

  // Read fields from JSON or multipart; only multipart carries a photo.
  const b: any = {};
  let photoBytes: Uint8Array | null = null;
  let photoType = 'image/jpeg';
  const ct = c.req.header('content-type') || '';
  if (ct.includes('multipart/form-data')) {
    const form = await c.req.formData().catch(() => null);
    if (!form) return c.json({ error: 'form_invalida' }, 400);
    for (const k of ['category', 'severity', 'title', 'description', 'estado', 'municipio', 'parroquia', 'building_type', 'people_trapped', 'reporter', 'lat', 'lon']) {
      const v = form.get(k);
      if (typeof v === 'string' && v !== '') b[k] = v;
    }
    const file = form.get('photo') as any;
    if (file && typeof file !== 'string' && typeof file.arrayBuffer === 'function' && file.size > 0) {
      photoBytes = new Uint8Array(await file.arrayBuffer());
      photoType = file.type || photoType;
    }
  } else {
    const j = await c.req.json().catch(() => null);
    if (j && typeof j === 'object') Object.assign(b, j);
  }

  if (!b?.category || !CATEGORIES.has(b.category)) return c.json({ error: 'categoría inválida' }, 400);
  if (!b?.title && !b?.description) return c.json({ error: 'título o descripción requerido' }, 400);
  if (b.severity && !SEVERITIES.has(b.severity)) return c.json({ error: 'severidad inválida' }, 400);
  // Spam guard at the door: a reporter name or title that is a link/domain, or a
  // description carrying a promotional link, is rejected (mirrors persons/familia).
  if (nameHasSpam(b.reporter) || nameHasSpam(b.title) || textHasLink(b.description)) {
    return c.json({ error: 'contenido_no_permitido', hint: 'No incluyas enlaces ni dominios.' }, 422);
  }
  const lat = b.lat == null ? null : Number(b.lat);
  const lon = b.lon == null ? null : Number(b.lon);
  if ((lat != null || lon != null) && !validLatLon(lat, lon)) return c.json({ error: 'bad_lat_lon' }, 400);

  // Validate the photo (if any) before we touch the DB.
  let imageKey: string | null = null;
  if (photoBytes) {
    if (photoBytes.length > 6_000_000) return c.json({ error: 'imagen_muy_grande', maxBytes: 6_000_000 }, 413);
    photoType = ['image/jpeg', 'image/png', 'image/webp'].includes(photoType) ? photoType : 'application/octet-stream';
    if (!isImageBytes(photoBytes, photoType)) return c.json({ error: 'tipo_de_imagen_no_soportado' }, 415);
    // Content-address the photo by its SHA-256 so identical bytes share one KV
    // blob (storage dedup) and let us detect re-submissions of the same image.
    const digest = await crypto.subtle.digest('SHA-256', photoBytes);
    const hash = [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
    imageKey = `report/${hash}`;
    const dup = await c.env.DB.prepare(
      `SELECT 1 FROM map_reports WHERE image_key = ? AND created_ms > ? LIMIT 1`
    ).bind(imageKey, Date.now() - 24 * 60 * 60 * 1000).first();
    if (dup) return c.json({ error: 'foto_duplicada', hint: 'Esta foto ya fue enviada recientemente.' }, 409);
    await c.env.PHOTOS.put(imageKey, photoBytes, { metadata: { contentType: photoType } });
  }

  const now = Date.now();
  const id = uid('rep');
  await c.env.DB.prepare(
    `INSERT INTO map_reports
      (id, category, severity, status, verification, title, description, lat, lon,
       estado, municipio, parroquia, building_type, people_trapped, source, image_key, reporter, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, b.category, b.severity ?? null, 'pending', 'unverified',
    (b.title ?? '').slice(0, 140) || null, (b.description ?? '').slice(0, 2000) || null,
    blur(lat), blur(lon), b.estado ? String(b.estado).slice(0, 120) : null, b.municipio ? String(b.municipio).slice(0, 120) : null, b.parroquia ? String(b.parroquia).slice(0, 120) : null,
    b.building_type ? String(b.building_type).slice(0, 80) : null, b.people_trapped ?? null, 'citizen', imageKey, b.reporter ? String(b.reporter).slice(0, 120) : null, now, now
  ).run();
  return c.json({ ok: true, id, status: 'pending', hasPhoto: !!imageKey, message: 'Recibido. Aparecerá tras revisión.' }, 201);
});

// GET /api/reports/photo/:id — serve an approved report's photo from KV.
reports.get('/photo/:id', async (c) => {
  const row: any = await c.env.DB.prepare(
    `SELECT image_key FROM map_reports WHERE id = ? AND status='approved'`
  ).bind(c.req.param('id')).first();
  if (!row?.image_key) return c.notFound();
  const obj = await c.env.PHOTOS.getWithMetadata<{ contentType?: string }>(row.image_key, 'arrayBuffer');
  if (!obj.value) return c.notFound();
  return new Response(obj.value, {
    headers: {
      'Content-Type': obj.metadata?.contentType || 'image/jpeg',
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    },
  });
});

// POST /api/reports/:id/react — bump support counter (no auth).
reports.post('/:id/react', async (c) => {
  // Hot endpoint: use the atomic CF limiter only. The KV limiter's per-key PUT
  // is itself throttled by KV (~1 write/s/key) and 500s under burst.
  const burst = await burstLimit(c.env, c, 'reports_react');
  if (burst) return burst;
  const r = await c.env.DB.prepare(
    `UPDATE map_reports SET reactions_up = reactions_up + 1 WHERE id = ? AND status='approved'`
  ).bind(c.req.param('id')).run();
  return c.json({ ok: true, changed: r.meta.changes });
});

// GET /api/reports/:id/comments
reports.get('/:id/comments', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, body, created_ms FROM report_comments WHERE report_id = ? ORDER BY created_ms ASC LIMIT 200`
  ).bind(c.req.param('id')).all();
  return c.json(results ?? []);
});

// POST /api/reports/:id/comments
reports.post('/:id/comments', async (c) => {
  const burst = await burstLimit(c.env, c, 'reports_comments');
  if (burst) return burst;
  const b = await c.req.json().catch(() => null);
  if (!b?.body) return c.json({ error: 'comentario vacío' }, 400);
  const id = uid('cmt');
  await c.env.DB.prepare(
    `INSERT INTO report_comments (id, report_id, name, body, created_ms) VALUES (?,?,?,?,?)`
  ).bind(id, c.req.param('id'), (b.name ?? 'Anónimo').slice(0, 60), b.body.slice(0, 1000), Date.now()).run();
  return c.json({ ok: true, id }, 201);
});

// --- Moderation (gated) ---
// GET /api/reports/queue — pending submissions for review.
reports.get('/queue', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM map_reports WHERE status='pending' ORDER BY created_ms ASC LIMIT 300`
  ).all();
  c.header('Cache-Control', 'no-store'); c.header('Vary', 'Cookie');
  return c.json(results ?? []);
});

// PATCH /api/reports/:id — approve / reject / verify.
reports.patch('/:id', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const sets: string[] = ['updated_ms = ?']; const args: any[] = [Date.now()];
  if (b.status) {
    if (!['pending', 'approved', 'rejected'].includes(b.status)) return c.json({ error: 'bad_status' }, 400);
    sets.push('status = ?'); args.push(b.status);
  }
  if (b.verification) {
    if (!['unverified', 'community_confirmed', 'official_verified'].includes(b.verification)) return c.json({ error: 'bad_verification' }, 400);
    sets.push('verification = ?'); args.push(b.verification);
  }
  if (b.severity) {
    if (!SEVERITIES.has(b.severity)) return c.json({ error: 'severidad inválida' }, 400);
    sets.push('severity = ?'); args.push(b.severity);
  }
  const r = await c.env.DB.prepare(
    `UPDATE map_reports SET ${sets.join(', ')} WHERE id = ?`
  ).bind(...args, c.req.param('id')).run();
  await audit(c, 'reports.moderate', { id: c.req.param('id'), status: b.status, verification: b.verification, severity: b.severity });
  return c.json({ ok: true, changed: r.meta.changes });
});

// DELETE /api/reports/:id — remove (gated).
reports.delete('/:id', async (c) => {
  await c.env.DB.prepare(`DELETE FROM map_reports WHERE id = ?`).bind(c.req.param('id')).run();
  await audit(c, 'reports.delete', { id: c.req.param('id') });
  return c.json({ ok: true });
});
