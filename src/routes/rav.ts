import { Hono } from 'hono';
import type { Env } from '../types';
import { ingestRav, ingestRavStats, ingestRavVerified } from '../ingest/rav-cron';
import { analyzeRavPhotos } from '../ingest/rav-photos';
import { cleanPersonas } from '../lib/clean';
import { dedupePersonas } from '../lib/dedupe';

// redayudavenezuela.com (RAV) surface:
//   POST /api/rav/run     — Bearer-gated backfill/ingest driver (used by scripts/pull-rav.mjs)
//   GET  /api/stats/official  — public live casualty counter
//   GET  /api/verified-info   — public verified-news feed
// The page /informacion-verificada is a static asset (public/…html) served by ASSETS.
//
// /api/rav/* is intentionally NOT under /api/admin/* (the global guard force-401s
// those before the route runs) — it carries its own Bearer check, like /api/blog/run.

export const rav = new Hono<{ Bindings: Env }>();

function authed(c: any): boolean {
  const tok = (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  const expected = c.env.RAV_INGEST_TOKEN || c.env.BLOG_INGEST_TOKEN; // reuse blog token if RAV-specific not set
  return !!expected && tok === expected;
}

// POST /api/rav/run?kind=persons|stats|verified|all&pages=N
// Drives ingest server-side (uses the Worker's D1 binding — the local wrangler
// token is read-only on D1). Returns progress so the backfill script can loop
// until the persons cursor wraps to 0.
rav.post('/api/rav/run', async (c) => {
  if (!authed(c)) return c.json({ error: 'unauthorized' }, 401);
  const kind = (c.req.query('kind') || 'persons').toLowerCase();
  const pages = Math.min(Math.max(Number(c.req.query('pages')) || 5, 1), 25);
  const photoBatch = Math.min(Math.max(Number(c.req.query('batch')) || 24, 1), 25);
  const out: Record<string, unknown> = { kind };
  try {
    if (kind === 'stats' || kind === 'all') out.stats = await ingestRavStats(c.env);
    if (kind === 'verified' || kind === 'all') out.verified = await ingestRavVerified(c.env);
    if (kind === 'persons' || kind === 'all') out.persons = await ingestRav(c.env, pages);
    if (kind === 'photos' || kind === 'all') out.photos = await analyzeRavPhotos(c.env, photoBatch);
    if (c.req.query('clean')) out.cleaned = await cleanPersonas(c.env, { apply: true });
    if (c.req.query('dedupe')) {
      // Namesake-safe modes only (omit `loose` = name+location, which can merge
      // two distinct people): exact match, same photo URL, same name+age+phone,
      // same image content-hash. These collapse cross-source (RAV↔theempire) dups.
      const modes = ['exact', 'photo', 'fuzzyphone', 'phash'] as const;
      out.dedupe = {};
      for (const m of modes) (out.dedupe as any)[m] = await dedupePersonas(c.env, { mode: m, apply: true, limit: 400 });
    }
    return c.json({ ok: true, ...out });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e), ...out }, 500);
  }
});

// GET /api/stats/official — single-row casualty counter (public).
rav.get('/api/stats/official', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT fallecidos, heridos, refugiados, desaparecidos, source, origen, updated_at, pulled_at
     FROM official_stats WHERE id = 1`,
  ).first();
  return c.json({ ok: true, stats: row ?? null }, 200, { 'Cache-Control': 'public, max-age=120' });
});

// GET /api/verified-info?topic=&limit= — verified-news feed (public).
rav.get('/api/verified-info', async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 144);
  const topic = (c.req.query('topic') || '').trim().toLowerCase();
  const where = topic ? `WHERE lower(coalesce(topic,'')) = ?` : '';
  const stmt = c.env.DB.prepare(
    `SELECT id, source, title, body, url, topic, tags, published_at
     FROM verified_info ${where} ORDER BY published_at DESC LIMIT ?`,
  );
  const { results } = await (topic ? stmt.bind(topic, limit) : stmt.bind(limit)).all();
  return c.json({ ok: true, items: results ?? [], total: results?.length ?? 0 }, 200, { 'Cache-Control': 'public, max-age=120' });
});
