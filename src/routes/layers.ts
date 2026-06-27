import { Hono } from 'hono';
import type { Env } from '../types';
import { ESTADOS, type Estado } from '../data/estados';

export const layers = new Hono<{ Bindings: Env }>();

type Center = {
  id: string;
  nombre?: string | null;
  tipo?: string | null;
  estado?: string | null;
  ciudad?: string | null;
  dir?: string | null;
  lat: number;
  lon: number;
  cap?: string | null;
  status?: string | null;
};

type Feature = {
  type: 'Feature';
  geometry:
    | { type: 'Point'; coordinates: [number, number] }
    | { type: 'LineString'; coordinates: [number, number][] }
    | { type: 'Polygon'; coordinates: [number, number][][] };
  properties: Record<string, unknown>;
};

type StateMetrics = {
  critical_reports: number;
  trapped_reports: number;
  unresolved_sos: number;
  need_help_checkins: number;
  stressed_shelters: number;
  critical_resources: number;
  stressed_acopio: number;
};

export type LayerCatalogEntry = {
  id: string;
  title: string;
  domain: 'geoseismic' | 'humanitarian' | 'logistics' | 'lifelines' | 'readiness';
  endpoint: string;
  include: string[];
  geometry: ('Point' | 'LineString' | 'Polygon')[];
  refresh_seconds: number;
  privacy: string;
  public: boolean;
  source: string[];
  description: string;
};

const validPoint = (lat: unknown, lon: unknown) =>
  Number.isFinite(Number(lat)) && Number.isFinite(Number(lon)) && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lon)) <= 180;
const fc = (features: Feature[]) => ({ type: 'FeatureCollection', features });
const str = (v: unknown, max = 120) => v == null ? null : String(v).trim().slice(0, max) || null;
const rad = (deg: number) => deg * Math.PI / 180;
const deg = (radians: number) => radians * 180 / Math.PI;

function wanted(raw: string | undefined, defaults: string[]) {
  const set = new Set((raw || defaults.join(',')).split(',').map((s) => s.trim()).filter(Boolean));
  return (key: string) => set.has('all') || set.has(key);
}

function counts(features: Feature[]) {
  return features.reduce((a, f) => {
    const key = String(f.properties.layer || 'unknown');
    a[key] = (a[key] ?? 0) + 1;
    return a;
  }, {} as Record<string, number>);
}

const norm = (v: unknown) => String(v ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '');

const stateBySlug = new Map(ESTADOS.map((s) => [s.slug, s]));
const stateByName = new Map(ESTADOS.map((s) => [norm(s.name), s]));

function emptyStateMetrics(): StateMetrics {
  return {
    critical_reports: 0,
    trapped_reports: 0,
    unresolved_sos: 0,
    need_help_checkins: 0,
    stressed_shelters: 0,
    critical_resources: 0,
    stressed_acopio: 0,
  };
}

function stateFromName(name: unknown): Estado | null {
  if (!name) return null;
  return stateByName.get(norm(name)) ?? stateBySlug.get(norm(name)) ?? null;
}

function stateFromPoint(lat: unknown, lon: unknown): Estado | null {
  if (!validPoint(lat, lon)) return null;
  const la = Number(lat);
  const lo = Number(lon);
  return ESTADOS.find((s) => lo >= s.bbox[0] && lo <= s.bbox[2] && la >= s.bbox[1] && la <= s.bbox[3]) ?? null;
}

function stateMetricsScore(m: StateMetrics) {
  return m.critical_reports * 5 +
    m.trapped_reports * 7 +
    m.unresolved_sos * 5 +
    m.need_help_checkins * 3 +
    m.stressed_shelters * 2 +
    m.critical_resources +
    m.stressed_acopio * 2;
}

function stateSeverity(score: number) {
  if (score >= 15) return 'emergency';
  if (score >= 6) return 'elevated';
  if (score >= 1) return 'watch';
  return 'normal';
}

const nationalCenter = { lat: 8.5, lon: -66.5 };

