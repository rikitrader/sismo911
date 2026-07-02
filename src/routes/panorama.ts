import { Hono } from 'hono';
import type { Env } from '../types';
import { edgeCached } from '../lib/edge-cache';
import { getCanonicalCasualties, CANON_SOURCE } from '../lib/canonical-casualties';

export const panorama = new Hono<{ Bindings: Env }>();

// ── Balance oficial del gobierno ────────────────────────────────────────────
// The government reads its balance aloud on TV; nobody publishes it as an API.
// Three layers, later wins: (1) BALANCE_DEFAULTS — last hand-transcribed parte
// shipped with the code; (2) canonical fallecidos/heridos from the casualty
// pipeline (auto-updates as new partes are AI-extracted from press); (3) the
// panorama_balance manual-override row (operator, damage:moderate).
const BALANCE_DEFAULTS = {
  corte: '1 de julio de 2026',
  fallecidos: 2295, heridos: 11267, rescatadas: 6461,
  damnificadas: 12841, campamentos: 28380, desaparecidos_onu: '50.000+',
  fuente: 'Gobierno de Venezuela (Asamblea Nacional, vía Venevisión/VTV)',
} as const;

const BALANCE_INT_FIELDS = ['fallecidos', 'heridos', 'rescatadas', 'damnificadas', 'campamentos'] as const;

async function buildBalance(env: Env) {
  const balance: Record<string, any> = { ...BALANCE_DEFAULTS, origen: 'transcrito' };
  const canon = await getCanonicalCasualties(env).catch(() => null);
  if (canon?.fallecidos != null) { balance.fallecidos = canon.fallecidos; balance.origen = 'canonico'; }
  if (canon?.heridos != null) balance.heridos = canon.heridos;
  if (canon?.as_of) { balance.canon_as_of = canon.as_of; balance.canon_fuente = CANON_SOURCE; }
  const manual: any = await env.DB.prepare(
    `SELECT corte, fallecidos, heridos, rescatadas, damnificadas, campamentos,
            desaparecidos_onu, fuente, updated_ms
     FROM panorama_balance WHERE id = 1`
  ).first().catch(() => null);
  if (manual) {
    for (const k of [...BALANCE_INT_FIELDS, 'corte', 'desaparecidos_onu', 'fuente'] as string[]) {
      if (manual[k] != null && manual[k] !== '') balance[k] = manual[k];
    }
    balance.override_updated_ms = manual.updated_ms ?? null;
    if (manual.corte) balance.origen = 'operador';
  }
  return balance;
}

// POST /api/panorama/balance — operator override (gated damage:moderate via
// route-policy isPanoramaWrite). Body: any subset of {corte, fallecidos,
// heridos, rescatadas, damnificadas, campamentos, desaparecidos_onu, fuente};
// null clears a field back to canonical/default. Upserts the single row.
panorama.post('/balance', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ error: 'json_body_requerido' }, 400);
  const row: Record<string, any> = {};
  for (const k of BALANCE_INT_FIELDS) {
    if (!(k in body)) continue;
    if (body[k] === null) { row[k] = null; continue; }
    const n = Number(body[k]);
    if (!Number.isFinite(n) || n < 0 || n > 100_000_000) return c.json({ error: `campo_invalido:${k}` }, 400);
    row[k] = Math.trunc(n);
  }
  for (const k of ['corte', 'desaparecidos_onu', 'fuente'] as const) {
    if (!(k in body)) continue;
    row[k] = body[k] === null ? null : String(body[k]).replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  if (!Object.keys(row).length) return c.json({ error: 'sin_campos' }, 400);
  const existing: any = await c.env.DB.prepare(`SELECT * FROM panorama_balance WHERE id = 1`).first().catch(() => null);
  const merged = { ...(existing || {}), ...row };
  await c.env.DB.prepare(
    `INSERT INTO panorama_balance
       (id, corte, fallecidos, heridos, rescatadas, damnificadas, campamentos, desaparecidos_onu, fuente, updated_ms)
     VALUES (1,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       corte=excluded.corte, fallecidos=excluded.fallecidos, heridos=excluded.heridos,
       rescatadas=excluded.rescatadas, damnificadas=excluded.damnificadas, campamentos=excluded.campamentos,
       desaparecidos_onu=excluded.desaparecidos_onu, fuente=excluded.fuente, updated_ms=excluded.updated_ms`
  ).bind(merged.corte ?? null, merged.fallecidos ?? null, merged.heridos ?? null, merged.rescatadas ?? null,
         merged.damnificadas ?? null, merged.campamentos ?? null, merged.desaparecidos_onu ?? null,
         merged.fuente ?? null, Date.now()).run();
  return c.json({ ok: true, balance: await buildBalance(c.env) });
});

