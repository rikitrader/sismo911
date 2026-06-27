import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { rateLimit, nameHasSpam, textHasLink } from '../lib/security';
import { getUserFromRequest } from '../lib/auth';
import { audit } from '../lib/audit';

// SUPER BANNER EMERGENCY PROFILES — a curated, GoFundMe-style spotlight for a
// single person in urgent need. Full bio + photo gallery + video + viral share
// CTA. The /emergencia page rotates featured profiles "billboard" style.
//
// AUTHORITY: there is NO public write path. Create/edit/upload/retire are
// operator/admin only — enforced both by the global gate (ADMIN_WRITE_PREFIXES
// in src/index.ts) AND belt-and-suspenders here. The ONLY public writes are
// view counting (on detail GET) and the share-counter bump (rate-limited).

export const emergencia = new Hono<{ Bindings: Env }>();

const NEED_TYPES = ['medico', 'rescate', 'desplazado', 'duelo', 'reconstruccion', 'otro'];
const STATUSES = ['active', 'paused', 'resolved', 'archived'];
const PUBLIC_STATUSES = ['active', 'resolved'];

const clamp = (s: any, n: number) => String(s ?? '').slice(0, n);
const isOp = (u: any) => !!u && (u.role === 'operator' || u.role === 'admin');
const num = (v: any): number | null => (v === '' || v === null || v === undefined || isNaN(Number(v)) ? null : Number(v));

// URL-safe slug from a name; suffixed with a short id so it is always unique.
function slugify(name: string): string {
  const base = String(name || 'perfil')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip accents
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 48) || 'perfil';
  return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}

const photoUrl = (p: any) => (p.r2_key ? `/api/emergencia/photo/${p.id}` : (p.url || null));

// Shape a profile row + its photos for the client.
async function serialize(c: any, row: any, op: boolean) {
  const { results: photos } = await c.env.DB.prepare(
    `SELECT id, kind, r2_key, url, caption, sort FROM emergency_photos WHERE profile_id = ? ORDER BY sort ASC, created_ms ASC`,
  ).bind(row.id).all();
  const gallery = (photos ?? []).map((p: any) => ({ id: p.id, kind: p.kind, caption: p.caption || null, src: photoUrl(p) })).filter((p: any) => p.src);
  const heroRow = (photos ?? []).find((p: any) => p.kind === 'hero');
  const hero = row.hero_url || (heroRow ? photoUrl(heroRow) : (gallery[0]?.src ?? null));
  return {
    id: row.id, slug: row.slug, name: row.name, age: row.age ?? null, location: row.location || null,
    headline: row.headline || null, bio: row.bio || null, need_type: row.need_type || 'otro',
    goal_amount: row.goal_amount ?? null, raised_amount: row.raised_amount ?? 0, currency: row.currency || 'USD',
    campaign_id: row.campaign_id || null, video_url: row.video_url || null, hero,
    contact: op ? (row.contact || null) : null, cta_url: row.cta_url || null, cta_label: row.cta_label || null,
    status: row.status, featured: !!row.featured, priority: row.priority ?? 0, rotation_secs: row.rotation_secs ?? 8,
    views: row.views ?? 0, shares: row.shares ?? 0, updated_ms: row.updated_ms, gallery,
  };
}

