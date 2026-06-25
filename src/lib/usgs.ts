import type { Env, SeismicEvent } from '../types';

// USGS summary GeoJSON feeds (static, CDN-cached, more reliable than the FDSN
// query API). `all_month` = every magnitude in the last 30 days, globally; we
// filter to the Venezuela bounding box in-Worker.
const SUMMARY_BASE = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary';

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

/** Fetch the live USGS summary feed, filter to Venezuela, normalize. Throws on non-200. */
export async function fetchUsgs(env: Env, now: number): Promise<{ events: SeismicEvent[]; raw: any[] }> {
  const res = await fetch(buildUsgsUrl(env, now), {
    headers: { 'User-Agent': 'SISMO911/0.1 (emergency monitoring)' },
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`USGS ${res.status}`);
  const json: any = await res.json();
  const all: any[] = json.features ?? [];
  const raw = all
    .filter((f) => inBbox(env, f))
    .sort((a, b) => (b.properties?.time ?? 0) - (a.properties?.time ?? 0));
  return { events: raw.map(normalizeFeature), raw };
}
