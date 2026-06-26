import type { Env, SeismicEvent } from '../types';

// USGS has two GeoJSON sources:
//  1. FDSNWS query API — server-side filtered to the Venezuela bbox + a time
//     window. Returns ONLY the events we care about (tiny payload, full VE
//     region incl. events the global summary feed would clip), and supports an
//     arbitrary look-back via USGS_WINDOW_DAYS.
//  2. `all_month` summary feed — static/CDN-cached, every magnitude in the last
//     30 days globally; we bbox-filter in-Worker. Used as a fallback when the
//     FDSNWS query API is slow/rate-limited/erroring.
const FDSNWS_QUERY = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
const SUMMARY_BASE = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary';

/** FDSNWS query for the configured Venezuela bbox + look-back window (primary). */
export function buildUsgsQueryUrl(env: Env, now: number): string {
  const days = Number(env.USGS_WINDOW_DAYS) || 30;
  const start = new Date(now - days * 86400_000).toISOString();
  const p = new URLSearchParams({
    format: 'geojson',
    starttime: start,
    minlatitude: env.USGS_MINLAT,
    maxlatitude: env.USGS_MAXLAT,
    minlongitude: env.USGS_MINLON,
    maxlongitude: env.USGS_MAXLON,
    orderby: 'time',
  });
  return `${FDSNWS_QUERY}?${p.toString()}`;
}

/** Global summary feed (fallback). */
export function buildUsgsUrl(_env: Env, _now: number): string {
  return `${SUMMARY_BASE}/all_month.geojson`;
}

/** True if a GeoJSON feature falls inside the configured Venezuela bbox. */
export function inBbox(env: Env, f: any): boolean {
  const [lon, lat] = f.geometry?.coordinates ?? [999, 999];
  return (
    lon >= Number(env.USGS_MINLON) && lon <= Number(env.USGS_MAXLON) &&
    lat >= Number(env.USGS_MINLAT) && lat <= Number(env.USGS_MAXLAT)
  );
}

/** Normalize a USGS GeoJSON feature into our SeismicEvent shape. */
export function normalizeFeature(f: any): SeismicEvent {
  const [lon, lat, depth] = f.geometry?.coordinates ?? [0, 0, null];
  const pr = f.properties ?? {};
  return {
    id: f.id,
    source: 'usgs',
    mag: pr.mag ?? null,
    place: pr.place ?? null,
    time_ms: pr.time,
    updated_ms: pr.updated ?? null,
    lat,
    lon,
    depth_km: depth,
    mmi: pr.mmi ?? null,
    alert: pr.alert ?? null,
    tsunami: pr.tsunami ? 1 : 0,
    felt: pr.felt ?? null,
    url: pr.url ?? null,
  };
}

async function fetchGeojson(url: string): Promise<any[]> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'SISMO911/0.1 (emergency monitoring)' },
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`USGS ${res.status}`);
  const json: any = await res.json();
  return json.features ?? [];
}

/**
 * Fetch live Venezuela seismicity from USGS, normalize to SeismicEvent.
 * Primary: FDSNWS bbox+window query (server-filtered). Fallback: global
 * summary feed bbox-filtered in-Worker. Throws only if BOTH fail.
 */
export async function fetchUsgs(env: Env, now: number): Promise<{ events: SeismicEvent[]; raw: any[] }> {
  let features: any[];
  try {
    // FDSNWS already restricts to the bbox server-side — no in-Worker filter.
    features = await fetchGeojson(buildUsgsQueryUrl(env, now));
  } catch {
    // Fallback: global month feed, bbox-filter locally.
    features = (await fetchGeojson(buildUsgsUrl(env, now))).filter((f) => inBbox(env, f));
  }
  const raw = features.sort((a, b) => (b.properties?.time ?? 0) - (a.properties?.time ?? 0));
  return { events: raw.map(normalizeFeature), raw };
}