// GET /api/emergencia — public list of visible profiles (billboard + grid).
// Operators get every status; the public sees only active/resolved.
emergencia.get('/', async (c) => {
  const user = await getUserFromRequest(c.env, c).catch(() => null);
  const op = isOp(user);
  const where = op ? `status != 'archived'` : `status IN ('active','resolved')`;
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM emergency_profiles WHERE ${where} ORDER BY (status='active') DESC, priority DESC, updated_ms DESC LIMIT 60`,
  ).all();
  const profiles = await Promise.all((results ?? []).map((r: any) => serialize(c, r, op)));
  return c.json({ ok: true, operator: op, profiles }, 200, { 'Cache-Control': 'no-store' });
});

// GET /api/emergencia/admin — every profile incl. paused/archived (operator only).
emergencia.get('/admin', async (c) => {
  const user = await getUserFromRequest(c.env, c).catch(() => null);
  if (!isOp(user)) return c.json({ error: 'unauthorized' }, 401);
  const { results } = await c.env.DB.prepare(`SELECT * FROM emergency_profiles ORDER BY updated_ms DESC LIMIT 200`).all();
  const profiles = await Promise.all((results ?? []).map((r: any) => serialize(c, r, true)));
  return c.json({ ok: true, profiles }, 200, { 'Cache-Control': 'no-store' });
});

// GET /api/emergencia/photo/:id — serve a gallery image from R2, fall back to URL.
emergencia.get('/photo/:id', async (c) => {
  const row: any = await c.env.DB.prepare(`SELECT r2_key, url FROM emergency_photos WHERE id = ?`).bind(c.req.param('id')).first();
  if (!row) return c.notFound();
  if (row.r2_key) {
    const obj = await c.env.PERSON_PHOTOS.get(row.r2_key);
    if (obj) return new Response(obj.body, {
      headers: { 'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' },
    });
  }
  if (row.url) return c.redirect(row.url, 302);
  return c.notFound();
});

// Look up a profile by slug OR id (shareable links use the slug).
async function findProfile(c: any, key: string) {
  return c.env.DB.prepare(`SELECT * FROM emergency_profiles WHERE slug = ? OR id = ? LIMIT 1`).bind(key, key).first();
}

// GET /api/emergencia/:key — full public profile detail (by slug or id). Bumps views.
emergencia.get('/:key', async (c) => {
  const user = await getUserFromRequest(c.env, c).catch(() => null);
  const op = isOp(user);
  const row: any = await findProfile(c, c.req.param('key'));
  if (!row || (!op && !PUBLIC_STATUSES.includes(row.status))) return c.json({ error: 'not_found' }, 404);
  // Best-effort, non-blocking view count (public reads only). c.executionCtx is a
  // getter that throws when there is no ExecutionContext (e.g. unit tests) — guard it.
  if (!op) {
    const upd = c.env.DB.prepare(`UPDATE emergency_profiles SET views = views + 1 WHERE id = ?`).bind(row.id).run().catch(() => {});
    try { (c.executionCtx as any)?.waitUntil?.(upd); } catch { /* no ctx — fire and forget */ }
  }
  return c.json({ ok: true, operator: op, profile: await serialize(c, row, op) }, 200, { 'Cache-Control': 'no-store' });
});

// POST /api/emergencia/:key/share — public, rate-limited share-counter bump.
emergencia.post('/:key/share', async (c) => {
  const limited = await rateLimit(c.env, c, 'emerg_share', 30, 600);
  if (limited) return c.json({ error: 'rate_limited' }, 429);
  const row: any = await findProfile(c, c.req.param('key'));
  if (!row) return c.json({ error: 'not_found' }, 404);
  await c.env.DB.prepare(`UPDATE emergency_profiles SET shares = shares + 1 WHERE id = ?`).bind(row.id).run();
  return c.json({ ok: true, shares: (row.shares ?? 0) + 1 }, 201);
});

// Validate + normalize the writable body of a profile (shared by create/patch).
function readBody(b: any) {
  const name = clamp(b.name, 120).trim();
  const need_type = NEED_TYPES.includes(String(b.need_type || '').toLowerCase()) ? String(b.need_type).toLowerCase() : 'otro';
  const status = STATUSES.includes(String(b.status || '').toLowerCase()) ? String(b.status).toLowerCase() : 'active';
  return {
    name,
    need_type, status,
    age: num(b.age),
    location: clamp(b.location, 160).trim() || null,
    headline: clamp(b.headline, 160).trim() || null,
    bio: clamp(b.bio, 8000).trim() || null,
    goal_amount: num(b.goal_amount),
    raised_amount: num(b.raised_amount) ?? 0,
    currency: clamp(b.currency, 8).trim().toUpperCase() || 'USD',
    campaign_id: clamp(b.campaign_id, 64).trim() || null,
    video_url: clamp(b.video_url, 600).trim() || null,
    hero_url: clamp(b.hero_url, 600).trim() || null,
    contact: clamp(b.contact, 200).trim() || null,
    cta_url: clamp(b.cta_url, 600).trim() || null,
    cta_label: clamp(b.cta_label, 60).trim() || null,
    featured: b.featured === false || b.featured === 0 || b.featured === '0' ? 0 : 1,
    priority: Math.max(0, Math.min(1000, num(b.priority) ?? 0)),
    rotation_secs: Math.max(3, Math.min(60, num(b.rotation_secs) ?? 8)),
  };
}

// POST /api/emergencia — create a profile (operator/admin only).
emergencia.post('/', async (c) => {
  const user = await getUserFromRequest(c.env, c).catch(() => null);
  if (!isOp(user)) return c.json({ error: 'unauthorized' }, 401);
  let b: any = {};
  try { b = await c.req.json(); } catch { return c.json({ error: 'bad_json' }, 400); }
  const v = readBody(b);
  if (!v.name) return c.json({ error: 'empty', hint: 'El nombre es obligatorio.' }, 400);
  if (nameHasSpam(v.name) || textHasLink(v.headline)) return c.json({ error: 'spam' }, 400);

  const id = uid('emg');
  const slug = slugify(v.name);
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO emergency_profiles
       (id, slug, name, age, location, headline, bio, need_type, goal_amount, raised_amount, currency,
        campaign_id, video_url, hero_url, contact, cta_url, cta_label, status, featured, priority, rotation_secs,
        views, shares, created_ms, updated_ms, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?,?)`,
  ).bind(id, slug, v.name, v.age, v.location, v.headline, v.bio, v.need_type, v.goal_amount, v.raised_amount, v.currency,
    v.campaign_id, v.video_url, v.hero_url, v.contact, v.cta_url, v.cta_label, v.status, v.featured, v.priority, v.rotation_secs,
    now, now, user!.email || user!.id || 'operator').run();
  await audit(c, 'emergencia.create', { id, slug, need_type: v.need_type });
  return c.json({ ok: true, id, slug }, 201);
});