export const LAYER_CATALOG: LayerCatalogEntry[] = [
  {
    id: 'geoseismic_events',
    title: 'Eventos sísmicos',
    domain: 'geoseismic',
    endpoint: '/api/layers/geoseismic?include=events&limit=220',
    include: ['events'],
    geometry: ['Point'],
    refresh_seconds: 30,
    privacy: 'public_event_no_pii',
    public: true,
    source: ['events'],
    description: 'Epicentros públicos con magnitud, profundidad, hora y severidad operacional.',
  },
  {
    id: 'geoseismic_impact',
    title: 'Impacto sísmico estimado',
    domain: 'geoseismic',
    endpoint: '/api/layers/geoseismic?include=impact&impactMinMag=4&limit=220',
    include: ['impact'],
    geometry: ['Polygon'],
    refresh_seconds: 30,
    privacy: 'public_model_no_pii',
    public: true,
    source: ['events', 'sismo911_provisional_radius_v1'],
    description: 'Polígonos provisionales de radio de impacto para orientar priorización inicial.',
  },
  {
    id: 'satellite_damage',
    title: 'Daño satelital IA',
    domain: 'geoseismic',
    endpoint: '/api/layers/geoseismic?include=satellite_damage&limit=220',
    include: ['satellite_damage'],
    geometry: ['Point', 'Polygon'],
    refresh_seconds: 30,
    privacy: 'public_assessment_no_pii',
    public: true,
    source: ['sat_damage', 'Workers AI/PyTorch external pipeline'],
    description: 'Chips o huellas de daño inferido por IA con estado de verificación.',
  },
  {
    id: 'operational_acopio',
    title: 'Centros de acopio',
    domain: 'logistics',
    endpoint: '/api/layers/operational?include=acopio',
    include: ['acopio'],
    geometry: ['Point'],
    refresh_seconds: 30,
    privacy: 'public_facility_no_pii',
    public: true,
    source: ['acopio-data.json', 'acopio_submissions', 'acopio_status'],
    description: 'Centros publicados y aprobados con estado operativo agregado.',
  },
  {
    id: 'operational_needs',
    title: 'Necesidades logísticas',
    domain: 'logistics',
    endpoint: '/api/layers/operational?include=needs',
    include: ['needs'],
    geometry: ['Point'],
    refresh_seconds: 30,
    privacy: 'public_need_no_personal_details',
    public: true,
    source: ['acopio_needs'],
    description: 'Necesidades abiertas por centro, producto, cantidad y prioridad.',
  },
  {
    id: 'operational_shipments',
    title: 'Envíos activos',
    domain: 'logistics',
    endpoint: '/api/layers/operational?include=shipments',
    include: ['shipments'],
    geometry: ['LineString'],
    refresh_seconds: 30,
    privacy: 'public_flow_no_personal_details',
    public: true,
    source: ['acopio_shipments'],
    description: 'Flujos activos entre origen y destino sin exponer datos personales.',
  },
  {
    id: 'operational_resources',
    title: 'Recursos públicos',
    domain: 'logistics',
    endpoint: '/api/layers/operational?include=resources',
    include: ['resources'],
    geometry: ['Point'],
    refresh_seconds: 30,
    privacy: 'public_resource_no_pii',
    public: true,
    source: ['resources'],
    description: 'Inventario público georreferenciado de recursos disponibles, bajos o agotados.',
  },
  {
    id: 'humanitarian_signals',
    title: 'Señales humanitarias',
    domain: 'humanitarian',
    endpoint: '/api/layers/humanitarian?include=signals&limit=300',
    include: ['signals'],
    geometry: ['Point'],
    refresh_seconds: 30,
    privacy: 'coarse_aggregate_no_pii',
    public: true,
    source: ['sos_alerts', 'checkins'],
    description: 'SOS y check-ins agregados en celdas aproximadas; nunca expone texto libre ni identidad.',
  },
  {
    id: 'state_posture',
    title: 'Postura por estado',
    domain: 'readiness',
    endpoint: '/api/layers/state-posture?limit=25',
    include: ['state_posture'],
    geometry: ['Point'],
    refresh_seconds: 30,
    privacy: 'state_aggregate_no_pii',
    public: true,
    source: ['map_reports', 'sos_alerts', 'checkins', 'shelter_status', 'resources', 'acopio_status'],
    description: 'Score estatal agregado para priorización del COP nacional.',
  },
  {
    id: 'lifelines',
    title: 'Lifelines ESF',
    domain: 'lifelines',
    endpoint: '/api/layers/lifelines?include=health,comms,resources,acopio&limit=800',
    include: ['health', 'comms', 'resources', 'acopio'],
    geometry: ['Point'],
    refresh_seconds: 30,
    privacy: 'public_lifeline_no_pii',
    public: true,
    source: ['acopio catalog', 'resources', 'comms_channels'],
    description: 'Infraestructura ESF-2/6/7/8, recursos y comunicaciones regionales agregadas.',
  },
];

