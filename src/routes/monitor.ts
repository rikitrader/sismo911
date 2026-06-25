import { Hono } from 'hono';
import type { Env } from '../types';
import { ingestSocialMonitor, fromApifyItems, storeSignals } from '../ingest/social-monitor';
import { syncMonitorSheet } from '../lib/sheets-sync';

export const monitor = new Hono<{ Bindings: Env }>();

// GET /api/monitor/signals?severity=critical&platform=tiktok&city=Caracas&limit=100
monitor.get('/signals', async (c) => {
  const sev = c.req.query('severity');
  const platform = c.req.query('platform');
  const city = c.req.query('city');
  const q = c.req.query('q');
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 300);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (sev) { where.push('severity = ?'); binds.push(sev); }
  if (platform) { where.push('platform = ?'); binds.push(platform); }
  if (city) { where.push('city = ?'); binds.push(city); }
  if (q) { where.push('(title LIKE ? OR text LIKE ? OR tags LIKE ?)'); binds.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const sql = `SELECT id, platform, severity, city, tags, title, text, author, lang, url, score, posted_ms
     FROM social_signals ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY posted_ms DESC LIMIT ?`;
  const { results } = await c.env.DB.prepare(sql).bind(...binds, limit).all();
  c.header('Cache-Control', 'public, max-age=60');
  return c.json({ signals: results ?? [] });
});

// GET /api/monitor/stats — counts by severity/platform + last ingest time.
monitor.get('/stats', async (c) => {
  const bySev = await c.env.DB.prepare('SELECT severity, COUNT(*) n FROM social_signals GROUP BY severity').all();
  const byPlat = await c.env.DB.prepare('SELECT platform, COUNT(*) n FROM social_signals GROUP BY platform').all();
  const byCity = await c.env.DB.prepare("SELECT city, COUNT(*) n FROM social_signals WHERE city IS NOT NULL GROUP BY city ORDER BY n DESC LIMIT 12").all();
  const last = await c.env.DB.prepare("SELECT last_ok_ms, last_count FROM ingest_log WHERE source='social_monitor'").first().catch(() => null);
  const total = await c.env.DB.prepare('SELECT COUNT(*) n FROM social_signals').first<{ n: number }>();
  return c.json({
    total: total?.n ?? 0,
    by_severity: bySev.results ?? [],
    by_platform: byPlat.results ?? [],
    by_city: byCity.results ?? [],
    last_ingest_ms: (last as any)?.last_ok_ms ?? null,
  });
});

// POST /api/monitor/refresh?secret=… — manual immediate ingest + sheet sync.
// Secret-gated (same token as the Apify webhook) so it can be triggered by an
// operator or an external scheduler without an interactive session.
monitor.post('/refresh', async (c) => {
  if (c.req.query('secret') !== c.env.MONITOR_WEBHOOK_SECRET) return c.json({ error: 'forbidden' }, 403);
  const n = await ingestSocialMonitor(c.env);
  const synced = await syncMonitorSheet(c.env).catch(() => 0);
  return c.json({ ok: true, ingested: n, synced });
});

// POST /api/monitor/apify?secret=…&platform=tiktok — Apify run-finished webhook.
monitor.post('/apify', async (c) => {
  if (c.req.query('secret') !== c.env.MONITOR_WEBHOOK_SECRET) return c.json({ error: 'forbidden' }, 403);
  const platform = c.req.query('platform') ?? 'tiktok';
  const body = await c.req.json().catch(() => null);
  const datasetId = body?.resource?.defaultDatasetId;
  if (!datasetId || !c.env.APIFY_TOKEN) return c.json({ error: 'no_dataset' }, 400);
  const res = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${c.env.APIFY_TOKEN}&clean=true&limit=200`);
  const items = await res.json<any[]>().catch(() => []);
  const written = await storeSignals(c.env, fromApifyItems(platform, items));
  return c.json({ ok: true, platform, written });
});
