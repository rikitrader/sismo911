import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { rateLimit, burstLimit } from '../lib/security';
import { getUserFromRequest } from '../lib/auth';
import { audit } from '../lib/audit';
import { sendEmail, reportReceivedEmail } from '../lib/email';
import { runGate, clientMessage, recordClean } from '../security/ingestion-gate';
import { z, nameField, textField, latField, lonField } from '../security/validators';

// Gate schema for a citizen map report. category/severity are pre-checked for
// friendly Spanish errors below, so here they're lenient strings; title/reporter
// are strict NAME fields (no link/markup), description is free TEXT (source links
// allowed), and the photo is scanned (magic-bytes/polyglot/size) by the gate.
const ReportSchema = z.object({
  category: z.string().max(40).optional(),
  severity: z.string().max(20).optional(),
  title: nameField(140).optional(),
  description: textField(2000).optional(),
  estado: z.string().max(120).optional(),
  municipio: z.string().max(120).optional(),
  parroquia: z.string().max(120).optional(),
  building_type: z.string().max(80).optional(),
  people_trapped: z.coerce.number().int().min(0).max(100000).optional(),
  reporter: nameField(120).optional(),
  reporter_email: z.string().email().max(254).optional().or(z.literal('')),
  lat: latField.optional(),
  lon: lonField.optional(),
});
const REPORT_FIELDS = [
  'category', 'severity', 'title', 'description', 'estado', 'municipio', 'parroquia',
  'building_type', 'people_trapped', 'reporter', 'reporter_email', 'lat', 'lon',
] as const;

// Human-readable Spanish labels for confirmation emails.
const CATEGORY_LABELS: Record<string, string> = {
  damaged_building: 'Daño estructural', collapsed_building: 'Colapso', trapped_people: 'Personas atrapadas',
  gas_leak: 'Fuga de gas', aid_point: 'Punto de ayuda', medical_need: 'Necesidad médica',
  water_point: 'Agua', shelter: 'Refugio', other: 'Otro',
};
const isEmail = (s: unknown): s is string => typeof s === 'string' && s.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

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

// Is the caller an operator/admin? Operators get the unmodified rows; the public
// gets a PII-minimized projection (coarser coords + truncated free-text).
async function isOperatorReq(c: any): Promise<boolean> {
  const me = await getUserFromRequest(c.env, c).catch(() => null);
  return !!(me && (me.role === 'operator' || me.role === 'admin'));
}

// Public projection of a report row: round lat/lon to ~1.1 km and truncate the
// free-text description (which may carry names/ages/medical notes).
const publicReport = (row: any) => ({
  ...row,
  lat: row.lat == null ? null : Math.round(Number(row.lat) * 100) / 100,
  lon: row.lon == null ? null : Math.round(Number(row.lon) * 100) / 100,
  description: row.description ? String(row.description).slice(0, 120) : row.description,
});

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
  const rows = results ?? [];
  if (await isOperatorReq(c)) return c.json(rows);
  return c.json(rows.map(publicReport));
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
  if (await isOperatorReq(c)) return c.json(row);
  return c.json(publicReport(row));
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
    for (const k of ['category', 'severity', 'title', 'description', 'estado', 'municipio', 'parroquia', 'building_type', 'people_trapped', 'reporter', 'reporter_email', 'lat', 'lon']) {
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

  // Friendly Spanish pre-checks (specific errors) BEFORE the gate's generic msg.
  if (!b?.category || !CATEGORIES.has(b.category)) return c.json({ error: 'categoría inválida' }, 400);
  if (!b?.title && !b?.description) return c.json({ error: 'título o descripción requerido' }, 400);
  if (b.severity && !SEVERITIES.has(b.severity)) return c.json({ error: 'severidad inválida' }, 400);

  // Unified gate: normalizes fields, spam-SCORES reporter/title/description (vs
  // the old binary link check), and SCANS the photo (magic-bytes/MIME/polyglot/
  // size + SHA-256). rateLimit already ran above, so skipRateLimit. Audited.
  const gate = await runGate(c.env, c, {
    surface: 'map_report',
    schema: ReportSchema,
    allowedFields: REPORT_FIELDS,
    nameFields: ['title', 'reporter'],
    textFields: ['description'],
    emailField: 'reporter_email',
    skipRateLimit: true,
    file: photoBytes ? { fieldName: 'photo', keyPrefix: 'report/', maxSize: 6_000_000 } : undefined,
  }, JSON.stringify(b), photoBytes ? { bytes: photoBytes, mime: photoType, filename: 'photo' } : undefined);
  if (!gate.ok) {
    if (gate.retryAfterSec) c.header('Retry-After', String(gate.retryAfterSec));
    return c.json(clientMessage(gate), gate.status);
  }
  const g = gate.data;
  const lat = g.lat ?? null;
  const lon = g.lon ?? null;

  // Validated photo → content-addressed key (SHA-256). Identical bytes share one
  // KV blob (storage dedup) + let us detect re-submissions of the same image.
  let imageKey: string | null = null;
  if (gate.file?.sha256) {
    imageKey = `report/${gate.file.sha256}`;
    const dup = await c.env.DB.prepare(
      `SELECT 1 FROM map_reports WHERE image_key = ? AND created_ms > ? LIMIT 1`
    ).bind(imageKey, Date.now() - 24 * 60 * 60 * 1000).first();
    if (dup) return c.json({ error: 'foto_duplicada', hint: 'Esta foto ya fue enviada recientemente.' }, 409);
    await c.env.PHOTOS.put(imageKey, gate.file.bytes, { metadata: { contentType: `image/${gate.file.detectedType}` } });
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
    (g.title ?? '').slice(0, 140) || null, (g.description ?? '').slice(0, 2000) || null,
    blur(lat), blur(lon), g.estado ? String(g.estado).slice(0, 120) : null, g.municipio ? String(g.municipio).slice(0, 120) : null, g.parroquia ? String(g.parroquia).slice(0, 120) : null,
    g.building_type ? String(g.building_type).slice(0, 80) : null, g.people_trapped ?? null, 'citizen', imageKey, g.reporter ? String(g.reporter).slice(0, 120) : null, now, now
  ).run();
  await recordClean(c.env, c, { correlationId: gate.correlationId, surface: 'map_report', destTable: 'map_reports', destId: id, r2Key: imageKey ?? undefined, score: gate.score, payloadHash: gate.payloadHash });

  // Email confirmation system: if the reporter left a valid email, send a
  // branded receipt with a reference number. Never blocks the response — the
  // send runs after we respond (waitUntil) and a failure is logged, not fatal.
  let emailQueued = false;
  if (isEmail(b.reporter_email)) {
    emailQueued = true;
    const place = [b.parroquia, b.municipio, b.estado].filter(Boolean).join(', ') || undefined;
    const msg = reportReceivedEmail({
      name: b.reporter ? String(b.reporter).slice(0, 80) : undefined,
      refId: id,
      categoryLabel: CATEGORY_LABELS[b.category] || b.category,
      place,
    });
    c.executionCtx.waitUntil(sendEmail(c.env, String(b.reporter_email).trim(), msg).catch(() => false));
  }

  return c.json({ ok: true, id, status: 'pending', hasPhoto: !!imageKey, emailQueued, message: 'Recibido. Aparecerá tras revisión.' }, 201);
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
