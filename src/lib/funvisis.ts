import type { Env, SeismicEvent } from '../types';

// FUNVISIS (Fundación Venezolana de Investigaciones Sismológicas) publishes its
// "Últimos Sismos" list as a single GeoJSON file at the site root. The Leaflet
// map on funvisis.gob.ve fetches `./maravilla.json` (relative path 404s); the
// working URL is the site root. HTTP-only — Workers fetch() serves it over :80.
//
// The file reuses a generic store-locator GeoJSON template, so the property
// NAMES are misleading and must be re-mapped:
//   phone          -> magnitud (e.g. "2.5")
//   state          -> profundidad / depth, "5.0 km" (phoneFormatted duplicates it)
//   address        -> ubicación / epicentro (Spanish place text)
//   city           -> hora local, "9:44" (VET, 24h)
//   postalCode     -> fecha, "DD-MM-YYYY"
//   lat / long     -> coordinates (also in geometry.coordinates as [lon, lat])
const DEFAULT_URL = 'http://www.funvisis.gob.ve/maravilla.json';

// Venezuela Standard Time is a fixed UTC-04:00 (no DST since 2016). The feed's
// times are local, so UTC = local + 4h.
const VE_OFFSET_MS = 4 * 3600 * 1000;

/** First signed number in a string, or null. "5.0 km" -> 5, "2,5" handled too. */
function num(s: unknown): number | null {
  const m = String(s ?? '').replace(',', '.').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

/** "DD-MM-YYYY" + "H:MM" (VET local) -> epoch ms (UTC). Null if unparseable. */
export function parseFunvisisTime(dateStr: unknown, timeStr: unknown): number | null {
  const dm = String(dateStr ?? '').match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  const tm = String(timeStr ?? '').match(/^(\d{1,2}):(\d{2})/);
  if (!dm || !tm) return null;
  const d = +dm[1], mo = +dm[2], y = +dm[3];
  const hh = +tm[1], mm = +tm[2];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59) return null;
  return Date.UTC(y, mo - 1, d, hh, mm) + VE_OFFSET_MS;
}

/**
 * Normalize one FUNVISIS GeoJSON feature into our SeismicEvent shape. The feed
 * carries NO event id, so we synthesize a STABLE dedup key from date+time+coords
 * — re-polling the same event upserts instead of duplicating. `place_es` is left
 * to the DB layer (the place text is already Spanish, so `place` suffices).
 */
export function normalizeFunvisisFeature(f: any): SeismicEvent | null {
  const p = f?.properties ?? {};
  const g = f?.geometry ?? {};
  const coords = Array.isArray(g.coordinates) ? g.coordinates : [num(p.long), num(p.lat)];
  const lon = num(coords[0]);
  const lat = num(coords[1]);
  const mag = num(p.phone);
  const time_ms = parseFunvisisTime(p.postalCode, p.city);
  // Drop anything we can't place on a map or a timeline.
  if (lat == null || lon == null || mag == null || time_ms == null) return null;

  const datePart = String(p.postalCode ?? '').replace(/[^0-9]/g, '');
  const timePart = String(p.city ?? '').replace(/[^0-9]/g, '');
  return {
    id: `funvisis-${datePart}-${timePart}-${lat}-${lon}`,
    source: 'funvisis',
    mag,
    place: typeof p.address === 'string' ? p.address.trim() : null,
    time_ms,
    updated_ms: time_ms,
    lat,
    lon,
    depth_km: num(p.state ?? p.phoneFormatted),
    mmi: null,
    alert: null,
    tsunami: 0,
    felt: null,
    url: 'http://www.funvisis.gob.ve/index.php',
  };
}

/**
 * Fetch the live FUNVISIS national feed and normalize to SeismicEvent[].
 * Returns the kept events plus the raw features they came from (same index), so
 * the caller can persist the raw GeoJSON alongside each row. Throws on a network
 * or parse failure (the cron records it and keeps the prior data).
 */
export async function fetchFunvisis(env: Env, _now: number): Promise<{ events: SeismicEvent[]; raw: any[] }> {
  const url = env.FUNVISIS_URL || DEFAULT_URL;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'SISMO911/0.1 (emergency monitoring)' },
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`FUNVISIS ${res.status}`);
  const json: any = await res.json();
  const features: any[] = Array.isArray(json?.features) ? json.features : [];

  const events: SeismicEvent[] = [];
  const raw: any[] = [];
  for (const f of features) {
    const ev = normalizeFunvisisFeature(f);
    if (ev) { events.push(ev); raw.push(f); }
  }
  // Newest first, matching the USGS path.
  const order = events.map((e, i) => i).sort((a, b) => events[b].time_ms - events[a].time_ms);
  return { events: order.map((i) => events[i]), raw: order.map((i) => raw[i]) };
}
