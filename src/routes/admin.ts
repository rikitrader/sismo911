import { Hono } from 'hono';
import type { Env } from '../types';
import { dedupePersonas } from '../lib/dedupe';
import { audit } from '../lib/audit';

export const admin = new Hono<{ Bindings: Env }>();

// Operator/admin only (gated in index.ts via ADMIN_WRITE_PREFIXES '/api/admin').
// Body: { mode?: 'exact'|'loose', apply?: boolean, limit?: number }.
//   apply=false → dry-run report (counts only, deletes nothing)
//   apply=true  → delete up to `limit` (≤400) duplicate rows + their R2 photos
admin.post('/dedupe-personas', async (c) => {
  const b: any = await c.req.json().catch(() => ({}));
  const mode = b?.mode === 'loose' ? 'loose' : 'exact';
  const r = await dedupePersonas(c.env, { mode, apply: !!b?.apply, limit: b?.limit });
  if (r.applied) await audit(c, 'personas.dedupe', r);
  return c.json(r);
});
