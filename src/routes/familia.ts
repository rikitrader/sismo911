import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { getUserFromRequest } from '../lib/auth';
import { rateLimit, burstLimit, isImageBytes, nameHasSpam, textHasLink, requestIp } from '../lib/security';
import { audit } from '../lib/audit';
import { recomputeCaseScore } from '../lib/case-score-sync';

// Missing-persons registry (/familia). Reads the `personas` dataset in the main
// (sismo911) D1 database; photos live in the DESAP_FOTOS R2 bucket (keyed by foto_r2).
// Keyset/cursor pagination for scale. Phone (`contacto`) redacted for the public.
export const familia = new Hono<{ Bindings: Env }>();
const DEFAULT_LIMIT = 24;

const estadoToStatus = (e: string) =>
  e === 'localizado' ? 'found_safe' : e === 'fallecido' ? 'found_deceased' : 'missing';
const statusToEstado = (s: string) =>
  s === 'found_safe' ? 'localizado' : s === 'missing' ? 'sin-contacto' : null;

async function isOperator(c: any): Promise<boolean> {
  const me = await getUserFromRequest(c.env, c).catch(() => null);
  return !!me && (me.role === 'operator' || me.role === 'admin');
}
const clampLimit = (v: string | undefined, def: number) => Math.min(60, Math.max(1, Number(v || def) || def));
// cursor = "<updated_at>_<id>"; most rows share updated_at, so id is the real key
function cursorClause(cursor: string, where: string[], binds: unknown[]) {
  if (!cursor) return;
  const i = cursor.lastIndexOf('_');
  const ms = Number(cursor.slice(0, i)); const id = cursor.slice(i + 1);
  if (Number.isFinite(ms) && id) { where.push('(updated_at < ? OR (updated_at = ? AND id < ?))'); binds.push(ms, ms, id); }
}
const nextCursor = (rows: any[], limit: number) =>
  rows.length > limit ? `${rows[limit - 1].updated_at}_${rows[limit - 1].id}` : null;

function mapPerson(p: any, op: boolean) {
  return {
    id: p.id, full_name: p.nombre, age: p.edad, sex: null,
    last_seen: p.ubicacion, status: estadoToStatus(p.estado),
    photo_url: p.foto_r2 ? `/api/familia/photo/${p.id}` : (p.foto || null),
    contact_phone: op ? (p.contacto || null) : (p.contacto ? '•••••• (solo operadores)' : null),
    notes: p.descripcion, updated_ms: p.updated_at,
  };
}

