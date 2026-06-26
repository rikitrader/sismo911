import type { Env } from '../types';
import { scoreThreat } from './threat';

// ---------------------------------------------------------------------------
// Canonical read queries for the public datasets SISMO911 exposes over both the
// keyed data API (src/routes/data-api.ts) and the MCP server (src/routes/mcp.ts).
// Centralized here so the two surfaces never drift. Every query reads ONLY public
// / moderated rows.
// ---------------------------------------------------------------------------

export interface Page {
  page: number;
  pageSize: number;
}

export function clampPage(pageQ?: string | number, sizeQ?: string | number, maxSize = 100): Page {
  const page = Math.max(1, Math.floor(Number(pageQ ?? 1)) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, Math.floor(Number(sizeQ ?? 50)) || 50));
  return { page, pageSize };
}

// --- Earthquakes (USGS summary-feed accumulation in the events table) ---

export interface QuakeFilter {
  minMag?: number;
  from?: string; // YYYY-MM-DD
  to?: string;
  q?: string; // place substring
}

function quakeWhere(f: QuakeFilter): { where: string; binds: unknown[] } {
  const w: string[] = [];
  const b: unknown[] = [];
  if (f.minMag != null && !Number.isNaN(f.minMag)) { w.push('mag >= ?'); b.push(f.minMag); }
  if (f.from && !Number.isNaN(Date.parse(f.from))) { w.push('time_ms >= ?'); b.push(Date.parse(`${f.from}T00:00:00Z`)); }
  if (f.to && !Number.isNaN(Date.parse(f.to))) { w.push('time_ms < ?'); b.push(Date.parse(`${f.to}T00:00:00Z`) + 86_400_000); }
  if (f.q) { w.push('(place LIKE ? OR place_es LIKE ?)'); b.push(`%${f.q}%`, `%${f.q}%`); }
  return { where: w.length ? `WHERE ${w.join(' AND ')}` : '', binds: b };
}

export async function queryEarthquakes(env: Env, f: QuakeFilter, pg: Page) {
  const { where, binds } = quakeWhere(f);
  const total = ((await env.DB.prepare(`SELECT COUNT(*) AS n FROM events ${where}`).bind(...binds).first<any>())?.n) ?? 0;
  const { results } = await env.DB.prepare(
    `SELECT id, mag, place, place_es, time_ms, lat, lon, depth_km, mmi, alert, tsunami, felt, url
     FROM events ${where} ORDER BY time_ms DESC LIMIT ? OFFSET ?`
  ).bind(...binds, pg.pageSize, (pg.page - 1) * pg.pageSize).all();
  return { total, page: pg.page, pageSize: pg.pageSize, totalPages: Math.max(1, Math.ceil(total / pg.pageSize)), earthquakes: results ?? [] };
}

export async function getEarthquake(env: Env, id: string) {
  return env.DB.prepare(
    `SELECT id, mag, place, place_es, time_ms, lat, lon, depth_km, mmi, alert, tsunami, felt, url
     FROM events WHERE id = ?`
  ).bind(id).first();
}

export async function latestSeismic(env: Env, limit = 20) {
  const { results } = await env.DB.prepare(
    `SELECT id, mag, place, place_es, time_ms, lat, lon, depth_km, mmi, alert, tsunami, felt, url
     FROM events ORDER BY time_ms DESC LIMIT ?`
  ).bind(Math.min(100, Math.max(1, limit))).all<any>();
  const events = results ?? [];
  return { updated_ms: Date.now(), threat: scoreThreat(events as any, Date.now()), events };
}

export async function seismicStats(env: Env) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            MAX(mag) AS max_mag,
            SUM(CASE WHEN time_ms >= ? THEN 1 ELSE 0 END) AS last_24h,
            SUM(CASE WHEN time_ms >= ? THEN 1 ELSE 0 END) AS last_7d,
            SUM(CASE WHEN time_ms >= ? AND mag >= 4 THEN 1 ELSE 0 END) AS m4plus_30d
     FROM events`
  ).bind(Date.now() - 86_400_000, Date.now() - 7 * 86_400_000, Date.now() - 30 * 86_400_000).first<any>();
  const latest = await latestSeismic(env, 5);
  return {
    total_events: row?.total ?? 0,
    max_magnitude: row?.max_mag ?? null,
    last_24h: row?.last_24h ?? 0,
    last_7d: row?.last_7d ?? 0,
    m4plus_30d: row?.m4plus_30d ?? 0,
    current_threat: latest.threat,
    recent: latest.events,
  };
}

// --- Shelters (crowd-reported, approved only) ---

export async function queryShelters(env: Env, pg: Page) {
  const total = ((await env.DB.prepare(`SELECT COUNT(*) AS n FROM shelter_status WHERE moderation='approved'`).first<any>())?.n) ?? 0;
  const { results } = await env.DB.prepare(
    `SELECT id, name, lat, lon, status, capacity_note, updated_ms
     FROM shelter_status WHERE moderation='approved' ORDER BY updated_ms DESC LIMIT ? OFFSET ?`
  ).bind(pg.pageSize, (pg.page - 1) * pg.pageSize).all();
  return { total, page: pg.page, pageSize: pg.pageSize, totalPages: Math.max(1, Math.ceil(total / pg.pageSize)), shelters: results ?? [] };
}

// --- Blog / Noticias (published only) ---

export async function queryBlog(env: Env, pg: Page) {
  const total = ((await env.DB.prepare(`SELECT COUNT(*) AS n FROM blog_posts WHERE status='published'`).first<any>())?.n) ?? 0;
  const { results } = await env.DB.prepare(
    `SELECT slug, headline, meta_desc, place, lat, lon, platform, author, source_url, image_url, video_url, views, likes, comments, published_at
     FROM blog_posts WHERE status='published' ORDER BY published_at DESC LIMIT ? OFFSET ?`
  ).bind(pg.pageSize, (pg.page - 1) * pg.pageSize).all();
  return { total, page: pg.page, pageSize: pg.pageSize, totalPages: Math.max(1, Math.ceil(total / pg.pageSize)), posts: results ?? [] };
}

// --- Missing persons (scope-gated: citizen-submitted PII, approved only) ---

export async function queryMissingPersons(env: Env, pg: Page, q?: string) {
  const w: string[] = ["moderation = 'approved'"];
  const b: unknown[] = [];
  if (q) { w.push('(nombre LIKE ? OR ubicacion LIKE ?)'); b.push(`%${q}%`, `%${q}%`); }
  const where = `WHERE ${w.join(' AND ')}`;
  const total = ((await env.DB.prepare(`SELECT COUNT(*) AS n FROM personas ${where}`).bind(...b).first<any>())?.n) ?? 0;
  const { results } = await env.DB.prepare(
    `SELECT id, nombre, edad, ubicacion, descripcion, estado, updated_at
     FROM personas ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`
  ).bind(...b, pg.pageSize, (pg.page - 1) * pg.pageSize).all();
  return { total, page: pg.page, pageSize: pg.pageSize, totalPages: Math.max(1, Math.ceil(total / pg.pageSize)), persons: results ?? [] };
}
