import { Hono } from 'hono';
import type { Env } from '../types';
import { dedupePersonas, type DedupeMode } from '../lib/dedupe';
import { cleanPersonas } from '../lib/clean';
import { ingestFamilia } from '../ingest/familia-cron';
import { backfillUsgsHistory } from '../ingest/usgs-history';
import { sweepCaseScores } from '../lib/case-score-sync';
import { audit } from '../lib/audit';
import { getUserFromRequest } from '../lib/auth';

export const admin = new Hono<{ Bindings: Env }>();

// Manual trigger for the autonomous case re-scoring sweep (the hourly cron runs
// it automatically). Body: { famLimit?: number } — size of the familia batch this
// tick. Returns { native, familia, changed }.
admin.post('/rescore-cases', async (c) => {
  const b: any = await c.req.json().catch(() => ({}));
  const r = await sweepCaseScores(c.env, { famLimit: b?.famLimit });
  await audit(c, 'cases.rescore', r);
  return c.json(r);
});

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

// GET /api/admin/spam-stats — operator alert: blocked-spam counts from the audit
// log (today / last 7d / total + top offending IP). GET is not write-gated by the
// index.ts middleware, so it self-gates here.
admin.get('/spam-stats', async (c) => {
  const me = await getUserFromRequest(c.env, c).catch(() => null);
  if (!me || (me.role !== 'operator' && me.role !== 'admin')) return c.json({ error: 'unauthorized' }, 401);
  const dayMs = 86_400_000, now = Date.now();
  const todayStart = now - (now % dayMs), wk = now - 7 * dayMs;
  const count = async (since?: number) => {
    const sql = since == null
      ? `SELECT COUNT(*) AS n FROM audit WHERE action='spam_blocked'`
      : `SELECT COUNT(*) AS n FROM audit WHERE action='spam_blocked' AND created_ms>=?`;
    const stmt = since == null ? c.env.DB.prepare(sql) : c.env.DB.prepare(sql).bind(since);
    const r = await stmt.first<any>().catch(() => null);
    return Number(r?.n ?? 0);
  };
  const top = await c.env.DB.prepare(
    `SELECT json_extract(detail,'$.ip') AS ip, COUNT(*) AS c FROM audit
      WHERE action='spam_blocked' AND created_ms>=? AND json_extract(detail,'$.ip') IS NOT NULL
      GROUP BY ip ORDER BY c DESC LIMIT 1`
  ).bind(wk).first<any>().catch(() => null);
  return c.json(
    { today: await count(todayStart), last7d: await count(wk), total: await count(), topIp: top?.ip ?? null },
    200, { 'Cache-Control': 'no-store' }
  );
});