// GET /api/familia/persons?q=&status=&cursor=&limit=
familia.get('/persons', async (c) => {
  const q = (c.req.query('q') || '').trim();
  const limit = clampLimit(c.req.query('limit'), DEFAULT_LIMIT);
  const op = await isOperator(c);
  const base: string[] = []; const baseBinds: unknown[] = [];
  // Public sees only moderated rows; operators see everything (incl. pending).
  if (!op) base.push("moderation = 'approved'");
  if (q) { base.push('(nombre LIKE ? OR ubicacion LIKE ?)'); baseBinds.push(`%${q}%`, `%${q}%`); }
  const est = statusToEstado(c.req.query('status') || '');
  if (est) { base.push('estado = ?'); baseBinds.push(est); }
  const wBase = base.length ? 'WHERE ' + base.join(' AND ') : '';

  const total = ((await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM personas ${wBase}`).bind(...baseBinds).first<any>())?.n) ?? 0;
  const where = [...base]; const binds = [...baseBinds];
  cursorClause(c.req.query('cursor') || '', where, binds);
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const { results } = await c.env.DB.prepare(
    `SELECT id, nombre, edad, ubicacion, descripcion, contacto, foto, foto_r2, estado, updated_at
     FROM personas ${w} ORDER BY updated_at DESC, id DESC LIMIT ?`
  ).bind(...binds, limit + 1).all<any>();
  const rows = results ?? [];

  // Federate operator case files (native `persons` in the main DB) so /familia searches
  // ALL cases, not just the registry. These are far fewer than the 48k registry, so we
  // surface them on the first page only; the registry keeps its keyset pagination below.
  let nativeCases: any[] = []; let nativeTotal = 0;
  if (!(c.req.query('cursor') || '')) {
    const nb: string[] = []; const nbinds: unknown[] = [];
    if (!op) nb.push("review = 'approved'");
    if (q) { nb.push('(full_name LIKE ? OR last_seen LIKE ?)'); nbinds.push(`%${q}%`, `%${q}%`); }
    const stq = c.req.query('status') || '';
    if (['missing', 'found_safe', 'found_deceased', 'unknown'].includes(stq)) { nb.push('status = ?'); nbinds.push(stq); }
    const nw = nb.length ? 'WHERE ' + nb.join(' AND ') : '';
    try {
      nativeTotal = ((await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM persons ${nw}`).bind(...nbinds).first<any>())?.n) ?? 0;
      const { results: nrows } = await c.env.DB.prepare(
        `SELECT id, full_name, age, sex, last_seen, status, photo_url, contact_phone, notes, updated_ms
         FROM persons ${nw} ORDER BY updated_ms DESC LIMIT 24`
      ).bind(...nbinds).all<any>();
      nativeCases = (nrows || []).map((r: any) => ({
        id: r.id, full_name: r.full_name, age: r.age, sex: r.sex,
        last_seen: r.last_seen, status: r.status || 'unknown', photo_url: r.photo_url || null,
        contact_phone: op ? (r.contact_phone || null) : (r.contact_phone ? '•••••• (solo operadores)' : null),
        notes: r.notes, updated_ms: r.updated_ms, kind: 'case',
      }));
    } catch (e: any) { console.error('[familia/persons] native-case merge failed:', e?.message ?? e); }
  }

  const persons = [...nativeCases, ...rows.slice(0, limit).map((r) => mapPerson(r, op))];
  return c.json({ persons, total: total + nativeTotal, nextCursor: nextCursor(rows, limit), limit });
});

// GET /api/familia/gallery?cursor=&limit=
familia.get('/gallery', async (c) => {
  const limit = clampLimit(c.req.query('limit'), 30);
  // optional ?status=missing → only still-missing (estado='sin-contacto'); default = all approved photos
  const est = statusToEstado(c.req.query('status') || '');
  const base = ['foto_r2 IS NOT NULL', "moderation = 'approved'"]; const baseBinds: unknown[] = [];
  if (est) { base.push('estado = ?'); baseBinds.push(est); }
  const wBase = base.join(' AND ');
  const total = ((await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM personas WHERE ${wBase}`).bind(...baseBinds).first<any>())?.n) ?? 0;
  const where = [...base]; const binds = [...baseBinds];
  cursorClause(c.req.query('cursor') || '', where, binds);
  const { results } = await c.env.DB.prepare(
    `SELECT id, nombre, edad, ubicacion, estado, foto_r2, updated_at FROM personas
     WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`
  ).bind(...binds, limit + 1).all<any>();
  const rows = results ?? [];
  return c.json({
    photos: rows.slice(0, limit).map((p) => ({ id: p.id, full_name: p.nombre, age: p.edad, status: estadoToStatus(p.estado), last_seen: p.ubicacion, photo_url: `/api/familia/photo/${p.id}` })),
    total, nextCursor: nextCursor(rows, limit),
  });
});

// GET /api/familia/photo/:id  — serve from DESAP_FOTOS R2, fall back to the external URL
familia.get('/photo/:id', async (c) => {
  const row: any = await c.env.DB.prepare(`SELECT foto_r2, foto FROM personas WHERE id = ?`).bind(c.req.param('id')).first();
  if (!row) return c.notFound();
  if (row.foto_r2) {
    const obj = await c.env.DESAP_FOTOS.get(row.foto_r2);
    if (obj) return new Response(obj.body, {
      headers: { 'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' },
    });
  }
  if (row.foto) return c.redirect(row.foto, 302);
  return c.notFound();
});

// GET /api/familia/person/:id  — full public detail for the click-to-open card modal.
familia.get('/person/:id', async (c) => {
  const id = c.req.param('id');
  // Native operator case file (id like "per_xxxxxxxx") lives in the main DB.
  if (id.startsWith('per_')) {
    const op = await isOperator(c);
    const r: any = await c.env.DB.prepare(
      `SELECT id, full_name, age, last_seen, status, photo_url, contact_phone, notes, review
       FROM persons WHERE id = ?`
    ).bind(id).first();
    if (!r || (!op && r.review !== 'approved')) return c.json({ error: 'not_found' }, 404);
    c.header('Cache-Control', 'public, max-age=120');
    return c.json({
      id: r.id, full_name: r.full_name, age: r.age, last_seen: r.last_seen,
      since: null, reporter: op ? (r.contact_phone || null) : null, description: r.notes || null,
      status: r.status || 'unknown', estado: null, found_by: null, kind: 'case',
      photo_url: r.photo_url || null,
      share_url: `https://sismo911.com/familia?caso=${r.id}`,
    });
  }
  const p: any = await c.env.DB.prepare(
    `SELECT id, nombre, edad, ubicacion, fecha, descripcion, contacto, estado, foto, foto_r2, localizado_por, updated_at
     FROM personas WHERE id = ? AND moderation = 'approved'`
  ).bind(id).first();
  if (!p) return c.json({ error: 'not_found' }, 404);
  c.header('Cache-Control', 'public, max-age=120');
  return c.json({
    id: p.id, full_name: p.nombre, age: p.edad, last_seen: p.ubicacion,
    since: p.fecha || null, reporter: p.contacto || null, description: p.descripcion || null,
    status: estadoToStatus(p.estado), estado: p.estado, found_by: p.localizado_por || null,
    photo_url: (p.foto_r2 || p.foto) ? `/api/familia/photo/${p.id}` : null,
    share_url: `https://sismo911.com/familia?persona=${p.id}`,
  });
});