// ── Panorama de la emergencia — public read-only aggregates ────────────────
// Mirrors CIVIS Venezuela data ingested hourly by the civis-edificaciones cron
// job (sat_edificaciones + civis_stats_snapshots). Serves /panorama and the
// Satélite tab on /edificios. GET-only, no PII, edge-cached.

// GET /api/panorama/stats — latest CIVIS stats snapshot + our own satellite
// counts (computed live from sat_edificaciones so the sat tiles never lag the
// points layer) + snapshot age for the staleness indicator.
panorama.get('/stats', async (c) => edgeCached(c, 60, async () => {
  const snap: any = await c.env.DB.prepare(
    `SELECT taken_ms, stats_json, panorama_text, panorama_generated_at
     FROM civis_stats_snapshots ORDER BY taken_ms DESC LIMIT 1`
  ).first().catch(() => null);
  let stats: Record<string, number> = {};
  try { stats = JSON.parse(snap?.stats_json || '{}'); } catch { /* keep {} */ }

  const sat = await c.env.DB.prepare(
    `SELECT severidad, COUNT(*) AS n FROM sat_edificaciones GROUP BY severidad`
  ).all<any>().catch(() => ({ results: [] as any[] }));
  const bySev: Record<string, number> = {};
  for (const r of sat.results ?? []) bySev[String(r.severidad)] = Number(r.n) || 0;
  const satTotal = Object.values(bySev).reduce((a, b) => a + b, 0);

  const zonas = await c.env.DB.prepare(
    `SELECT zona, COUNT(*) AS n FROM sat_edificaciones GROUP BY zona ORDER BY n DESC LIMIT 12`
  ).all<any>().catch(() => ({ results: [] as any[] }));

  return {
    taken_ms: snap?.taken_ms ?? null,
    stats,
    balance: await buildBalance(c.env),
    panorama: { texto: snap?.panorama_text || '', generado_en: snap?.panorama_generated_at || '' },
    sat: {
      confirmadas: satTotal,
      colapso: bySev['colapso'] || 0,
      grave: bySev['grave'] || 0,
      zonas: (zonas.results ?? []).map((z: any) => ({ zona: z.zona, n: Number(z.n) || 0 })),
    },
    attribution: 'CIVIS Venezuela · Copernicus EMS (UE) · Microsoft AI4G',
  };
}));

// GET /api/panorama/series — hourly counter history for the evolution charts
// (small multiples on /panorama). One point per snapshot, ascending; only the
// charted keys are extracted so the payload stays small (~720 points max).
const SERIES_KEYS = ['desap_buscando', 'desap_localizadas', 'atendidas_total',
  'atendidas_reencontradas', 'danos_total', 'edif_total'] as const;

panorama.get('/series', async (c) => edgeCached(c, 300, async () => {
  const rows = await c.env.DB.prepare(
    `SELECT taken_ms, stats_json FROM civis_stats_snapshots ORDER BY taken_ms ASC LIMIT 720`
  ).all<any>().catch(() => ({ results: [] as any[] }));
  const points = (rows.results ?? []).map((r: any) => {
    let s: Record<string, number> = {};
    try { s = JSON.parse(r.stats_json || '{}'); } catch { /* skip bad row */ }
    const p: Record<string, number | null> = { t: Number(r.taken_ms) };
    for (const k of SERIES_KEYS) p[k] = Number.isFinite(Number(s[k])) ? Number(s[k]) : null;
    return p;
  });
  return { points, keys: SERIES_KEYS };
}));

// GET /api/panorama/edificaciones — satellite-detected damaged buildings
// (points layer). Optional ?zona= and ?severidad= filters; capped at 2000
// (dataset is ~975 today — the cap is headroom, not pagination).
panorama.get('/edificaciones', async (c) => {
  const zona = (c.req.query('zona') || '').slice(0, 120);
  const severidad = (c.req.query('severidad') || '').slice(0, 24);
  return edgeCached(c, 300, async () => {
    const where: string[] = ['lat IS NOT NULL', 'lng IS NOT NULL'];
    const binds: any[] = [];
    if (zona) { where.push('zona = ?'); binds.push(zona); }
    if (severidad) { where.push('severidad = ?'); binds.push(severidad); }
    const rows = await c.env.DB.prepare(
      `SELECT id, lat, lng, severidad, oficial, zona, uso, maps_url
       FROM sat_edificaciones WHERE ${where.join(' AND ')}
       ORDER BY updated_ms DESC LIMIT 2000`
    ).bind(...binds).all<any>().catch(() => ({ results: [] as any[] }));
    return { edificaciones: rows.results ?? [], attribution: 'CIVIS Venezuela · Copernicus EMS (UE) · Microsoft AI4G' };
  });
});
