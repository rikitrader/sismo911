// Audit log for the live-GPS system: token issue/revoke + GPS ingest/reject.
// Hard rule: NEVER persist a raw token or other secret. We defensively strip any
// secret-looking keys from meta before writing.

import type { Env } from '../types';
import { uid } from './db';

const SECRET_KEYS = /^(token|secret|password|pwd|authorization|apikey|api_key)$/i;

function stripSecrets(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (SECRET_KEYS.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export interface AuditEntry {
  actorId?: string | null;
  unitId?: string | null;
  action: 'token.issue' | 'token.revoke' | 'gps.ingest' | 'gps.reject' | 'unit.create' | 'unit.update';
  meta?: Record<string, unknown>;
}

export async function audit(env: Env, e: AuditEntry): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO flota_audit_log (id, actor_id, unit_id, action, meta_json, created_at) VALUES (?,?,?,?,?,?)`
  ).bind(
    uid('aud'),
    e.actorId ?? null,
    e.unitId ?? null,
    e.action,
    e.meta ? JSON.stringify(stripSecrets(e.meta)) : null,
    Date.now(),
  ).run();
}
