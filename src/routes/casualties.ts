import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { gateCasualty } from '../ingest/casualty-gate';
import { CURRENT_EVENT_ID } from '../ingest/casualty-cron';

// VÍCTIMAS / FALLECIDOS (/api/casualties) — multi-source casualty ledger.
// Reads are PUBLIC (the dashboard + any consumer). The manual-entry write is
// operator-gated centrally in route-policy.ts (/api/casualties → admin:maintenance).
//
// Design: we never publish a single "truth" number. Each (source, metric) row is
// returned with its tier, confidence, citation and as_of, plus a COMPUTED RANGE
// per metric (low = min value_min; high = max value_max||value_min; best =
// highest-confidence point estimate). The UI renders the spread, not one figure.
export const casualties = new Hono<{ Bindings: Env }>();

const resolveEvent = (e: string | undefined) => (!e || e === 'latest' ? CURRENT_EVENT_ID : e);

interface Row {
  source_key: string; metric: string; value_min: number; value_max: number | null;
  as_of_ms: number; confidence: number; citation_url: string | null; note: string | null;
  name: string; tier: number; kind: string;
}

/** Latest figure per (source, metric) for an event, joined with the source registry. */
async function latestRows(env: Env, eventId: string): Promise<Row[]> {
  const { results } = await env.DB.prepare(
    `SELECT r.source_key, r.metric, r.value_min, r.value_max, r.as_of_ms, r.confidence,
            r.citation_url, r.note,
            COALESCE(s.name, r.source_key) AS name,
            COALESCE(s.tier, 3) AS tier,
            COALESCE(s.kind, 'social') AS kind
     FROM casualty_reports r
     JOIN (SELECT source_key, metric, MAX(as_of_ms) AS m
           FROM casualty_reports WHERE event_id = ? GROUP BY source_key, metric) latest
       ON r.source_key = latest.source_key AND r.metric = latest.metric AND r.as_of_ms = latest.m
     LEFT JOIN casualty_sources s ON s.source_key = r.source_key
     WHERE r.event_id = ?
     ORDER BY r.metric, s.tier ASC, r.confidence DESC`,
  ).bind(eventId, eventId).all<Row>();
  return results ?? [];
}

function alertFromDead(high: number): 'green' | 'yellow' | 'orange' | 'red' {
  if (high >= 1000) return 'red';
  if (high >= 100) return 'orange';
  if (high >= 1) return 'yellow';
  return 'green';
}

// ── GET /api/casualties — current event summary (default) ─────────────────────
casualties.get('/', (c) => summary(c, CURRENT_EVENT_ID));
// ── GET /api/casualties/:event/timeline?metric= — time series for one metric ───
casualties.get('/:event/timeline', async (c) => {
  const eventId = resolveEvent(c.req.param('event'));
  const metric = (c.req.query('metric') || 'dead').slice(0, 20);
  const { results } = await c.env.DB.prepare(
    `SELECT r.source_key, COALESCE(s.name, r.source_key) AS name, COALESCE(s.tier,3) AS tier,
            r.value_min, r.value_max, r.as_of_ms, r.confidence, r.citation_url
     FROM casualty_reports r LEFT JOIN casualty_sources s ON s.source_key = r.source_key
     WHERE r.event_id = ? AND r.metric = ?
     ORDER BY r.as_of_ms ASC LIMIT 1000`,
  ).bind(eventId, metric).all();
  return c.json({ event: eventId, metric, points: results ?? [] });
});
// ── GET /api/casualties/:event/sources — registry + per-source freshness ──────
casualties.get('/:event/sources', async (c) => {
  const eventId = resolveEvent(c.req.param('event'));
  const { results } = await c.env.DB.prepare(
    `SELECT s.source_key, s.name, s.tier, s.kind, s.homepage, s.default_confidence, s.active,
            (SELECT MAX(as_of_ms) FROM casualty_reports r WHERE r.source_key = s.source_key AND r.event_id = ?) AS last_as_of_ms,
            (SELECT COUNT(*) FROM casualty_reports r WHERE r.source_key = s.source_key AND r.event_id = ?) AS rows
     FROM casualty_sources s ORDER BY s.tier ASC, s.name ASC`,
  ).bind(eventId, eventId).all();
  return c.json({ event: eventId, sources: results ?? [] });
});
// ── GET /api/casualties/:event — event summary ────────────────────────────────
casualties.get('/:event', (c) => summary(c, resolveEvent(c.req.param('event'))));

