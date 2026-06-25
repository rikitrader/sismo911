import type { Env } from '../types';
const SRC = 'https://sosvenezuela2026.com/api/reports';
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
  const batch = items.map((r) => stmt.bind(
    r.id, r.category ?? null, r.severity ?? null, r.resource_status ?? null, r.verification ?? null,
    r.title ?? null, r.description ?? null, r.lat_pub ?? null, r.lng_pub ?? null,
    r.municipio ?? null, r.parroquia ?? null, r.building_type ?? null, r.people_trapped_count ?? null,
    r.source_url ?? null, r.image_url ?? null, r.created_at ?? null, now
  ));
  for (let i = 0; i < batch.length; i += 500) await env.DB.batch(batch.slice(i, i + 500));
  return { count: batch.length };
}