// PATCH /api/emergencia/:id — edit a profile (operator/admin only).
emergencia.patch('/:id', async (c) => {
  const user = await getUserFromRequest(c.env, c).catch(() => null);
  if (!isOp(user)) return c.json({ error: 'unauthorized' }, 401);
  const id = c.req.param('id');
  const exists = await c.env.DB.prepare(`SELECT id FROM emergency_profiles WHERE id = ?`).bind(id).first();
  if (!exists) return c.json({ error: 'not_found' }, 404);
  let b: any = {};
  try { b = await c.req.json(); } catch { return c.json({ error: 'bad_json' }, 400); }
  const v = readBody(b);
  if (!v.name) return c.json({ error: 'empty' }, 400);
  await c.env.DB.prepare(
    `UPDATE emergency_profiles SET name=?, age=?, location=?, headline=?, bio=?, need_type=?, goal_amount=?,
       raised_amount=?, currency=?, campaign_id=?, video_url=?, hero_url=?, contact=?, cta_url=?, cta_label=?,
       status=?, featured=?, priority=?, rotation_secs=?, updated_ms=? WHERE id=?`,
  ).bind(v.name, v.age, v.location, v.headline, v.bio, v.need_type, v.goal_amount, v.raised_amount, v.currency,
    v.campaign_id, v.video_url, v.hero_url, v.contact, v.cta_url, v.cta_label, v.status, v.featured, v.priority,
    v.rotation_secs, Date.now(), id).run();
  await audit(c, 'emergencia.update', { id, status: v.status });
  return c.json({ ok: true, id });
});

// DELETE /api/emergencia/:id — archive (soft) or ?hard=1 to purge + drop photos.
emergencia.delete('/:id', async (c) => {
  const user = await getUserFromRequest(c.env, c).catch(() => null);
  if (!isOp(user)) return c.json({ error: 'unauthorized' }, 401);
  const id = c.req.param('id');
  if (c.req.query('hard') === '1') {
    const { results } = await c.env.DB.prepare(`SELECT r2_key FROM emergency_photos WHERE profile_id = ? AND r2_key IS NOT NULL`).bind(id).all();
    for (const r of (results ?? []) as any[]) await c.env.PERSON_PHOTOS.delete(r.r2_key).catch(() => {});
    await c.env.DB.batch([
      c.env.DB.prepare(`DELETE FROM emergency_photos WHERE profile_id = ?`).bind(id),
      c.env.DB.prepare(`DELETE FROM emergency_profiles WHERE id = ?`).bind(id),
    ]);
    await audit(c, 'emergencia.delete.hard', { id });
    return c.json({ ok: true, deleted: true });
  }
  await c.env.DB.prepare(`UPDATE emergency_profiles SET status='archived', featured=0, updated_ms=? WHERE id=?`).bind(Date.now(), id).run();
  await audit(c, 'emergencia.archive', { id });
  return c.json({ ok: true, archived: true });
});

