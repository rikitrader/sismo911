import { Hono } from 'hono';
import type { Env } from '../types';
import { listEvents, getEvent } from '../lib/db';
import { getCachedEvents, ingestUsgs } from '../ingest/usgs-cron';
import { estimatePager } from '../lib/pager';
import { scoreThreat } from '../lib/threat';

export const events = new Hono<{ Bindings: Env }>();

// GET /api/events?limit=100 — KV hot-path, falls back to D1, then live USGS.
// `threat` is scored over ALL events (not the limited slice) so the homepage
// "Estado Actual" badge is accurate even with limit=1.
events.get('/', async (c) => {
  const limit = Math.min(500, Number(c.req.query('limit') ?? 100));
  const cached = await getCachedEvents(c.env);
  if (cached?.events?.length) {
    return c.json({
      source: 'cache', updated_ms: cached.updated_ms,
      threat: scoreThreat(cached.events, Date.now()),
      events: cached.events.slice(0, limit),
    });
  }
  let rows = await listEvents(c.env, limit);
  if (!rows.length) {
    // Cold start: pull live now so the first visitor isn't empty.
    try { await ingestUsgs(c.env); rows = await listEvents(c.env, limit); } catch { /* ignore */ }
  }
  return c.json({ source: 'd1', updated_ms: Date.now(), threat: scoreThreat(rows, Date.now()), events: rows });
});

// GET /api/events/history — paginated historical archive from D1, with filters.
// Query: page, pageSize(≤100), minMag, from=YYYY-MM-DD, to=YYYY-MM-DD, q (place).
// Registered BEFORE /:id so "history" isn't captured as an event id.
// Data is backfilled into the events table by the operator-triggered
// backfillUsgsHistory (src/ingest/usgs-history.ts), wired in /admin.
events.get('/history', async (c) => {
  const page = Math.max(1, Number(c.req.query('page') ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(c.req.query('pageSize') ?? 30)));
  const w: string[] = [];
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
  return c.json({ total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)), events: results ?? [] });
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
