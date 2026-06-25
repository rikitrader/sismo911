import { Hono } from 'hono';
import type { Env } from '../types';
import { dedupePersonas, type DedupeMode } from '../lib/dedupe';
import { cleanPersonas } from '../lib/clean';
import { ingestFamilia } from '../ingest/familia-cron';
import { backfillUsgsHistory } from '../ingest/usgs-history';
import { audit } from '../lib/audit';

export const admin = new Hono<{ Bindings: Env }>();

// Operator/admin only (gated in index.ts via ADMIN_WRITE_PREFIXES '/api/admin').
// Body: { mode?: 'exact'|'loose'|'photo', apply?: boolean, limit?: number }.
//   exact → same name+age+location+description+contact (true re-scrapes)
//   photo → same photo URL (same image reused across records)
//   loose → same name+location only (may merge namesakes — review before apply)
//   apply=false → dry-run report (counts only, deletes nothing)
//   apply=true  → delete up to `limit` (≤400) duplicate rows + their R2 photos
admin.post('/dedupe-personas', async (c) => {
  const b: any = await c.req.json().catch(() => ({}));
  const mode: DedupeMode = b?.mode === 'loose' ? 'loose' : b?.mode === 'photo' ? 'photo' : 'exact';
  const r = await dedupePersonas(c.env, { mode, apply: !!b?.apply, limit: b?.limit });
  if (r.applied) await audit(c, 'personas.dedupe', r);
  return c.json(r);
});

// Flag corrupted / fake / junk-name personas as moderation='rejected' (hidden
// from public reads). Body: { apply?: boolean }. apply=false → count only.
admin.post('/clean-personas', async (c) => {
  const b: any = await c.req.json().catch(() => ({}));
  const r = await cleanPersonas(c.env, { apply: !!b?.apply });
  if (r.applied) await audit(c, 'personas.clean', r);
  return c.json(r);
});

// Manual trigger: pull one bounded window of pages from FAMILIA_SOURCE_URL now
// (the hourly cron does this automatically + cleans). Returns rows upserted.
admin.post('/pull-familia', async (c) => {
  const upserted = await ingestFamilia(c.env);
  await audit(c, 'personas.pull', { upserted });
  return c.json({ upserted });
});

// Backfill the historical seismic archive from USGS FDSN (years of VE events).
// Body: { years?: number (≤60), minMag?: number }. Idempotent (upsert-by-id).
admin.post('/backfill-history', async (c) => {
  const b: any = await c.req.json().catch(() => ({}));
  const r = await backfillUsgsHistory(c.env, { years: b?.years, minMag: b?.minMag });
  await audit(c, 'events.backfill', r);
  return c.json(r);
});
