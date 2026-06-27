import { Hono } from 'hono';
import type { Env } from '../types';
import { listEvents, getEvent } from '../lib/db';
import { getCachedEvents, ingestUsgs } from '../ingest/usgs-cron';
import { backfillUsgsHistory } from '../ingest/usgs-history';
import { estimatePager } from '../lib/pager';
import { scoreThreat } from '../lib/threat';
import { edgeCached } from '../lib/edge-cache';
import { rateLimit } from '../lib/security';

export const events = new Hono<{ Bindings: Env }>();

// GET /api/events?limit=100 — wrapped in a per-colo edge cache (Cache API, 30s)
// so the hot homepage feed collapses to ~1 D1 read per colo per 30s instead of
// one per request. (The old KV snapshot via getCachedEvents is still consulted
// on a cache miss — harmless if KV is down, used again once KV writes work.)
// `threat` is scored over ALL events so the "Estado Actual" badge is accurate
// even with limit=1.
events.get('/', async (c) => {
  const limit = Math.min(500, Number(c.req.query('limit') ?? 100));
  return edgeCached(c, 30, async () => {
    const cached = await getCachedEvents(c.env);
    if (cached?.events?.length) {
      return {
        source: 'cache', updated_ms: cached.updated_ms,
        threat: scoreThreat(cached.events, Date.now()),
        events: cached.events.slice(0, limit),
      };
    }
    let rows = await listEvents(c.env, limit);
    if (!rows.length) {
      // Cold start: pull live now so the first visitor isn't empty.
      try { await ingestUsgs(c.env); rows = await listEvents(c.env, limit); } catch { /* ignore */ }
    }
    return { source: 'd1', updated_ms: Date.now(), threat: scoreThreat(rows, Date.now()), events: rows };
  });
});

// GET /api/events/history — paginated historical archive from D1, with filters.
// Query: page, pageSize(≤100), minMag, from=YYYY-MM-DD, to=YYYY-MM-DD, q (place).
// Registered BEFORE /:id so "history" isn't captured as an event id.
// Data is backfilled into the events table by the operator-triggered
// backfillUsgsHistory (src/ingest/usgs-history.ts), wired in /admin.
events.get('/history', async (c) => {
  const limited = await rateLimit(c.env, c, 'events_history', 60, 60);
  if (limited) return limited;
  return edgeCached(c, 60, async () => {
  const page = Math.max(1, Number(c.req.query('page') ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(c.req.query('pageSize') ?? 30)));
  // Always hide cross-source duplicates from the public archive (canonical view).
  const w: string[] = ['dup_of IS NULL'];
  const b: unknown[] = [];
  const minMag = c.req.query('minMag');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const q = c.req.query('q');
  if (minMag && !Number.isNaN(Number(minMag))) { w.push('mag >= ?'); b.push(Number(minMag)); }
  if (from && !Number.isNaN(Date.parse(from))) { w.push('time_ms >= ?'); b.push(Date.parse(`${from}T00:00:00Z`)); }
  if (to && !Number.isNaN(Date.parse(to))) { w.push('time_ms < ?'); b.push(Date.parse(`${to}T00:00:00Z`) + 86_400_000); }
  if (q) { w.push('(place LIKE ? OR place_es LIKE ?)'); b.push(`%${q}%`, `%${q}%`); }
  const where = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const total = ((await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM events ${where}`).bind(...b).first<any>())?.n) ?? 0;
  const { results } = await c.env.DB.prepare(
    `SELECT id, mag, place, place_es, time_ms, lat, lon, depth_km, mmi, alert, tsunami, url
     FROM events ${where} ORDER BY time_ms DESC LIMIT ? OFFSET ?`
  ).bind(...b, pageSize, (page - 1) * pageSize).all();
  return { total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)), events: results ?? [] };
  });
});

// GET /api/events/:id — single event + provisional PAGER estimate.
events.get('/:id', async (c) => {
  const ev = await getEvent(c.env, c.req.param('id'));
  if (!ev) return c.json({ error: 'not_found' }, 404);
  return c.json({ event: ev, pager: estimatePager(ev as any) });
});

// POST /api/events/refresh — force an ingest (used by ops / cron fallback).
events.post('/refresh', async (c) => {
  try {
    const r = await ingestUsgs(c.env);
    return c.json({ ok: true, ...r });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) }, 502);
  }
});

// POST /api/events/backfill-run — Bearer-gated in-Worker historical backfill
// from USGS FDSNWS (the operator /admin button needs a session; this lets the
// same job be triggered headlessly + returns the BackfillReport so we can see
// whether FDSNWS is reachable from CF egress). Path is NOT under a guarded
// prefix (see ADMIN_WRITE_PREFIXES in index.ts) — it does its own auth.
// Body: { years?: number (≤60), minMag?: number }.
events.post('/backfill-run', async (c) => {
  const tok = (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!c.env.BLOG_INGEST_TOKEN || tok !== c.env.BLOG_INGEST_TOKEN) return c.json({ error: 'unauthorized' }, 401);
  const b: any = await c.req.json().catch(() => ({}));
  // KV runtime self-test: write a key from the Worker and read it back
  // immediately, then again so the caller can tell a genuine write failure from
  // eventual-consistency lag. Diagnoses why the CACHE namespace stays empty.
  if (b?.kvtest) {
    const key = `diag:kv-selftest`;
    const val = `worker-${Date.now()}`;
    let putError: string | null = null;
    try { await c.env.CACHE.put(key, val); } catch (e: any) { putError = String(e?.message ?? e); }
    const immediate = await c.env.CACHE.get(key).catch((e: any) => `GET_ERR:${e?.message ?? e}`);
    return c.json({ ok: true, kvtest: true, wrote: val, putError, immediateReadback: immediate, match: immediate === val });
  }
  try {
    const r = await backfillUsgsHistory(c.env, { years: b?.years, minMag: b?.minMag });
    return c.json({ ok: true, ...r });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) }, 502);
  }
});