// POST /api/familia/:id/localizar  — mark as found (operator-gated in index.ts + here).
familia.post('/:id/localizar', async (c) => {
  if (!(await isOperator(c))) return c.json({ error: 'unauthorized', hint: 'Solo operadores pueden confirmar' }, 401);
  const b = await c.req.json().catch(() => ({} as any));
  await c.env.DB.prepare(
    `UPDATE personas SET estado = 'localizado', localizado_nota = ?, updated_at = ? WHERE id = ?`
  ).bind(String(b?.nota ?? 'Marcada como localizada').slice(0, 300), Date.now(), c.req.param('id')).run();
  // Autonomous auto-update: found → case re-scores to 'baja' (MENOR) immediately.
  await recomputeCaseScore(c.env, 'fam-' + c.req.param('id')).catch(() => {});
  return c.json({ ok: true, status: 'found_safe' });
});

// POST /api/familia/:id/report  — public "reportar contenido obsceno" flag (rate-limited).
familia.post('/:id/report', async (c) => {
  const limited = await rateLimit(c.env, c, 'familia_flag', 10, 300);
  if (limited) return limited;
  await c.env.DB.prepare(
    `UPDATE personas SET reportes = COALESCE(reportes,0) + 1,
       reportada = CASE WHEN COALESCE(reportes,0) + 1 >= 3 THEN 1 ELSE COALESCE(reportada,0) END,
       reportada_at = ? WHERE id = ?`
  ).bind(Date.now(), c.req.param('id')).run();
  return c.json({ ok: true });
});

