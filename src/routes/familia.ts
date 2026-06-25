import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { getUserFromRequest } from '../lib/auth';
import { rateLimit, isImageBytes } from '../lib/security';

// Missing-persons registry for /familia: search + pagination (25k+ scale),
// R2-backed photos, and a browsable gallery. Reads/writes the `persons` table.
export const familia = new Hono<{ Bindings: Env }>();

const DEFAULT_LIMIT = 24;

async function isOperator(c: any): Promise<boolean> {
  const me = await getUserFromRequest(c.env, c).catch(() => null);
  return !!me && (me.role === 'operator' || me.role === 'admin');
}

// GET /api/familia/persons?q=&status=&page=&limit=  — paginated + searchable
familia.get('/persons', async (c) => {
  const q = (c.req.query('q') || '').trim();
  const status = c.req.query('status') || '';
  const page = Math.max(1, Number(c.req.query('page') || 1) || 1);
  const limit = Math.min(60, Math.max(1, Number(c.req.query('limit') || DEFAULT_LIMIT) || DEFAULT_LIMIT));

  const where: string[] = [];
  const binds: unknown[] = [];
  if (q) { where.push('(full_name LIKE ? OR last_seen LIKE ?)'); binds.push(`%${q}%`, `%${q}%`); }
  if (status) { where.push('status = ?'); binds.push(status); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const total = ((await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM persons ${w}`).bind(...binds).first<any>())?.n) ?? 0;
  const { results } = await c.env.DB.prepare(
    `SELECT id, full_name, age, sex, last_seen, status, photo_url, contact_phone, notes, created_ms, updated_ms
     FROM persons ${w}
     ORDER BY (photo_url IS NOT NULL) DESC, updated_ms DESC
     LIMIT ? OFFSET ?`
  ).bind(...binds, limit, (page - 1) * limit).all<any>();

  const op = await isOperator(c);
  const persons = (results ?? []).map((p) =>
    op ? p : { ...p, contact_phone: p.contact_phone ? '•••••• (solo operadores)' : null }
  );
  return c.json({ persons, total, page, pages: Math.max(1, Math.ceil(total / limit)), limit });
});

// GET /api/familia/gallery?page=  — browse all missing-person photos
familia.get('/gallery', async (c) => {
  const page = Math.max(1, Number(c.req.query('page') || 1) || 1);
  const limit = Math.min(60, Math.max(1, Number(c.req.query('limit') || 30) || 30));
  const total = ((await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM persons WHERE photo_url IS NOT NULL`).first<any>())?.n) ?? 0;
  const { results } = await c.env.DB.prepare(
    `SELECT id, full_name, age, status, last_seen, photo_url FROM persons
     WHERE photo_url IS NOT NULL ORDER BY updated_ms DESC LIMIT ? OFFSET ?`
  ).bind(limit, (page - 1) * limit).all();
  return c.json({ photos: results ?? [], total, page, pages: Math.max(1, Math.ceil(total / limit)) });
});

// POST /api/familia/persons  — register (multipart with optional photo → R2)
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
    `INSERT INTO persons (id, full_name, age, sex, last_seen, status, contact_phone, notes, photo_url, reported_by, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, String(b.full_name).slice(0, 120), b.age ? Number(b.age) : null, b.sex ?? null,
    b.last_seen ? String(b.last_seen).slice(0, 200) : null, 'missing',
    b.contact_phone ? String(b.contact_phone).slice(0, 40) : null,
    b.notes ? String(b.notes).slice(0, 1000) : null, photo_url, b.reported_by ?? null, now, now
  ).run();
  return c.json({ ok: true, id, photo_url }, 201);
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

// PATCH /api/familia/persons/:id  — community status update (found_safe, etc.)
familia.patch('/persons/:id', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!['missing', 'found_safe', 'found_deceased', 'unknown'].includes(b.status)) return c.json({ error: 'bad_status' }, 400);
  await c.env.DB.prepare(`UPDATE persons SET status = ?, updated_ms = ? WHERE id = ?`)
    .bind(b.status, Date.now(), c.req.param('id')).run();
  return c.json({ ok: true });
});