export function buildLayerCatalog() {
  const byDomain = LAYER_CATALOG.reduce((acc, layer) => {
    acc[layer.domain] = (acc[layer.domain] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  return {
    scope: 'public_cop_layer_catalog',
    generated_ms: Date.now(),
    version: '2026-06-27',
    refresh_seconds: 30,
    count: LAYER_CATALOG.length,
    by_domain: byDomain,
    layers: LAYER_CATALOG,
  };
}

export function centerFeature(c: Center): Feature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [Number(c.lon), Number(c.lat)] },
    properties: {
      layer: 'acopio',
      id: c.id,
      name: c.nombre ?? c.id,
      type: c.tipo ?? 'centro',
      estado: c.estado ?? null,
      ciudad: c.ciudad ?? null,
      address: c.dir ?? null,
      capacity: c.cap ?? null,
      status: c.status ?? 'operativo',
    },
  };
}

export function needFeature(center: Center, need: any): Feature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [Number(center.lon), Number(center.lat)] },
    properties: {
      layer: 'need',
      id: need.id,
      center_id: need.center_id,
      center_name: center.nombre ?? need.center_id,
      commodity: need.commodity,
      qty: Number(need.qty ?? 0),
      priority: Number(need.priority ?? 2),
      status: need.status ?? 'open',
      note: need.note ?? null,
    },
  };
}

export function shipmentFeature(origin: Center, dest: Center, ship: any): Feature {
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: [[Number(origin.lon), Number(origin.lat)], [Number(dest.lon), Number(dest.lat)]] },
    properties: {
      layer: 'shipment',
      id: ship.id,
      status: ship.status,
      origin_id: ship.origin_id,
      dest_id: ship.dest_id,
      origin_name: origin.nombre ?? ship.origin_id,
      dest_name: dest.nombre ?? ship.dest_id,
      vehicle: ship.vehicle ?? null,
      driver: ship.driver ?? null,
      eta_ms: ship.eta_ms ?? null,
    },
  };
}

export function resourceFeature(resource: any): Feature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [Number(resource.lon), Number(resource.lat)] },
    properties: {
      layer: 'resource',
      id: resource.id,
      kind: str(resource.kind, 60) ?? 'recurso',
      label: str(resource.label, 120) ?? resource.id,
      quantity: Number(resource.quantity ?? 0),
      status: str(resource.status, 30) ?? 'available',
      region: str(resource.region, 80),
      updated_ms: resource.updated_ms ?? null,
    },
  };
}

export function lifelineFeature(row: any): Feature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [Number(row.lon), Number(row.lat)] },
    properties: {
      layer: 'lifeline',
      id: str(row.id, 120) ?? `lifeline:${str(row.category, 40) ?? 'unknown'}`,
      category: str(row.category, 40) ?? 'lifeline',
      name: str(row.name, 160) ?? 'Infraestructura crítica',
      type: str(row.type, 80),
      status: str(row.status, 40) ?? 'unknown',
      region: str(row.region, 100),
      count: row.count == null ? null : Number(row.count),
      source: str(row.source, 80) ?? 'sismo911',
      privacy: row.privacy ?? 'public_facility_no_pii',
    },
  };
}

export function quakeSeverity(event: any) {
  const mag = Number(event.mag ?? 0);
  const alert = String(event.alert ?? '').toLowerCase();
  if (alert === 'red' || mag >= 7) return 'critical';
  if (alert === 'orange' || mag >= 6) return 'severe';
  if (alert === 'yellow' || mag >= 5) return 'elevated';
  return 'monitor';
}

