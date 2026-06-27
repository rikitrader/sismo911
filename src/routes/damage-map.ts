import { Hono } from 'hono';
import type { Env } from '../types';
import { ingestSosDamage } from '../ingest/sos-damage';
import { rateLimit } from '../lib/security';
import { edgeCached } from '../lib/edge-cache';
export const damageMap = new Hono<{ Bindings: Env }>();
damageMap.get('/', async (c) => {
  const limited = await rateLimit(c.env, c, 'danos_browse', 30, 60);
  if (limited) return limited;
  return edgeCached(c, 60, async () => {
  const cat = c.req.query('category');
  const q = cat
    ? c.env.DB.prepare(`SELECT * FROM sos_damage WHERE category = ? ORDER BY created_at DESC LIMIT 3000`).bind(cat)
    : c.env.DB.prepare(`SELECT * FROM sos_damage ORDER BY created_at DESC LIMIT 3000`);
  let rows = (await q.all()).results ?? [];
  if (!rows.length) { try { await ingestSosDamage(c.env); rows = (await c.env.DB.prepare(`SELECT * FROM sos_damage ORDER BY created_at DESC LIMIT 3000`).all()).results ?? []; } catch { /* ignore */ } }
  const counts = (await c.env.DB.prepare(`SELECT category, COUNT(*) AS n FROM sos_damage GROUP BY category`).all()).results ?? [];
  return { reports: rows, total: rows.length, counts, source: 'sosvenezuela2026.com' };
  });
});
damageMap.post('/sync', async (c) => {
  try { const r = await ingestSosDamage(c.env); return c.json({ ok: true, ...r }); }
  catch (e: any) { return c.json({ ok: false, error: String(e?.message ?? e) }, 502); }
});
