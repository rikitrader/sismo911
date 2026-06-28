import type { Env, SeismicEvent } from '../types';

/** Upsert a batch of normalized events into D1. Returns rows written. */
export async function upsertEvents(env: Env, events: SeismicEvent[], raw: any[]): Promise<number> {
  if (!events.length) return 0;
  const now = Date.now();
  const stmt = env.DB.prepare(
    `INSERT INTO events (id, source, mag, place, time_ms, updated_ms, lat, lon, depth_km, mmi, alert, tsunami, felt, url, raw, ingested_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       mag=excluded.mag, place=excluded.place, updated_ms=excluded.updated_ms,
       mmi=excluded.mmi, alert=excluded.alert, tsunami=excluded.tsunami,
       felt=excluded.felt, raw=excluded.raw, ingested_ms=excluded.ingested_ms`
  );
  const batch = events.map((e, i) =>
    stmt.bind(
      e.id, e.source, e.mag, e.place, e.time_ms, e.updated_ms, e.lat, e.lon,
      e.depth_km, e.mmi, e.alert, e.tsunami, e.felt, e.url,
      JSON.stringify(raw[i] ?? null), now
    )
  );
  await env.DB.batch(batch);
  return batch.length;
}

// Health classification for an ingest_log row. Pure (testable): derives a
// status from the recorded error + how long the source has been failing, so a
// degraded feed (e.g. an upstream that started requiring reCAPTCHA) surfaces in
// /api/status instead of failing silently every hour. `down` = a structured
// `degraded:*` error (the cron explicitly classified the failure); `stale` = no
// success in STALE_AFTER_MS while erroring; `ok` otherwise.
export interface IngestLogRow {
  source: string; last_run_ms: number | null; last_ok_ms: number | null;
  last_count: number | null; last_error: string | null;
}
export type IngestHealth = 'ok' | 'stale' | 'down';
const STALE_AFTER_MS = 3 * 60 * 60 * 1000;   // 3h without a success ⇒ stale

export function classifyIngestHealth(row: IngestLogRow, nowMs: number): IngestHealth {
  const err = (row.last_error || '').trim();
  // A structured `degraded:<reason>` error means the cron positively identified a
  // blocking condition (e.g. degraded:recaptcha) — treat as down regardless of age.
  if (err.startsWith('degraded:')) return 'down';
  const okAgeMs = row.last_ok_ms == null ? Infinity : nowMs - row.last_ok_ms;
  if (err && okAgeMs > STALE_AFTER_MS) return 'stale';
  return 'ok';
}

export async function recordIngest(
  env: Env, source: string, ok: boolean, count: number, error?: string
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO ingest_log (source, last_run_ms, last_ok_ms, last_count, last_error)
     VALUES (?,?,?,?,?)
     ON CONFLICT(source) DO UPDATE SET
       last_run_ms=excluded.last_run_ms,
       last_ok_ms=CASE WHEN ? THEN excluded.last_run_ms ELSE ingest_log.last_ok_ms END,
       last_count=excluded.last_count, last_error=excluded.last_error`
  ).bind(source, now, ok ? now : null, count, error ?? null, ok ? 1 : 0).run();
}

export async function listEvents(env: Env, limit = 100): Promise<SeismicEvent[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, source, mag, place, place_es, time_ms, updated_ms, lat, lon, depth_km, mmi, alert, tsunami, felt, url
     FROM events WHERE dup_of IS NULL ORDER BY time_ms DESC LIMIT ?`
  ).bind(limit).all<SeismicEvent>();
  return results ?? [];
}

export async function getEvent(env: Env, id: string): Promise<any | null> {
  return env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first();
}

export function uid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}
