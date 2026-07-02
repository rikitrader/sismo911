import type { Env } from '../types';
import { recordIngest } from '../lib/db';
import { syncBuildingCases } from '../lib/building-cases';
import { tvFetch, TV_PAGE, type TvRow } from '../lib/tv-buildings';

// Hourly ingest of terremotovenezuela.com's `buildings` table into D1 `tv_buildings`.
//
// DEDUPE BY CONSTRUCTION: tv_buildings.id is terremotovenezuela's uuid and every
// write is an UPSERT, so re-runs refresh rather than duplicate. The whole set is
// ~795 rows → one page fits in a single fetch; we still paginate defensively.
//
// Subrequest budget: 1 fetch per ≤1000 rows + chunked D1 batches (100 rows each).
// Rides an existing hourly CRON_GROUP — the account is capped at 5 cron triggers.

const CHUNK = 100;

function upsertStmt(env: Env, r: TvRow) {
  return env.DB.prepare(
    `INSERT INTO tv_buildings
       (id, name, address, city, zone, lat, lng, damage_level, status,
        main_photo_url, media_urls, general_source, notes, has_missing_persons,
        tv_created_at, tv_updated_at, pulled_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, address=excluded.address, city=excluded.city, zone=excluded.zone,
       lat=excluded.lat, lng=excluded.lng, damage_level=excluded.damage_level, status=excluded.status,
       main_photo_url=excluded.main_photo_url, media_urls=excluded.media_urls,
       general_source=excluded.general_source, notes=excluded.notes,
       has_missing_persons=excluded.has_missing_persons,
       tv_created_at=excluded.tv_created_at, tv_updated_at=excluded.tv_updated_at,
       pulled_at=excluded.pulled_at`,
  ).bind(
    r.id, r.name ?? '', r.address ?? '', r.city ?? '', r.zone ?? '',
    r.lat ?? null, r.lng ?? null, r.damage_level ?? '', r.status ?? '',
    r.main_photo_url ?? null,
    Array.isArray(r.media_urls) ? JSON.stringify(r.media_urls) : null,
    r.general_source ?? null, r.notes ?? null, r.has_missing_persons ? 1 : 0,
    r.created_at ?? null, r.updated_at ?? r.last_updated_at ?? null,
    new Date().toISOString(),
  );
}

export interface TvIngestResult { written: number; total: number; pages: number; }

export async function ingestTvBuildings(env: Env): Promise<TvIngestResult> {
  try {
    let offset = 0, written = 0, pages = 0, total = 0;
    // Bounded loop: ~795 rows / 1000 per page = 1 page; cap at 5 as a safety net.
    for (; pages < 5; pages++) {
      const { rows, total: t } = await tvFetch(env, offset, TV_PAGE);
      total = t;
      if (!rows.length) break;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const batch = rows.slice(i, i + CHUNK).map((r) => upsertStmt(env, r));
        await env.DB.batch(batch);
        written += batch.length;
      }
      offset += rows.length;
      if (rows.length < TV_PAGE || offset >= total) break;
    }
    await recordIngest(env, 'tv-buildings', true, written);
    // Attach cases: name-token match every building against the live case
    // registries and persist into building_cases (INSERT OR IGNORE, so found
    // people keep their attachment). Fail-soft — a linker error must never
    // fail the ingest that feeds it.
    try {
      const link = await syncBuildingCases(env);
      await recordIngest(env, 'tv-building-cases', true, link.linked);
    } catch (e: any) {
      await recordIngest(env, 'tv-building-cases', false, 0, String(e?.message || e));
    }
    return { written, total, pages: pages + 1 };
  } catch (e: any) {
    await recordIngest(env, 'tv-buildings', false, 0, String(e?.message || e));
    throw e;
  }
}
