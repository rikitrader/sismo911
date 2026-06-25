import { Hono } from 'hono';
import type { Env } from '../types';
import { audit } from '../lib/audit';

export const acopio = new Hono<{ Bindings: Env }>();

const VALID = new Set(['operativo', 'saturado', 'cerrado']);

// Public: current operator-set status overrides for every center.
// Centers without a row default to "operativo" on the client.
acopio.get('/status', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, status, note, updated_ms FROM acopio_status`
  ).all();
  const status: Record<string, { status: string; note: string | null; updated_ms: number }> = {};
  for (const r of results ?? []) {
    status[(r as any).id] = {
      status: (r as any).status,
      note: (r as any).note,
      updated_ms: (r as any).updated_ms,
    };
  }
  return c.json({ status });
});

// Operator/admin only (gated in index.ts): set a center's live status.
acopio.patch('/status/:id', async (c) => {
  const id = c.req.param('id');
  if (!id || id.length > 120) return c.json({ error: 'bad_id' }, 400);
  const b = await c.req.json().catch(() => null);
  if (!b?.status || !VALID.has(b.status)) return c.json({ error: 'bad_status' }, 400);
  const note = b.note != null ? String(b.note).slice(0, 300) : null;
  await c.env.DB.prepare(
    `INSERT INTO acopio_status (id, status, note, updated_ms) VALUES (?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET status=excluded.status, note=excluded.note, updated_ms=excluded.updated_ms`
  ).bind(id, b.status, note, Date.now()).run();
  await audit(c, 'acopio.status', { id, status: b.status });
  return c.json({ ok: true, id, status: b.status, note, updated_ms: Date.now() });
});
