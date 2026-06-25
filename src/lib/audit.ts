import type { Context } from 'hono';
import type { Env } from '../types';
import { uid } from './db';
import { getUserFromRequest } from './auth';

export async function audit(c: Context<{ Bindings: Env }>, action: string, detail?: unknown) {
  const actor = await getUserFromRequest(c.env, c).catch(() => null);
  await c.env.DB.prepare(
    `INSERT INTO audit (id, actor, action, detail, created_ms) VALUES (?,?,?,?,?)`
  ).bind(
    uid('aud'),
    actor?.email ?? actor?.id ?? null,
    action,
    detail == null ? null : JSON.stringify(detail).slice(0, 2000),
    Date.now()
  ).run();
}
