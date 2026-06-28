import type { Context } from 'hono';
import type { Env } from '../types';
import { uid } from './db';
import { getUserFromRequest } from './auth';

export async function audit(c: Context<{ Bindings: Env }>, action: string, detail?: unknown) {
  const actor = await getUserFromRequest(c.env, c).catch(() => null);
  // Enrich every audit entry with the request IP + the actor's role so the log
  // answers who/what/when/from-where for each privileged action. (Stored inside
  // the structured `detail` JSON — queryable via json_extract — so no schema
  // change is needed and existing audit rows stay valid.)
  const ip =
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown';
  const base = detail && typeof detail === 'object' ? (detail as Record<string, unknown>)
    : detail != null ? { value: detail } : {};
  const enriched = { ...base, ip, actor_role: actor?.role ?? null };
  await c.env.DB.prepare(
    `INSERT INTO audit (id, actor, action, detail, created_ms) VALUES (?,?,?,?,?)`
  ).bind(
    uid('aud'),
    actor?.email ?? actor?.id ?? null,
    action,
    JSON.stringify(enriched).slice(0, 2000),
    Date.now()
  ).run();
}
