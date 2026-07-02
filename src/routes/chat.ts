import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { burstLimit } from '../lib/security';
import { sanitizeHtml } from '../lib/sanitize';
import { getUserFromRequest, isPrivilegedRole } from '../lib/auth';
import { scanFile } from '../security/file-scan';
import { maybeRespondOnMuro } from '../telegram/muro-responder';

// Community channel — verified-info chat + the "Muro Sísmico" wall (channel
// 'terremotos'). Public read/write. The wall adds: an anti-bot CAPTCHA + honeypot,
// optional photo attachments (validated + stored in KV PHOTOS), author ownership
// so a logged-in user can EDIT their own message, and per-message share pages.
export const chat = new Hono<{ Bindings: Env }>();

const MURO = 'terremotos';
const rndInt = (n: number) => crypto.getRandomValues(new Uint32Array(1))[0] % n;

// GET /api/chat?channel=general&since=<ms>
chat.get('/', async (c) => {
  const channel = c.req.query('channel') ?? 'general';
  const since = Number(c.req.query('since') ?? 0);
  const { results } = await c.env.DB.prepare(
    `SELECT id, channel, name, body, role, image_key, user_id, edited_ms, created_ms FROM chat_messages
     WHERE channel = ? AND flagged = 0 AND created_ms > ?
     ORDER BY created_ms DESC LIMIT 200`
  ).bind(channel, since).all();
  // expose only WHETHER a photo exists (not the raw key); ascending = natural chat order
  const rows = (results ?? []).map((m: any) => ({
    id: m.id, channel: m.channel, name: m.name, body: m.body, role: m.role,
    has_photo: !!m.image_key, user_id: m.user_id, edited_ms: m.edited_ms, created_ms: m.created_ms,
  }));
  return c.json(rows.reverse());
});

// GET /api/chat/captcha — one-time math challenge (anti-bot). Answer lives in KV
// for 5 min and is consumed on first correct use (replay-proof). No external deps.
chat.get('/captcha', async (c) => {
  c.header('Cache-Control', 'no-store');
  const a = rndInt(9) + 1, b = rndInt(9) + 1;
  const nonce = uid('cap');
  await c.env.CACHE.put(`cap:${nonce}`, String(a + b), { expirationTtl: 300 });
  return c.json({ nonce, question: `¿Cuánto es ${a} + ${b}?` });
});

