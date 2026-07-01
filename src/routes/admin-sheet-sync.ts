// SISMO911 — operator endpoint to drive the "Casos CRM" Google Sheet → D1 sync.
// The curated sheet is the source of truth; this pushes governed fields into D1
// (the fast serving layer). Every route gated by ops:console.
//   • POST /            → run ONE bounded field-sync pass (drains via KV cursor). ?dry=1 previews diffs.
//   • POST /dedup       → apply tight dedup merges from the Duplicados tab. ?dry=1 previews.
//   • POST /full?dry=1  → loop field passes to the end of the sheet (bounded), then dedup.
//   • POST /reset       → reset the drain cursor to the top.
//   • GET  /status      → last pass reconciliation.
import { Hono } from 'hono';
import type { Env } from '../types';
import { requirePermission } from '../rbac/middleware';
import { syncCasesFieldsPass, syncDedupMerges, lastSyncStatus } from '../sync/sheet-source';

export const adminSheetSync = new Hono<{ Bindings: Env }>();

adminSheetSync.get('/status', requirePermission('ops:console'), async (c) => {
  return c.json({ configured: !!c.env.CASES_SHEET_ID, last: await lastSyncStatus(c.env) });
});

adminSheetSync.post('/', requirePermission('ops:console'), async (c) => {
  const dry = c.req.query('dry') === '1';
  return c.json(await syncCasesFieldsPass(c.env, { dryRun: dry }));
});

adminSheetSync.post('/dedup', requirePermission('ops:console'), async (c) => {
  const dry = c.req.query('dry') === '1';
  return c.json(await syncDedupMerges(c.env, { dryRun: dry }));
});

adminSheetSync.post('/full', requirePermission('ops:console'), async (c) => {
  const dry = c.req.query('dry') === '1';
  if (!dry) await c.env.CACHE.put('sheetsync:cursor', '0');
  const passes: unknown[] = [];
  for (let i = 0; i < 30; i++) {                 // bounded: 30 × 4000 = 120k rows max
    const r = await syncCasesFieldsPass(c.env, { dryRun: dry });
    passes.push(r);
    if ((r as any).wrap || (r as any).scanned === 0) break;
  }
  const dedup = await syncDedupMerges(c.env, { dryRun: dry });
  return c.json({ passes: passes.length, dedup, last: passes[passes.length - 1] });
});

adminSheetSync.post('/reset', requirePermission('ops:console'), async (c) => {
  await c.env.CACHE.put('sheetsync:cursor', '0');
  return c.json({ ok: true, cursor: 0 });
});
