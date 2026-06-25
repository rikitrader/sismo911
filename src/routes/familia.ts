import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { getUserFromRequest } from '../lib/auth';
import { rateLimit, isImageBytes } from '../lib/security';

// Missing-persons registry for /familia: keyset (cursor) pagination for 25k+
// scale, R2-backed photos, browsable gallery, and the shared moderation flow
// (citizen reports enter review='pending'; only review='approved' shows publicly).
export const familia = new Hono<{ Bindings: Env }>();

const DEFAULT_LIMIT = 24;

async function isOperator(c: any): Promise<boolean> {
  const me = await getUserFromRequest(c.env, c).catch(() => null);
  return !!me && (me.role === 'operator' || me.role === 'admin');
}
const clampLimit = (v: string | undefined, def: number) =>
  Math.min(60, Math.max(1, Number(v || def) || def));
// cursor = "<updated_ms>_<id>" → keyset condition for ORDER BY updated_ms DESC, id DESC
function cursorClause(cursor: string, where: string[], binds: unknown[]) {
  if (!cursor) return;
  const i = cursor.lastIndexOf('_');
  const ms = Number(cursor.slice(0, i)); const id = cursor.slice(i + 1);
  if (Number.isFinite(ms) && id) {
    where.push('(updated_ms < ? OR (updated_ms = ? AND id < ?))');
    binds.push(ms, ms, id);
  }
}
const nextCursor = (rows: any[], limit: number) =>
  rows.length > limit ? `${rows[limit - 1].updated_ms}_${rows[limit - 1].id}` : null;

// GET /api/familia/persons?q=&status=&cursor=&limit=  — approved registry, keyset paginated
familia.get('/persons', async (c) => {
  const q = (c.req.query('q') || '').trim();
  const status = c.req.query('status') || '';
  const limit = clampLimit(c.req.query('limit'), DEFAULT_LIMIT);

  const base = ["review = 'approved'"]; const baseBinds: unknown[] = [];
  if (q) { base.push('(full_name LIKE ? OR last_seen LIKE ?)'); baseBinds.push(`%${q}%`, `%${q}%`); }
  if (status) { base.push('status = ?'); baseBinds.push(status); }

  const total = ((await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM persons WHERE ${base.join(' AND ')}`).bind(...baseBinds).first<any>())?.n) ?? 0;

  const where = [...base]; const binds = [...baseBinds];
  cursorClause(c.req.query('cursor') || '', where, binds);
  const { results } = await c.env.DB.prepare(
    `SELECT id, full_name, age, sex, last_seen, status, photo_url, contact_phone, notes, updated_ms
     FROM persons WHERE ${where.join(' AND ')} ORDER BY updated_ms DESC, id DESC LIMIT ?`
  ).bind(...binds, limit + 1).all<any>();

  const rows = results ?? [];
  const op = await isOperator(c);
  const persons = rows.slice(0, limit).map((p) =>
    op ? p : { ...p, contact_phone: p.contact_phone ? '•••••• (solo operadores)' : null }
  );
  return c.json({ persons, total, nextCursor: nextCursor(rows, limit), limit });
});

// GET /api/familia/gallery?cursor=&limit=  — approved photos, keyset paginated
familia.get('/gallery', async (c) => {
  const limit = clampLimit(c.req.query('limit'), 30);
  const total = ((await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM persons WHERE review = 'approved' AND photo_url IS NOT NULL`
  ).first<any>())?.n) ?? 0;

  const where = ["review = 'approved'", 'photo_url IS NOT NULL']; const binds: unknown[] = [];
  cursorClause(c.req.query('cursor') || '', where, binds);
  const { results } = await c.env.DB.prepare(
    `SELECT id, full_name, age, status, last_seen, photo_url, updated_ms
     FROM persons WHERE ${where.join(' AND ')} ORDER BY updated_ms DESC, id DESC LIMIT ?`
  ).bind(...binds, limit + 1).all<any>();

  const rows = results ?? [];
  return c.json({ photos: rows.slice(0, limit), total, nextCursor: nextCursor(rows, limit) });
});

// POST /api/familia/persons  — citizen report (multipart photo → R2) → moderation queue
familia.post('/persons', async (c) => {
  const limited = await rateLimit(c.env, c, 'familia_register', 15, 300);
  if (limited) return limited;

  let b: any = {};
  let bytes: Uint8Array | null = null;
  let ctype = 'image/jpeg';
  if ((c.req.header('content-type') || '').includes('multipart/form-data')) {
    const f = await c.req.formData();
    for (const [k, v] of f.entries()) if (typeof v === 'string') b[k] = v;
    const ph = f.get('photo') as any;
    if (ph && typeof ph !== 'string' && typeof ph.arrayBuffer === 'function') {
      bytes = new Uint8Array(await ph.arrayBuffer());
      ctype = ph.type || ctype;
    }
  } else {
    b = (await c.req.json().catch(() => ({}))) || {};
  }
  if (!b.full_name) return c.json({ error: 'full_name_required' }, 400);

  const id = uid('per');
  const now = Date.now();
  let photo_url: string | null = null;
  if (bytes && bytes.length) {
    if (bytes.length > 6_000_000) return c.json({ error: 'image_too_large', maxBytes: 6_000_000 }, 413);
    ctype = ['image/jpeg', 'image/png', 'image/webp'].includes(ctype) ? ctype : 'application/octet-stream';
    if (!isImageBytes(bytes, ctype)) return c.json({ error: 'unsupported_image_type' }, 415);
    await c.env.PERSON_PHOTOS.put(`person/${id}`, bytes, { httpMetadata: { contentType: ctype } });
    photo_url = `/api/familia/photo/${id}`;
  }
  await c.env.DB.prepare(
    `INSERT INTO persons (id, full_name, age, sex, last_seen, status, contact_phone, notes, photo_url, reported_by, review, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, String(b.full_name).slice(0, 120), b.age ? Number(b.age) : null, b.sex ?? null,
    b.last_seen ? String(b.last_seen).slice(0, 200) : null, 'missing',
    b.contact_phone ? String(b.contact_phone).slice(0, 40) : null,
    b.notes ? String(b.notes).slice(0, 1000) : null, photo_url, b.reported_by ?? null,
    'pending', now, now
  ).run();
  return c.json({ ok: true, id, review: 'pending', message: 'Recibido. Aparecerá tras revisión de un operador.' }, 201);
});

// GET /api/familia/photo/:id  — serve a person photo from R2
familia.get('/photo/:id', async (c) => {
  const obj = await c.env.PERSON_PHOTOS.get(`person/${c.req.param('id')}`);
  if (!obj) return c.notFound();
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