// POST /api/familia/persons  — citizen report → personas (photo → DESAP_FOTOS)
familia.post('/persons', async (c) => {
  const burst = await burstLimit(c.env, c, 'familia_register');
  if (burst) return burst;
  const limited = await rateLimit(c.env, c, 'familia_register', 15, 300);
  if (limited) return limited;
  let b: any = {}; let bytes: Uint8Array | null = null; let ctype = 'image/jpeg';
  if ((c.req.header('content-type') || '').includes('multipart/form-data')) {
    const f = await c.req.formData();
    for (const [k, v] of f.entries()) if (typeof v === 'string') b[k] = v;
    const ph = f.get('photo') as any;
    if (ph && typeof ph !== 'string' && typeof ph.arrayBuffer === 'function') { bytes = new Uint8Array(await ph.arrayBuffer()); ctype = ph.type || ctype; }
  } else { b = (await c.req.json().catch(() => ({}))) || {}; }
  const nombre = b.full_name || b.nombre;
  if (!nombre) return c.json({ error: 'full_name_required' }, 400);
  // Link-spam gate: missing-person reports never contain a website. Reject any
  // link/domain in the name, description or contact (blocks injections like
  // "TRUSTEDF57 - infinityhotel.it" before they reach the moderation queue).
  if (nameHasSpam(nombre) || textHasLink(b.notes) || textHasLink(b.contact_phone)) {
    await audit(c, 'spam_blocked', { ip: requestIp(c), src: 'familia' }).catch(() => {});
    return c.json({ error: 'spam_blocked', hint: 'No incluyas enlaces ni sitios web en el reporte.' }, 400);
  }

  // Anti-duplicate gate: if an identical report already exists (same name +
  // location + contact), return it instead of creating a duplicate — no photo
  // upload, no insert.
  const existing = await c.env.DB.prepare(
    `SELECT id FROM personas
      WHERE lower(trim(nombre)) = lower(trim(?))
        AND lower(trim(coalesce(ubicacion,''))) = lower(trim(coalesce(?,'')))
        AND lower(trim(coalesce(contacto,''))) = lower(trim(coalesce(?,'')))
      LIMIT 1`
  ).bind(String(nombre), b.last_seen ?? '', b.contact_phone ?? '').first<{ id: string }>().catch(() => null);
  if (existing?.id) return c.json({ ok: true, id: existing.id, duplicate: true }, 200);

  const id = uid('pc'); const now = Date.now(); let foto_r2: string | null = null;
  if (bytes && bytes.length) {
    if (bytes.length > 6_000_000) return c.json({ error: 'image_too_large', maxBytes: 6_000_000 }, 413);
    ctype = ['image/jpeg', 'image/png', 'image/webp'].includes(ctype) ? ctype : 'application/octet-stream';
    if (!isImageBytes(bytes, ctype)) return c.json({ error: 'unsupported_image_type' }, 415);
    foto_r2 = `fotos/${id}.jpg`;
    await c.env.DESAP_FOTOS.put(foto_r2, bytes, { httpMetadata: { contentType: ctype } });
  }
  await c.env.DB.prepare(
    `INSERT INTO personas (id, nombre, edad, ubicacion, descripcion, contacto, foto_r2, estado, moderation, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, String(nombre).slice(0, 120), b.age ? Number(b.age) : null,
    // ubicacion/descripcion/contacto are NOT NULL — coalesce missing to '' (a
    // null here is a 500: NOT NULL constraint failed).
    b.last_seen ? String(b.last_seen).slice(0, 200) : '',
    b.notes ? String(b.notes).slice(0, 1000) : '',
    b.contact_phone ? String(b.contact_phone).slice(0, 80) : '',
    foto_r2, 'sin-contacto', 'pending', now, now
  ).run();
  // Public submission enters moderation — not shown until an operator approves.
  return c.json({ ok: true, id, status: 'pending', message: 'Recibido. Aparecerá tras revisión.' }, 201);
});

// GET /api/familia/queue — pending citizen submissions (operator-only).
familia.get('/queue', async (c) => {
  if (!(await isOperator(c))) return c.json({ error: 'unauthorized', hint: 'Inicia sesión como operador o admin' }, 401);
  c.header('Cache-Control', 'no-store');
  const { results } = await c.env.DB.prepare(
    `SELECT id, nombre, edad, ubicacion, descripcion, contacto, foto_r2, estado, updated_at
     FROM personas WHERE moderation='pending' ORDER BY updated_at DESC, id DESC LIMIT 300`
  ).all<any>();
  return c.json({ persons: (results ?? []).map((r) => mapPerson(r, true)) });
});

// POST /api/familia/:id/approve — publish a pending submission (operator-only).
familia.post('/:id/approve', async (c) => {
  if (!(await isOperator(c))) return c.json({ error: 'unauthorized', hint: 'Inicia sesión como operador o admin' }, 401);
  const r = await c.env.DB.prepare(
    `UPDATE personas SET moderation='approved', updated_at=? WHERE id=? AND moderation='pending'`
  ).bind(Date.now(), c.req.param('id')).run();
  return c.json({ ok: true, approved: r.meta.changes });
});