// POST /api/chat — JSON or multipart/form-data (the latter may carry a "photo").
// The 'terremotos' wall enforces honeypot + CAPTCHA; all channels keep burst-limit
// + HTML sanitization. Logged-in authors get user_id (→ their message is editable).
chat.post('/', async (c) => {
  const burst = await burstLimit(c.env, c, 'chat_post');
  if (burst) return burst;

  // 1) read fields from multipart or JSON
  let name = '', body = '', channel = 'general', honeypot = '', capNonce = '', capAnswer = '';
  let photoBytes: Uint8Array | null = null, photoType = 'image/jpeg';
  const ctype = c.req.header('content-type') || '';
  if (ctype.includes('multipart/form-data')) {
    const form = await c.req.formData().catch(() => null);
    if (!form) return c.json({ error: 'form_invalida' }, 400);
    name = String(form.get('name') ?? '').trim();
    body = String(form.get('body') ?? '').trim();
    channel = String(form.get('channel') ?? 'general').trim();
    honeypot = String(form.get('website') ?? '').trim();
    capNonce = String(form.get('captcha_nonce') ?? '').trim();
    capAnswer = String(form.get('captcha_answer') ?? '').trim();
    const file = form.get('photo') as any;
    if (file && typeof file.arrayBuffer === 'function' && file.size > 0) {
      photoBytes = new Uint8Array(await file.arrayBuffer());
      photoType = file.type || photoType;
    }
  } else {
    const b = await c.req.json().catch(() => null);
    if (!b) return c.json({ error: 'json_required' }, 400);
    name = String(b.name ?? '').trim();
    body = String(b.body ?? '').trim();
    channel = String(b.channel ?? 'general').trim();
    honeypot = String(b.website ?? '').trim();
    capNonce = String(b.captcha_nonce ?? '').trim();
    capAnswer = String(b.captcha_answer ?? '').trim();
  }
  channel = channel.slice(0, 32) || 'general';

  // 2) anti-bot — only the public wall is hardened (other channels unchanged)
  if (channel === MURO) {
    // honeypot: real users never fill the hidden "website" field → drop silently
    if (honeypot) return c.json({ ok: true, id: uid('msg') }, 201);
    const want = capNonce ? await c.env.CACHE.get(`cap:${capNonce}`) : null;
    if (!want || want !== capAnswer) {
      return c.json({ error: 'captcha_failed', message: 'Respuesta incorrecta. Inténtalo de nuevo.' }, 400);
    }
    await c.env.CACHE.delete(`cap:${capNonce}`); // one-time use
  }

  // 3) content checks (a photo-only post is allowed)
  if (!body && !photoBytes) return c.json({ error: 'mensaje vacío' }, 400);
  if (body.length > 600) return c.json({ error: 'mensaje demasiado largo (máx 600)' }, 400);
  const safeBody = sanitizeHtml(body);

  // 4) optional photo — magic-byte/polyglot/size scan, then store in KV PHOTOS
  let imageKey: string | null = null;
  if (photoBytes) {
    const scan = await scanFile(photoBytes, { maxSize: 6_000_000, declaredMime: photoType, filename: 'photo', keyPrefix: 'muro/' });
    if (!scan.ok) return c.json({ error: 'foto_invalida', reason: scan.reason }, 415);
    imageKey = scan.safeKey!;
    await c.env.PHOTOS.put(imageKey, photoBytes, { metadata: { contentType: `image/${scan.detectedType}` } });
  }

  // 5) author identity — logged-in users own their message (editable) + may get a badge
  const me = await getUserFromRequest(c.env, c).catch(() => null);
  const displayName = (me?.name || name || 'Anónimo').slice(0, 60);
  const role = me && isPrivilegedRole(me.role) ? 'official' : 'citizen';

  const id = uid('msg');
  await c.env.DB.prepare(
    `INSERT INTO chat_messages (id, channel, name, body, role, image_key, user_id, flagged, created_ms)
     VALUES (?,?,?,?,?,?,?,0,?)`
  ).bind(id, channel, displayName, safeBody, role, imageKey, me?.id ?? null, Date.now()).run();

  // Wall bot: if the post looks like a person-search ("Busco a Maria Perez",
  // "¿Alguien ha visto a…?"), the bot answers ON the wall from verified data
  // (public-tier redaction). Background — never delays or fails the post.
  if (channel === MURO && safeBody) {
    c.executionCtx.waitUntil(
      maybeRespondOnMuro(c.env, { id, name: displayName, body: safeBody, userId: me?.id ?? null }).then(() => {})
    );
  }
  return c.json({ ok: true, id, hasPhoto: !!imageKey }, 201);
});

// GET /api/chat/photo/:id — serve a message's image from KV (image-only, nosniff).
chat.get('/photo/:id', async (c) => {
  const row: any = await c.env.DB.prepare(
    `SELECT image_key FROM chat_messages WHERE id = ? AND flagged = 0`
  ).bind(c.req.param('id')).first();
  if (!row?.image_key) return c.notFound();
  const obj = await c.env.PHOTOS.getWithMetadata<{ contentType?: string }>(row.image_key, 'arrayBuffer');
  if (!obj.value) return c.notFound();
  return new Response(obj.value, {
    headers: {
      'Content-Type': obj.metadata?.contentType || 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    },
  });
});

// PATCH /api/chat/:id — edit your OWN message (login required; operators may edit any).
chat.patch('/:id', async (c) => {
  const me = await getUserFromRequest(c.env, c).catch(() => null);
  if (!me) return c.json({ error: 'login_required', message: 'Inicia sesión para editar.' }, 401);
  const row: any = await c.env.DB.prepare(
    `SELECT id, user_id FROM chat_messages WHERE id = ? AND flagged = 0`
  ).bind(c.req.param('id')).first();
  if (!row) return c.json({ error: 'no_encontrado' }, 404);
  if (row.user_id !== me.id && !isPrivilegedRole(me.role)) return c.json({ error: 'no_autorizado' }, 403);
  const b = await c.req.json().catch(() => null);
  const body = String(b?.body ?? '').trim();
  if (!body) return c.json({ error: 'mensaje vacío' }, 400);
  if (body.length > 600) return c.json({ error: 'mensaje demasiado largo (máx 600)' }, 400);
  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE chat_messages SET body = ?, edited_ms = ? WHERE id = ?`
  ).bind(sanitizeHtml(body), now, row.id).run();
  return c.json({ ok: true, edited_ms: now });
});
