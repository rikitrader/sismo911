import { Hono } from 'hono';
import type { Env } from '../types';

export const facilities = new Hono<{ Bindings: Env }>();

// Map an OSM amenity/emergency tag to a friendly emergency-services kind.
const KIND: Record<string, string> = {
  hospital: 'salud', clinic: 'salud', doctors: 'salud', pharmacy: 'farmacia',
  police: 'policia', fire_station: 'bomberos', ambulance_station: 'ambulancia',
  shelter: 'refugio_osm',
};

// GET /api/facilities?lat=&lon=&radius=10000 — nearby emergency services from
// OpenStreetMap via Overpass (free): hospitals, clinics, pharmacies, police,
// fire stations, ambulance stations and shelters. Cached in KV for 1h.
facilities.get('/', async (c) => {
  const lat = Number(c.req.query('lat'));
  const lon = Number(c.req.query('lon'));
  if (Number.isNaN(lat) || Number.isNaN(lon)) return c.json({ error: 'lat_lon_required' }, 400);
  const radius = Math.min(50000, Number(c.req.query('radius') ?? 10000));

  const key = `osm:v3:${lat.toFixed(2)}:${lon.toFixed(2)}:${radius}`;
  const cached: any = await c.env.CACHE.get(key, 'json');
  if (cached?.facilities?.length) return c.json(cached); // never serve a cached failure

  const q = `[out:json][timeout:25];(
    node["amenity"="hospital"](around:${radius},${lat},${lon});
    node["amenity"="clinic"](around:${radius},${lat},${lon});
    node["amenity"="doctors"](around:${radius},${lat},${lon});
    node["amenity"="pharmacy"](around:${radius},${lat},${lon});
    node["amenity"="police"](around:${radius},${lat},${lon});
    node["amenity"="fire_station"](around:${radius},${lat},${lon});
    node["emergency"="ambulance_station"](around:${radius},${lat},${lon});
    node["emergency"="shelter"](around:${radius},${lat},${lon});
    node["amenity"="shelter"](around:${radius},${lat},${lon});
  );out body 120;`;

  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ];
  let list: any[] = [];
  let upstream = '';
  for (const ep of endpoints) {
    try {
      const r = await fetch(ep, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(q),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'SISMO911/1.0 (emergency mapping; contact admin@sismo911.com)',
        },
      });
      upstream = `${ep.split('/')[2]}:${r.status}`;
      if (r.ok) {
        const j: any = await r.json();
        list = (j.elements ?? []).map((e: any) => {
          const type = e.tags?.amenity || e.tags?.emergency || 'facility';
          return {
            id: e.id,
            type,
            kind: KIND[type] || 'otro',
            name: e.tags?.name || '(sin nombre)',
            lat: e.lat, lon: e.lon,
            phone: e.tags?.phone || e.tags?.['contact:phone'] || null,
          };
        });
        if (list.length) break;
      }
    } catch (e: any) { upstream = `${ep.split('/')[2]}:err`; }
  }

  const payload = { updated_ms: Date.now(), count: list.length, facilities: list, upstream };
  if (list.length) await c.env.CACHE.put(key, JSON.stringify(payload), { expirationTtl: 3600 });
  return c.json(payload);
});
