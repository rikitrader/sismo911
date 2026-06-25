import { Hono } from 'hono';
import type { Env } from '../types';
import { listEvents, getEvent } from '../lib/db';
import { getCachedEvents, ingestUsgs } from '../ingest/usgs-cron';
import { estimatePager } from '../lib/pager';

export const events = new Hono<{ Bindings: Env }>();

// GET /api/events?limit=100 — KV hot-path, falls back to D1, then live USGS.
events.get('/', async (c) => {
  const limit = Math.min(500, Number(c.req.query('limit') ?? 100));
  const cached = await getCachedEvents(c.env);
  if (cached?.events?.length) {
    return c.json({ source: 'cache', updated_ms: cached.updated_ms, events: cached.events.slice(0, limit) });
  }
  let rows = await listEvents(c.env, limit);
  if (!rows.length) {
    // Cold start: pull live now so the first visitor isn't empty.
    try { await ingestUsgs(c.env); rows = await listEvents(c.env, limit); } catch { /* ignore */ }
  }
  return c.json({ source: 'd1', updated_ms: Date.now(), events: rows });
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