export function impactRadiusKm(event: any) {
  const mag = Math.max(0, Number(event.mag ?? 0));
  const depth = Math.max(0, Number(event.depth_km ?? 10));
  const base = Math.pow(mag, 2.15) * 3.4;
  const depthFactor = Math.max(0.35, 1 - Math.min(depth, 160) / 230);
  return Math.round(Math.max(8, Math.min(420, base * depthFactor)));
}

function circlePolygon(lat: number, lon: number, radiusKm: number, steps = 48): [number, number][][] {
  const earthKm = 6371;
  const lat1 = rad(lat);
  const lon1 = rad(lon);
  const d = radiusKm / earthKm;
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const brng = 2 * Math.PI * (i / steps);
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
    const lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    ring.push([Number(deg(lon2).toFixed(5)), Number(deg(lat2).toFixed(5))]);
  }
  return [ring];
}

export function quakeFeature(event: any): Feature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [Number(event.lon), Number(event.lat)] },
    properties: {
      layer: 'quake',
      id: event.id,
      source: str(event.source, 20),
      magnitude: Number(event.mag ?? 0),
      place: str(event.place_es ?? event.place, 180) ?? 'Evento sísmico',
      time_ms: event.time_ms ?? null,
      depth_km: event.depth_km ?? null,
      mmi: event.mmi ?? null,
      alert: str(event.alert, 20),
      tsunami: Number(event.tsunami ?? 0) ? 1 : 0,
      severity: quakeSeverity(event),
      url: str(event.url, 240),
    },
  };
}

export function impactFeature(event: any): Feature {
  const radiusKm = impactRadiusKm(event);
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: circlePolygon(Number(event.lat), Number(event.lon), radiusKm) },
    properties: {
      layer: 'impact',
      id: `impact:${event.id}`,
      event_id: event.id,
      magnitude: Number(event.mag ?? 0),
      place: str(event.place_es ?? event.place, 180) ?? 'Evento sísmico',
      time_ms: event.time_ms ?? null,
      depth_km: event.depth_km ?? null,
      mmi: event.mmi ?? null,
      alert: str(event.alert, 20),
      tsunami: Number(event.tsunami ?? 0) ? 1 : 0,
      severity: quakeSeverity(event),
      radius_km: radiusKm,
      model: 'sismo911_provisional_radius_v1',
      advisory: 'Estimación operacional no oficial; verificar con ShakeMap/FUNVISIS/USGS cuando esté disponible.',
    },
  };
}

export function satelliteDamageFeature(row: any): Feature {
  const hasBbox = [row.bbox_w, row.bbox_s, row.bbox_e, row.bbox_n].every((v) => Number.isFinite(Number(v)));
  const geometry = hasBbox
    ? {
      type: 'Polygon' as const,
      coordinates: [[
        [Number(row.bbox_w), Number(row.bbox_s)],
        [Number(row.bbox_e), Number(row.bbox_s)],
        [Number(row.bbox_e), Number(row.bbox_n)],
        [Number(row.bbox_w), Number(row.bbox_n)],
        [Number(row.bbox_w), Number(row.bbox_s)],
      ]] as [number, number][][],
    }
    : { type: 'Point' as const, coordinates: [Number(row.lon), Number(row.lat)] as [number, number] };
  return {
    type: 'Feature',
    geometry,
    properties: {
      layer: 'satellite_damage',
      id: row.id,
      severity: str(row.severity, 30) ?? 'indeterminado',
      summary: str(row.summary, 500),
      hazards: row.hazards ?? null,
      imagery_source: str(row.imagery_source, 80),
      imagery_date: str(row.imagery_date, 40),
      event_id: str(row.event_id, 120),
      model: str(row.ai_model, 160),
      verification: str(row.verification, 30) ?? 'unverified',
      created_ms: row.created_ms ?? null,
    },
  };
}

export function humanitarianSignalFeature(row: any): Feature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [Number(row.lon_bucket), Number(row.lat_bucket)] },
    properties: {
      layer: 'humanitarian_signal',
      source: str(row.source, 30) ?? 'signal',
      status: str(row.status, 40) ?? 'unknown',
      count: Number(row.n ?? 0),
      precision: '0.1deg',
      privacy: 'coarse_aggregate_no_pii',
      latest_ms: row.latest_ms ?? null,
    },
  };
}

