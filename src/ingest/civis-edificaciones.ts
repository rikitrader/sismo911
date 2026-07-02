import type { Env } from '../types';
import { recordIngest } from '../lib/db';
import { logAgentActivity } from '../lib/agent-activity';

// ── CIVIS satellite structural damage + live stats ─────────────────────────
// Two public CIVIS feeds (no key) powering /panorama and the Satélite tab on
// /edificios (this lifts the PR #607 deferral of /api/edificaciones — it is
// now ingested as its OWN evidence class, not merged into tv_buildings):
//   • /api/edificaciones → satellite-detected damaged buildings (Copernicus
//     EMS verified + Microsoft AI4G prediction, ~975 rows, all oficial:true)
//     → `sat_edificaciones` (UPSERT by CIVIS uuid).
//   • /api/estadisticas + /api/panorama → live counter set + AI summary
//     → one `civis_stats_snapshots` row per run (latest row serves the API).

const UA = 'sismo911-civis-sync';
const clip = (v: unknown, n: number) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, n);

async function civisFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, cf: { cacheTtl: 0 } as any });
  if (!res.ok) throw new Error(`fetch_${res.status}`);
  return res.json<T>();
}

interface CivisEdificacion {
  id: string; lat?: number; lng?: number; severidad?: string; oficial?: boolean;
  zona?: string | null; uso?: string | null; url?: string | null;
}

/** One CIVIS edificación → sat_edificaciones row shape (null if no id). */
export function edificacionToRow(e: CivisEdificacion, now: number) {
  if (!e.id) return null;
  return {
    id: clip(e.id, 72),
    lat: typeof e.lat === 'number' ? e.lat : null,
    lng: typeof e.lng === 'number' ? e.lng : null,
    severidad: clip(e.severidad || '', 24),
    oficial: e.oficial ? 1 : 0,
    zona: clip(e.zona || '', 120),
    uso: clip(e.uso || '', 80),
    maps_url: clip(e.url || '', 300),
    now,
  };
}

async function ingestEdificaciones(env: Env): Promise<number> {
  const base = (env.CIVIS_API_BASE || 'https://civisvenezuela.com').replace(/\/+$/, '');
  const { edificaciones } = await civisFetch<{ edificaciones: CivisEdificacion[] }>(`${base}/api/edificaciones`);
  const now = Date.now();
  const stmts: any[] = [];
  for (const ed of edificaciones ?? []) {
    const r = edificacionToRow(ed, now);
    if (!r) continue;
    stmts.push(env.DB.prepare(
      `INSERT INTO sat_edificaciones
         (id,lat,lng,severidad,oficial,zona,uso,maps_url,source,created_ms,updated_ms)
       VALUES (?,?,?,?,?,?,?,?, 'civis', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         lat=excluded.lat, lng=excluded.lng, severidad=excluded.severidad, oficial=excluded.oficial,
         zona=excluded.zona, uso=excluded.uso,
         maps_url=CASE WHEN excluded.maps_url<>'' THEN excluded.maps_url ELSE sat_edificaciones.maps_url END,
         updated_ms=excluded.updated_ms`
    ).bind(r.id, r.lat, r.lng, r.severidad, r.oficial, r.zona, r.uso, r.maps_url, r.now, r.now));
  }
  let written = 0;
  for (let i = 0; i < stmts.length; i += 100) { await env.DB.batch(stmts.slice(i, i + 100)); written += Math.min(100, stmts.length - i); }
  return written;
}

interface CivisStats { stats?: Record<string, number> }
interface CivisPanorama { panorama?: { texto?: string; generado_en?: string } }

async function ingestStatsSnapshot(env: Env): Promise<number> {
  const base = (env.CIVIS_API_BASE || 'https://civisvenezuela.com').replace(/\/+$/, '');
  const { stats } = await civisFetch<CivisStats>(`${base}/api/estadisticas`);
  let texto = '', generado = '';
  try {
    const { panorama } = await civisFetch<CivisPanorama>(`${base}/api/panorama`);
    texto = clip(panorama?.texto || '', 4000);
    generado = clip(panorama?.generado_en || '', 40);
  } catch { /* panorama summary is optional — stats snapshot still lands */ }
  if (!stats || !Object.keys(stats).length) throw new Error('empty_stats');
  await env.DB.prepare(
    `INSERT INTO civis_stats_snapshots (taken_ms, stats_json, panorama_text, panorama_generated_at)
     VALUES (?,?,?,?)`
  ).bind(Date.now(), JSON.stringify(stats), texto, generado).run();
  // Keep history bounded (~30 days at 24 rows/day); never touches sat_edificaciones.
  await env.DB.prepare(
    `DELETE FROM civis_stats_snapshots WHERE id NOT IN
       (SELECT id FROM civis_stats_snapshots ORDER BY taken_ms DESC LIMIT 720)`
  ).run().catch(() => {});
  return 1;
}

/** Self-heal: tolerate a DB where migration 0093 has not yet applied. */
async function ensureTables(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS sat_edificaciones (
       id TEXT PRIMARY KEY, lat REAL, lng REAL, severidad TEXT NOT NULL DEFAULT '',
       oficial INTEGER NOT NULL DEFAULT 0, zona TEXT, uso TEXT, maps_url TEXT,
       source TEXT NOT NULL DEFAULT 'civis', created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL)`
  ).run().catch(() => {});
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS civis_stats_snapshots (
       id INTEGER PRIMARY KEY AUTOINCREMENT, taken_ms INTEGER NOT NULL,
       stats_json TEXT NOT NULL DEFAULT '{}', panorama_text TEXT NOT NULL DEFAULT '',
       panorama_generated_at TEXT NOT NULL DEFAULT '')`
  ).run().catch(() => {});
}

/** Hourly combined pull: satellite edificaciones + stats snapshot. Isolated so
 *  one failing never aborts the other. No silent failure — each logs. */
export async function ingestCivisEdificaciones(env: Env): Promise<{ edificaciones: number; snapshot: number }> {
  await ensureTables(env);
  let edificaciones = 0, snapshot = 0;
  try {
    edificaciones = await ingestEdificaciones(env);
    await recordIngest(env, 'civis-edificaciones', true, edificaciones);
  } catch (e: any) {
    const reason = String(e?.message || e).slice(0, 120);
    await recordIngest(env, 'civis-edificaciones', false, 0, reason).catch(() => {});
    await logAgentActivity(env, { source: 'civis-edificaciones', action: 'ingest', ok: false,
      summary: `⚠ Fallo al sincronizar edificaciones satelitales CIVIS: ${reason}.` }).catch(() => {});
  }
  try {
    snapshot = await ingestStatsSnapshot(env);
    await recordIngest(env, 'civis-stats', true, snapshot);
  } catch (e: any) {
    const reason = String(e?.message || e).slice(0, 120);
    await recordIngest(env, 'civis-stats', false, 0, reason).catch(() => {});
    await logAgentActivity(env, { source: 'civis-stats', action: 'ingest', ok: false,
      summary: `⚠ Fallo al capturar snapshot de estadísticas CIVIS: ${reason}.` }).catch(() => {});
  }
  if (edificaciones || snapshot) {
    await logAgentActivity(env, { source: 'civis-edificaciones', action: 'ingest', fetched: edificaciones + snapshot, created: edificaciones + snapshot,
      summary: `🛰️ CIVIS satelital — ${edificaciones} edificación(es) dañadas + ${snapshot} snapshot de panorama actualizados.`, ok: true }).catch(() => {});
  }
  return { edificaciones, snapshot };
}