async function summary(c: any, eventId: string) {
  const rows = await latestRows(c.env, eventId);
  const byMetric: Record<string, any> = {};
  for (const r of rows) {
    const m = (byMetric[r.metric] ||= { metric: r.metric, sources: [], low: Infinity, high: 0, best: null, best_conf: -1 });
    const high = r.value_max ?? r.value_min;
    m.sources.push({
      source_key: r.source_key, name: r.name, tier: r.tier, kind: r.kind,
      value_min: r.value_min, value_max: r.value_max, as_of_ms: r.as_of_ms,
      confidence: r.confidence, citation_url: r.citation_url, note: r.note,
    });
    m.low = Math.min(m.low, r.value_min);
    m.high = Math.max(m.high, high);
    if (r.confidence > m.best_conf) { m.best_conf = r.confidence; m.best = r.value_min; }
  }
  const metrics = Object.values(byMetric).map((m: any) => {
    if (m.low === Infinity) m.low = 0;
    delete m.best_conf;
    return m;
  });
  const dead = byMetric['dead'];
  const alert = dead ? alertFromDead(dead.high) : 'red';
  const updated = rows.reduce((mx, r) => Math.max(mx, r.as_of_ms), 0);
  return c.json({
    event: eventId,
    title: 'Terremotos de Venezuela — 24 jun 2026 (Mw 7,2 + 7,5)',
    alert,
    updated_ms: updated,
    metrics,
    source_count: new Set(rows.map((r) => r.source_key)).size,
    disclaimer: 'Las cifras DIFIEREN por fuente y cambian con el tiempo. Los conteos oficiales pueden estar subestimados; los reportes ciudadanos no están verificados. Se muestra el rango por fuente, no un único número.',
  }, 200, { 'Cache-Control': 'public, max-age=120' });
}

// ── POST /api/casualties/manual — operator records an official/manual figure ──
// Gated centrally (admin:maintenance). The figure still passes gateCasualty.
casualties.post('/manual', async (c) => {
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b !== 'object') return c.json({ error: 'json_required' }, 400);
  const eventId = resolveEvent(b.event_id);
  const gated = gateCasualty({
    source_key: b.source_key, source_name: b.source_name, metric: b.metric,
    value_min: b.value_min, value_max: b.value_max,
    as_of_ms: Number(b.as_of_ms) || Date.now(),
    confidence: b.confidence, citation_url: b.citation_url, note: b.note,
  });
  if (!gated.ok) return c.json({ error: 'rejected', reason: gated.reason, detail: gated.detail }, 400);
  const r = gated.row;
  // Ensure the source exists in the registry (so the dashboard can label it).
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO casualty_sources (source_key, name, tier, kind, default_confidence)
     VALUES (?,?,?,?,?)`,
  ).bind(r.source_key, String(b.source_name || r.source_key).slice(0, 120), Number(b.tier) || 2, String(b.kind || 'official').slice(0, 20), r.confidence).run();
  await c.env.DB.prepare(
    `INSERT INTO casualty_reports
       (id, event_id, source_key, metric, value_min, value_max, as_of_ms, confidence, citation_url, note, method, ingested_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'manual', ?)`,
  ).bind(uid('cas'), eventId, r.source_key, r.metric, r.value_min, r.value_max, r.as_of_ms, r.confidence, r.citation_url, r.note, Date.now()).run();
  return c.json({ ok: true }, 201);
});
