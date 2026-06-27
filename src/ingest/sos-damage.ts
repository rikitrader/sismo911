import type { Env } from '../types';
const SRC = 'https://sosvenezuela2026.com/api/reports';
// Drop coordinates outside Venezuela's bounding box (bad geocodes in the upstream
// feed, e.g. a La Guaira collapse published at lat 50.9 in Europe). Out-of-range
// points become unmapped (null) instead of plotting a false marker on the map.
const veCoord = (la: any, lo: any): [number | null, number | null] => {
  const a = Number(la), o = Number(lo);
  return Number.isFinite(a) && Number.isFinite(o) && a >= 0 && a <= 13 && o >= -74 && o <= -59
    ? [a, o] : [null, null];
};
// Known upstream geocode corrections — applied only when the published coord is
// out of bounds, so a corrected point is never re-broken on the next sync. Each
// is placed at the neighborhood named in its own report (no fabricated location).
const COORD_FIX: Record<string, [number, number]> = {
  // "Residencia Tamar, calle Las Acacias, Tanaguarenas, Caraballeda, La Guaira"
  // — total collapse published at lat 50.9 / lng 10.0 (Europe). Tanaguarenas:
  '00c8a444-0799-4ce9-9f26-57fa77ed690a': [10.614, -66.826],
};
export async function ingestSosDamage(env: Env): Promise<{ count: number }> {
  const res = await fetch(SRC, { headers: { 'User-Agent': 'SISMO911/1.0 (emergency monitoring)', Accept: 'application/json' }, cf: { cacheTtl: 120 } });
  if (!res.ok) throw new Error(`sosvenezuela2026 ${res.status}`);
  const items: any[] = await res.json();
  if (!Array.isArray(items) || !items.length) return { count: 0 };
  const now = Date.now();
  const stmt = env.DB.prepare(
    `INSERT INTO sos_damage (id,category,severity,resource_status,verification,title,description,lat,lng,municipio,parroquia,building_type,people_trapped,source_url,image_url,created_at,synced_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET category=excluded.category, severity=excluded.severity, resource_status=excluded.resource_status, verification=excluded.verification, title=excluded.title, description=excluded.description, lat=excluded.lat, lng=excluded.lng, municipio=excluded.municipio, parroquia=excluded.parroquia, building_type=excluded.building_type, people_trapped=excluded.people_trapped, source_url=excluded.source_url, image_url=excluded.image_url, synced_ms=excluded.synced_ms`
  );
  const batch = items.map((r) => {
    let [lat, lng] = veCoord(r.lat_pub, r.lng_pub);
    if (lat === null && COORD_FIX[r.id]) [lat, lng] = COORD_FIX[r.id];
    return stmt.bind(
    r.id, r.category ?? null, r.severity ?? null, r.resource_status ?? null, r.verification ?? null,
    r.title ?? null, r.description ?? null, lat, lng,
    r.municipio ?? null, r.parroquia ?? null, r.building_type ?? null, r.people_trapped_count ?? null,
    r.source_url ?? null, r.image_url ?? null, r.created_at ?? null, now
  );
  });
  for (let i = 0; i < batch.length; i += 500) await env.DB.batch(batch.slice(i, i + 500));
  return { count: batch.length };
}