// POST /api/emergencia/:id/photo — upload a photo to R2 (operator/admin only).
// multipart/form-data: file=<binary>, kind=hero|gallery, caption=<text>.
emergencia.post('/:id/photo', async (c) => {
  const user = await getUserFromRequest(c.env, c).catch(() => null);
  if (!isOp(user)) return c.json({ error: 'unauthorized' }, 401);
  const id = c.req.param('id');
  const profile = await c.env.DB.prepare(`SELECT id FROM emergency_profiles WHERE id = ?`).bind(id).first();
  if (!profile) return c.json({ error: 'not_found' }, 404);

  let form: FormData;
  try { form = await c.req.formData(); } catch { return c.json({ error: 'bad_form' }, 400); }
  const file = form.get('file') as any;
  const kind = String(form.get('kind') || 'gallery') === 'hero' ? 'hero' : 'gallery';
  const caption = clamp(form.get('caption'), 200).trim() || null;
  const urlOnly = clamp(form.get('url'), 600).trim() || null;

  const photoId = uid('emp');
  const now = Date.now();
  let r2_key: string | null = null;

  if (file && typeof file !== 'string' && typeof file.arrayBuffer === 'function') {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > 8 * 1024 * 1024) return c.json({ error: 'too_large', hint: 'Máx 8 MB.' }, 413);
    const ctype = file.type || 'image/jpeg';
    if (!ctype.startsWith('image/')) return c.json({ error: 'not_image' }, 415);
    r2_key = `emergencia/${id}/${photoId}`;
    await c.env.PERSON_PHOTOS.put(r2_key, bytes, { httpMetadata: { contentType: ctype } });
  } else if (!urlOnly) {
    return c.json({ error: 'no_file', hint: 'Adjunta una imagen o una URL.' }, 400);
  }

  // Only one hero per profile — clear the previous hero flag.
  if (kind === 'hero') {
    await c.env.DB.prepare(`UPDATE emergency_photos SET kind='gallery' WHERE profile_id = ? AND kind='hero'`).bind(id).run();
  }
  await c.env.DB.prepare(
    `INSERT INTO emergency_photos (id, profile_id, kind, r2_key, url, caption, sort, created_ms) VALUES (?,?,?,?,?,?,?,?)`,
  ).bind(photoId, id, kind, r2_key, r2_key ? null : urlOnly, caption, kind === 'hero' ? 0 : now, now).run();
  await c.env.DB.prepare(`UPDATE emergency_profiles SET updated_ms = ? WHERE id = ?`).bind(now, id).run();
  await audit(c, 'emergencia.photo.add', { id, photoId, kind });
  return c.json({ ok: true, id: photoId, kind, src: r2_key ? `/api/emergencia/photo/${photoId}` : urlOnly }, 201);
});

// DELETE /api/emergencia/:id/photo/:pid — remove a photo (operator/admin only).
emergencia.delete('/:id/photo/:pid', async (c) => {
  const user = await getUserFromRequest(c.env, c).catch(() => null);
  if (!isOp(user)) return c.json({ error: 'unauthorized' }, 401);
  const pid = c.req.param('pid');
  const row: any = await c.env.DB.prepare(`SELECT r2_key FROM emergency_photos WHERE id = ? AND profile_id = ?`).bind(pid, c.req.param('id')).first();
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.r2_key) await c.env.PERSON_PHOTOS.delete(row.r2_key).catch(() => {});
  await c.env.DB.prepare(`DELETE FROM emergency_photos WHERE id = ?`).bind(pid).run();
  await audit(c, 'emergencia.photo.delete', { pid });
  return c.json({ ok: true });
});
