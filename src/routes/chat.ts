import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { rateLimit } from '../lib/security';

// Community channel — verified-info chat. Public read/write; lightweight guards.
export const chat = new Hono<{ Bindings: Env }>();

// GET /api/chat?channel=general&since=<ms>
chat.get('/', async (c) => {
  const channel = c.req.query('channel') ?? 'general';
  const since = Number(c.req.query('since') ?? 0);
  const { results } = await c.env.DB.prepare(
    `SELECT id, channel, name, body, role, created_ms FROM chat_messages
     WHERE channel = ? AND flagged = 0 AND created_ms > ?
     ORDER BY created_ms DESC LIMIT 200`
  ).bind(channel, since).all();
  // return ascending for natural chat order
  return c.json((results ?? []).reverse());
});

// POST /api/chat  { name, body, channel? }
chat.post('/', async (c) => {
  const limited = await rateLimit(c.env, c, 'chat_post', 30, 300);
  if (limited) return limited;
  const b = await c.req.json().catch(() => null);
  const body = (b?.body ?? '').trim();
  if (!body) return c.json({ error: 'mensaje vacío' }, 400);
  if (body.length > 600) return c.json({ error: 'mensaje demasiado largo (máx 600)' }, 400);
  const id = uid('msg');
  await c.env.DB.prepare(
    `INSERT INTO chat_messages (id, channel, name, body, role, flagged, created_ms)
     VALUES (?,?,?,?,?,0,?)`
  ).bind(id, (b.channel ?? 'general').slice(0, 32), (b.name ?? 'Anónimo').slice(0, 60), body, 'citizen', Date.now()).run();
  return c.json({ ok: true, id }, 201);
});