export function statePostureFeature(state: Estado, metrics: StateMetrics): Feature {
  const score = stateMetricsScore(metrics);
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [state.center[1], state.center[0]] },
    properties: {
      layer: 'state_posture',
      slug: state.slug,
      name: state.name,
      severity: stateSeverity(score),
      score,
      metrics,
      municipios: state.municipios,
      places: state.places,
      privacy: 'state_aggregate_no_pii',
    },
  };
}

async function loadCenters(env: Env, req: Request): Promise<Map<string, Center>> {
  const centers = new Map<string, Center>();
  try {
    const res = await env.ASSETS.fetch(new Request(new URL('/acopio-data.json', req.url).toString()));
    if (res.ok) {
      const rows = await res.json() as any[];
      for (const r of rows) {
        if (r?.id && validPoint(r.lat, r.lon)) centers.set(String(r.id), {
          id: String(r.id), nombre: str(r.nombre), tipo: str(r.tipo, 40), estado: str(r.estado, 80),
          ciudad: str(r.ciudad, 80), dir: str(r.dir, 240), lat: Number(r.lat), lon: Number(r.lon), cap: str(r.cap, 80),
        });
      }
    }
  } catch { /* static catalog is optional in tests and degraded environments */ }
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, nombre, tipo, estado, ciudad, dir, lat, lon, note
       FROM acopio_submissions WHERE status='approved' AND lat IS NOT NULL AND lon IS NOT NULL ORDER BY created_ms DESC LIMIT 1000`
    ).all();
    for (const r of results ?? []) {
      const row = r as any;
      if (row.id && validPoint(row.lat, row.lon)) centers.set(String(row.id), {
        id: String(row.id), nombre: str(row.nombre), tipo: str(row.tipo, 40), estado: str(row.estado, 80),
        ciudad: str(row.ciudad, 80), dir: str(row.dir, 240), lat: Number(row.lat), lon: Number(row.lon), cap: str(row.note, 80),
      });
    }
  } catch { /* acopio_submissions may not exist before migrations finish */ }
  try {
    const { results } = await env.DB.prepare(`SELECT id, status FROM acopio_status`).all();
    for (const r of results ?? []) {
      const row = r as any;
      const c = centers.get(String(row.id));
      if (c) c.status = str(row.status, 20) ?? 'operativo';
    }
  } catch { /* status is optional */ }
  return centers;
}

// GET /api/layers/catalog
// Public COP layer manifest: the browser, operators and third-party responders
// can discover every public layer contract, privacy class and refresh cadence
// without scraping HTML or source code.
layers.get('/catalog', (c) => {
  return new Response(JSON.stringify(buildLayerCatalog()), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
});

// GET /api/layers/operational?include=acopio,needs,shipments,resources
// Unified public GeoJSON for the map: static/public acopio centers, open needs,
// active shipment flow lines, and public resource inventory. Kept under one endpoint so the browser can
// toggle operational layers without issuing many independent D1/static reads.
layers.get('/operational', async (c) => {
  const include = wanted(c.req.query('include'), ['acopio', 'needs', 'shipments', 'resources']);
  const limit = Math.min(2000, Math.max(1, Number(c.req.query('limit') ?? 1200)));
  const centers = await loadCenters(c.env, c.req.raw);
  const features: Feature[] = [];

  if (include('acopio')) {
    for (const center of centers.values()) {
      if (features.length >= limit) break;
      features.push(centerFeature(center));
    }
  }

  if (include('needs') && features.length < limit) {
    const { results } = await c.env.DB.prepare(
      `SELECT id, center_id, commodity, qty, priority, status, note
       FROM acopio_needs WHERE status='open' ORDER BY priority, created_ms DESC LIMIT 1000`
    ).all().catch(() => ({ results: [] }));
    for (const need of results ?? []) {
      if (features.length >= limit) break;
      const center = centers.get(String((need as any).center_id));
      if (center) features.push(needFeature(center, need));
    }
  }

  if (include('shipments') && features.length < limit) {
    const { results } = await c.env.DB.prepare(
      `SELECT id, origin_id, dest_id, status, vehicle, driver, eta_ms
       FROM acopio_shipments WHERE status IN ('creado','despachado','en_transito') ORDER BY updated_ms DESC LIMIT 500`
    ).all().catch(() => ({ results: [] }));
    for (const ship of results ?? []) {
      if (features.length >= limit) break;
      const row = ship as any;
      const origin = centers.get(String(row.origin_id));
      const dest = centers.get(String(row.dest_id));
      if (origin && dest) features.push(shipmentFeature(origin, dest, row));
    }
  }

  if (include('resources') && features.length < limit) {
    const { results } = await c.env.DB.prepare(
      `SELECT id, kind, label, quantity, status, region, lat, lon, updated_ms
       FROM resources WHERE lat IS NOT NULL AND lon IS NOT NULL ORDER BY updated_ms DESC LIMIT 1000`
    ).all().catch(() => ({ results: [] }));
    for (const resource of results ?? []) {
      if (features.length >= limit) break;
      const row = resource as any;
      if (validPoint(row.lat, row.lon)) features.push(resourceFeature(row));
    }
  }

  return c.json({
    ...fc(features),
    generated_ms: Date.now(),
    counts: counts(features),
  }, 200, { 'Cache-Control': 'public, max-age=30' });
});

// GET /api/layers/geoseismic?include=events,impact,satellite_damage&minMag=4
// Public GeoJSON product derived from D1 seismic rows. The impact polygons are
// provisional radius estimates, not official ShakeMap contours. Satellite
// damage chips are operator/AI/PyTorch assessments from sat_damage.
layers.get('/geoseismic', async (c) => {
  const include = wanted(c.req.query('include'), ['events', 'impact', 'satellite_damage']);
  const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 200)));
  const minMag = Math.max(0, Number(c.req.query('minMag') ?? 0));
  const impactMinMag = Math.max(0, Number(c.req.query('impactMinMag') ?? c.req.query('minMag') ?? 4));
  const features: Feature[] = [];

  const { results } = await c.env.DB.prepare(
    `SELECT id, source, mag, place, place_es, time_ms, lat, lon, depth_km, mmi, alert, tsunami, url
     FROM events WHERE lat IS NOT NULL AND lon IS NOT NULL AND mag IS NOT NULL AND mag >= ?
     ORDER BY time_ms DESC LIMIT ?`
  ).bind(minMag, limit).all().catch(() => ({ results: [] }));

  for (const event of results ?? []) {
    const row = event as any;
    if (!validPoint(row.lat, row.lon)) continue;
    if (include('impact') && Number(row.mag ?? 0) >= impactMinMag) features.push(impactFeature(row));
    if (include('events')) features.push(quakeFeature(row));
  }

  if (include('satellite_damage') && features.length < limit) {
    const { results } = await c.env.DB.prepare(
      `SELECT id, lat, lon, zoom, bbox_n, bbox_s, bbox_e, bbox_w, severity, summary,
              hazards, imagery_source, imagery_date, event_id, ai_model, verification, created_ms
       FROM sat_damage WHERE lat IS NOT NULL AND lon IS NOT NULL
       ORDER BY created_ms DESC LIMIT 500`
    ).all().catch(() => ({ results: [] }));
    for (const item of results ?? []) {
      if (features.length >= limit) break;
      const row = item as any;
      if (validPoint(row.lat, row.lon)) features.push(satelliteDamageFeature(row));
    }
  }

  return c.json({
    ...fc(features),
    generated_ms: Date.now(),
    minMag,
    impactMinMag,
    counts: counts(features),
  }, 200, { 'Cache-Control': 'public, max-age=30' });
});

// GET /api/layers/humanitarian?include=signals
// Public humanitarian signal layer. This intentionally avoids victim-level
// records: exact SOS/check-in coordinates and free-text PII are collapsed into
// 0.1 degree buckets before they leave D1.
layers.get('/humanitarian', async (c) => {
  const include = wanted(c.req.query('include'), ['signals']);
  const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 300)));
  const features: Feature[] = [];

  if (include('signals')) {
    const { results } = await c.env.DB.prepare(
      `SELECT 'sos' AS source, COALESCE(status, 'active') AS status,
              ROUND(lat, 1) AS lat_bucket, ROUND(lon, 1) AS lon_bucket,
              COUNT(*) AS n, MAX(COALESCE(updated_ms, created_ms)) AS latest_ms
       FROM sos_alerts
       WHERE COALESCE(status, 'active') != 'resolved'
         AND lat IS NOT NULL AND lon IS NOT NULL
       GROUP BY source, status, lat_bucket, lon_bucket
       UNION ALL
       SELECT 'checkin' AS source, COALESCE(status, 'unknown') AS status,
              ROUND(lat, 1) AS lat_bucket, ROUND(lon, 1) AS lon_bucket,
              COUNT(*) AS n, MAX(created_ms) AS latest_ms
       FROM checkins
       WHERE lat IS NOT NULL AND lon IS NOT NULL
       GROUP BY source, status, lat_bucket, lon_bucket
       ORDER BY latest_ms DESC
       LIMIT ?`
    ).bind(limit).all().catch(() => ({ results: [] }));

    for (const item of results ?? []) {
      const row = item as any;
      if (validPoint(row.lat_bucket, row.lon_bucket)) features.push(humanitarianSignalFeature(row));
    }
  }

  return c.json({
    ...fc(features),
    generated_ms: Date.now(),
    privacy: 'coarse_aggregate_no_pii',
    counts: counts(features),
  }, 200, { 'Cache-Control': 'public, max-age=30' });
});

// GET /api/layers/state-posture
// Coarse state-level operating picture for public dashboards. This aggregates
// report, SOS/check-in, shelter, resource and acopio stress into one point per
// federal entity. It never exposes incident-level coordinates or free text.
layers.get('/state-posture', async (c) => {
  const limit = Math.min(25, Math.max(1, Number(c.req.query('limit') ?? 25)));
  const metrics = new Map(ESTADOS.map((s) => [s.slug, emptyStateMetrics()]));
  const add = (state: Estado | null, field: keyof StateMetrics, n = 1) => {
    if (!state) return;
    const m = metrics.get(state.slug);
    if (m) m[field] += n;
  };

  const [
    reports,
    sos,
    checkins,
    shelters,
    resources,
  ] = await Promise.all([
    c.env.DB.prepare(
      `SELECT estado,
              COALESCE(SUM(CASE WHEN severity='rojo' THEN 1 ELSE 0 END), 0) AS critical_reports,
              COALESCE(SUM(CASE WHEN category='trapped_people' OR people_trapped > 0 THEN 1 ELSE 0 END), 0) AS trapped_reports
       FROM map_reports WHERE status='approved' GROUP BY estado`
    ).all().catch(() => ({ results: [] })),
    c.env.DB.prepare(
      `SELECT lat, lon, status FROM sos_alerts
       WHERE COALESCE(status, 'active') != 'resolved' AND lat IS NOT NULL AND lon IS NOT NULL`
    ).all().catch(() => ({ results: [] })),
    c.env.DB.prepare(
      `SELECT lat, lon, status FROM checkins
       WHERE status='need_help' AND lat IS NOT NULL AND lon IS NOT NULL`
    ).all().catch(() => ({ results: [] })),
    c.env.DB.prepare(
      `SELECT lat, lon, status FROM shelter_status
       WHERE moderation='approved' AND status IN ('lleno','cerrado') AND lat IS NOT NULL AND lon IS NOT NULL`
    ).all().catch(() => ({ results: [] })),
    c.env.DB.prepare(
      `SELECT region, lat, lon, status FROM resources
       WHERE status IN ('low','depleted')`
    ).all().catch(() => ({ results: [] })),
  ]);

  for (const row of reports.results ?? []) {
    const r = row as any;
    const state = stateFromName(r.estado);
    add(state, 'critical_reports', Number(r.critical_reports ?? 0));
    add(state, 'trapped_reports', Number(r.trapped_reports ?? 0));
  }
  for (const row of sos.results ?? []) add(stateFromPoint((row as any).lat, (row as any).lon), 'unresolved_sos');
  for (const row of checkins.results ?? []) add(stateFromPoint((row as any).lat, (row as any).lon), 'need_help_checkins');
  for (const row of shelters.results ?? []) add(stateFromPoint((row as any).lat, (row as any).lon), 'stressed_shelters');
  for (const row of resources.results ?? []) {
    const r = row as any;
    add(stateFromName(r.region) ?? stateFromPoint(r.lat, r.lon), 'critical_resources');
  }

  const centers = await loadCenters(c.env, c.req.raw);
  for (const center of centers.values()) {
    if (['saturado', 'cerrado'].includes(center.status ?? '')) add(stateFromName(center.estado) ?? stateFromPoint(center.lat, center.lon), 'stressed_acopio');
  }

  const features = ESTADOS
    .map((state) => statePostureFeature(state, metrics.get(state.slug) ?? emptyStateMetrics()))
    .sort((a, b) => Number(b.properties.score ?? 0) - Number(a.properties.score ?? 0))
    .slice(0, limit);

  return c.json({
    ...fc(features),
    generated_ms: Date.now(),
    privacy: 'state_aggregate_no_pii',
    counts: counts(features),
  }, 200, { 'Cache-Control': 'public, max-age=30' });
});

// GET /api/layers/lifelines?include=health,comms,resources,acopio
// Public lifeline infrastructure overlay for ESF-2/6/7/8 operations. It only
// emits public facility/resource names and regional comms aggregates; no phones,
// contact names, notes or victim-level records are included.
layers.get('/lifelines', async (c) => {
  const include = wanted(c.req.query('include'), ['health', 'comms', 'resources', 'acopio']);
  const limit = Math.min(1500, Math.max(1, Number(c.req.query('limit') ?? 800)));
  const features: Feature[] = [];
  const centers = await loadCenters(c.env, c.req.raw);

  if ((include('health') || include('acopio')) && features.length < limit) {
    for (const center of centers.values()) {
      if (features.length >= limit) break;
      const tipo = String(center.tipo ?? '').toLowerCase();
      const isHealth = /hospital|clinica|cl[ií]nica|salud|ambulatorio|medic/.test(tipo);
      const isAcopio = !isHealth;
      if ((isHealth && include('health')) || (isAcopio && include('acopio'))) {
        features.push(lifelineFeature({
          id: center.id,
          category: isHealth ? 'health' : 'acopio',
          name: center.nombre ?? center.id,
          type: center.tipo ?? 'centro',
          status: center.status ?? 'operativo',
          region: center.estado ?? center.ciudad ?? null,
          lat: center.lat,
          lon: center.lon,
          source: 'acopio_catalog',
        }));
      }
    }
  }

  if (include('resources') && features.length < limit) {
    const { results } = await c.env.DB.prepare(
      `SELECT id, kind, label, quantity, status, region, lat, lon, updated_ms
       FROM resources WHERE lat IS NOT NULL AND lon IS NOT NULL ORDER BY updated_ms DESC LIMIT 1000`
    ).all().catch(() => ({ results: [] }));
    for (const resource of results ?? []) {
      if (features.length >= limit) break;
      const row = resource as any;
      if (!validPoint(row.lat, row.lon)) continue;
      features.push(lifelineFeature({
        id: row.id,
        category: 'resource',
        name: row.label,
        type: row.kind,
        status: row.status,
        region: row.region,
        lat: row.lat,
        lon: row.lon,
        source: 'resources',
      }));
    }
  }

  if (include('comms') && features.length < limit) {
    const { results } = await c.env.DB.prepare(
      `SELECT region, band, COUNT(*) AS n, GROUP_CONCAT(DISTINCT mode) AS modes
       FROM comms_channels GROUP BY region, band ORDER BY region, band LIMIT 300`
    ).all().catch(() => ({ results: [] }));
    for (const item of results ?? []) {
      if (features.length >= limit) break;
      const row = item as any;
      const state = stateFromName(row.region);
      features.push(lifelineFeature({
        id: `comms:${row.region ?? 'national'}:${row.band ?? 'band'}`,
        category: 'comms',
        name: `${row.band ?? 'Comms'} ${row.region ?? 'Nacional'}`,
        type: row.modes ?? row.band ?? 'comms',
        status: 'available',
        region: row.region ?? 'Nacional',
        count: row.n,
        lat: state?.center[0] ?? nationalCenter.lat,
        lon: state?.center[1] ?? nationalCenter.lon,
        source: 'comms_channels',
        privacy: 'regional_aggregate_no_pii',
      }));
    }
  }

  return c.json({
    ...fc(features.slice(0, limit)),
    generated_ms: Date.now(),
    privacy: 'public_lifeline_no_pii',
    counts: counts(features),
  }, 200, { 'Cache-Control': 'public, max-age=30' });
});
