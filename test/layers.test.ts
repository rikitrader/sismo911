import { describe, expect, it } from 'vitest';
import {
  buildLayerCatalog,
  centerFeature,
  humanitarianSignalFeature,
  impactFeature,
  impactRadiusKm,
  lifelineFeature,
  layers,
  needFeature,
  quakeFeature,
  resourceFeature,
  satelliteDamageFeature,
  shipmentFeature,
  statePostureFeature,
} from '../src/routes/layers';
import { ESTADOS } from '../src/data/estados';

const centers = [
  { id: 'A', nombre: 'Centro A', tipo: 'hospital', estado: 'Distrito Capital', ciudad: 'Caracas', lat: 10.5, lon: -66.9, cap: 'Alta' },
  { id: 'B', nombre: 'Centro B', tipo: 'universidad', estado: 'Miranda', ciudad: 'Los Teques', lat: 10.34, lon: -67.04, cap: 'Media' },
];
const events = [
  { id: 'ev1', mag: 7.1, place: 'near Yumare, Venezuela', place_es: 'Yumare', time_ms: 1700000001000, lat: 10.6, lon: -68.7, depth_km: 12, mmi: 7, alert: 'orange', tsunami: 0, url: 'https://example.test/ev1' },
  { id: 'ev2', mag: 3.8, place: 'near Sucre, Venezuela', place_es: 'Sucre', time_ms: 1700000000000, lat: 10.4, lon: -64.2, depth_km: 20, mmi: 3, alert: 'green', tsunami: 0, url: 'https://example.test/ev2' },
];
const satDamage = [
  { id: 'sat1', lat: 10.61, lon: -68.71, bbox_n: 10.62, bbox_s: 10.60, bbox_e: -68.70, bbox_w: -68.72, severity: 'grave', summary: 'Daño probable', hazards: '["escombros"]', imagery_source: 'pytorch', imagery_date: '2026-06-24', event_id: 'ev1', ai_model: 'pytorch:test', verification: 'unverified', created_ms: 1700000002000 },
];

function makeEnv() {
  const stmt = (sql: string, args: any[] = []) => ({
    bind: (...next: any[]) => stmt(sql, next),
    all: async () => {
      if (/FROM acopio_submissions/.test(sql)) return { results: [] };
      if (/FROM acopio_status/.test(sql)) return { results: [{ id: 'A', status: 'saturado' }] };
      if (/FROM acopio_needs/.test(sql)) return { results: [{ id: 'n1', center_id: 'A', commodity: 'agua', qty: 500, priority: 1, status: 'open', note: 'urgente' }] };
      if (/FROM acopio_shipments/.test(sql)) return { results: [{ id: 's1', origin_id: 'A', dest_id: 'B', status: 'en_transito', vehicle: 'TRK-1', driver: null, eta_ms: null }] };
      if (/FROM resources/.test(sql)) return { results: [{ id: 'r1', kind: 'water', label: 'Agua potable', quantity: 1200, status: 'low', region: 'Caracas', lat: 10.49, lon: -66.88, updated_ms: 1700000000000 }] };
      if (/FROM comms_channels/.test(sql)) return { results: [{ region: 'Distrito Capital', band: 'VHF', n: 2, modes: 'FM' }] };
      if (/FROM events/.test(sql)) return { results: events.filter((e) => e.mag >= Number(args[0] ?? 0)).slice(0, Number(args[1] ?? 200)) };
      if (/FROM sat_damage/.test(sql)) return { results: satDamage };
      if (/FROM sos_alerts/.test(sql) && /FROM checkins/.test(sql)) {
        return { results: [
          { source: 'sos', status: 'active', lat_bucket: 10.6, lon_bucket: -66.9, n: 3, latest_ms: 1700000003000 },
          { source: 'checkin', status: 'need_help', lat_bucket: 10.5, lon_bucket: -66.8, n: 2, latest_ms: 1700000002000 },
        ] };
      }
      if (/FROM map_reports/.test(sql)) return { results: [{ estado: 'Distrito Capital', critical_reports: 2, trapped_reports: 1 }] };
      if (/FROM sos_alerts/.test(sql)) return { results: [{ lat: 10.48, lon: -67.01, status: 'active' }] };
      if (/FROM checkins/.test(sql)) return { results: [{ lat: 10.47, lon: -67.0, status: 'need_help' }] };
      if (/FROM shelter_status/.test(sql)) return { results: [{ lat: 10.48, lon: -67.02, status: 'lleno' }] };
      return { results: [] };
    },
  });
  return {
    DB: { prepare: (sql: string) => stmt(sql) },
    ASSETS: {
      fetch: async () => new Response(JSON.stringify(centers), { status: 200, headers: { 'content-type': 'application/json' } }),
    },
  } as any;
}

describe('operational layer GeoJSON', () => {
  it('publishes a public COP layer catalog with privacy and refresh metadata', async () => {
    const catalog = buildLayerCatalog();
    expect(catalog.scope).toBe('public_cop_layer_catalog');
    expect(catalog.count).toBeGreaterThanOrEqual(10);
    expect(catalog.by_domain.geoseismic).toBeGreaterThanOrEqual(3);
    expect(catalog.by_domain.logistics).toBeGreaterThanOrEqual(4);
    expect(catalog.layers.every((l: any) => l.public && l.endpoint.startsWith('/api/layers/'))).toBe(true);
    expect(catalog.layers.some((l: any) => l.id === 'humanitarian_signals' && l.privacy === 'coarse_aggregate_no_pii')).toBe(true);

    const res = await layers.request('/catalog', {}, makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('max-age=300');
    const j = await res.json() as any;
    expect(j.layers.map((l: any) => l.id)).toContain('lifelines');
    expect(JSON.stringify(j)).not.toMatch(/phone|contact|driver|reporter|message|note/i);
  });

  it('builds stable GeoJSON features for centers, needs and shipments', () => {
    const a = { id: 'A', nombre: 'Centro A', lat: 10, lon: -66 } as any;
    const b = { id: 'B', nombre: 'Centro B', lat: 11, lon: -67 } as any;
    expect(centerFeature(a).geometry).toEqual({ type: 'Point', coordinates: [-66, 10] });
    expect(needFeature(a, { id: 'n', center_id: 'A', commodity: 'agua', qty: 1, priority: 1 }).properties.layer).toBe('need');
    expect(resourceFeature({ id: 'r', kind: 'water', label: 'Agua', quantity: 12, status: 'available', lat: 9, lon: -65 }).properties.layer).toBe('resource');
    expect(shipmentFeature(a, b, { id: 's', origin_id: 'A', dest_id: 'B', status: 'en_transito' }).geometry).toEqual({ type: 'LineString', coordinates: [[-66, 10], [-67, 11]] });
  });

  it('returns a public FeatureCollection with counts per operational layer', async () => {
    const res = await layers.request('/operational', {}, makeEnv());
    expect(res.status).toBe(200);
    const j = await res.json() as any;
    expect(j.type).toBe('FeatureCollection');
    expect(j.counts.acopio).toBe(2);
    expect(j.counts.need).toBe(1);
    expect(j.counts.shipment).toBe(1);
    expect(j.counts.resource).toBe(1);
    const centerA = j.features.find((f: any) => f.properties.id === 'A' && f.properties.layer === 'acopio');
    expect(centerA.properties.status).toBe('saturado');
    const shipment = j.features.find((f: any) => f.properties.layer === 'shipment');
    expect(shipment.geometry.type).toBe('LineString');
    const resource = j.features.find((f: any) => f.properties.layer === 'resource');
    expect(resource.properties.label).toBe('Agua potable');
  });

  it('returns only coarse non-PII humanitarian signal aggregates', async () => {
    const feature = humanitarianSignalFeature({ source: 'sos', status: 'active', lat_bucket: 10.6, lon_bucket: -66.9, n: 3, latest_ms: 1700000003000 });
    expect(feature.geometry).toEqual({ type: 'Point', coordinates: [-66.9, 10.6] });
    expect(feature.properties.privacy).toBe('coarse_aggregate_no_pii');

    const res = await layers.request('/humanitarian?include=signals&limit=300', {}, makeEnv());
    expect(res.status).toBe(200);
    const j = await res.json() as any;
    expect(j.type).toBe('FeatureCollection');
    expect(j.privacy).toBe('coarse_aggregate_no_pii');
    expect(j.counts.humanitarian_signal).toBe(2);
    expect(j.features[0].properties.count).toBe(3);
    expect(JSON.stringify(j)).not.toMatch(/phone|name|note|message/i);
  });

  it('returns a public state-posture layer with aggregate-only metrics', async () => {
    const dc = ESTADOS.find((s) => s.slug === 'distrito-capital')!;
    const f = statePostureFeature(dc, {
      critical_reports: 2,
      trapped_reports: 1,
      unresolved_sos: 1,
      need_help_checkins: 1,
      stressed_shelters: 1,
      critical_resources: 1,
      stressed_acopio: 1,
    });
    expect(f.geometry).toEqual({ type: 'Point', coordinates: [dc.center[1], dc.center[0]] });
    expect(f.properties.severity).toBe('emergency');
    expect(f.properties.privacy).toBe('state_aggregate_no_pii');

    const res = await layers.request('/state-posture?limit=25', {}, makeEnv());
    expect(res.status).toBe(200);
    const j = await res.json() as any;
    expect(j.type).toBe('FeatureCollection');
    expect(j.privacy).toBe('state_aggregate_no_pii');
    expect(j.counts.state_posture).toBe(25);
    const top = j.features[0];
    expect(top.properties.layer).toBe('state_posture');
    expect(top.properties.slug).toBe('distrito-capital');
    expect(top.properties.metrics.critical_reports).toBe(2);
    expect(JSON.stringify(j)).not.toMatch(/phone|reporter|description|message|note/i);
  });

  it('returns public lifeline infrastructure without contact details', async () => {
    const f = lifelineFeature({ id: 'h1', category: 'health', name: 'Hospital Central', type: 'hospital', status: 'operativo', region: 'Distrito Capital', lat: 10.5, lon: -66.9, source: 'test' });
    expect(f.geometry).toEqual({ type: 'Point', coordinates: [-66.9, 10.5] });
    expect(f.properties.layer).toBe('lifeline');
    expect(f.properties.privacy).toBe('public_facility_no_pii');

    const res = await layers.request('/lifelines?include=health,comms,resources,acopio&limit=800', {}, makeEnv());
    expect(res.status).toBe(200);
    const j = await res.json() as any;
    expect(j.type).toBe('FeatureCollection');
    expect(j.privacy).toBe('public_lifeline_no_pii');
    expect(j.counts.lifeline).toBeGreaterThanOrEqual(3);
    expect(j.features.some((x: any) => x.properties.category === 'health')).toBe(true);
    expect(j.features.some((x: any) => x.properties.category === 'comms' && x.properties.privacy === 'regional_aggregate_no_pii')).toBe(true);
    expect(j.features.some((x: any) => x.properties.category === 'resource')).toBe(true);
    expect(JSON.stringify(j)).not.toMatch(/phone|contact|driver|reporter|message|note/i);
  });

  it('builds geoseismic quake points and provisional impact polygons', async () => {
    const quake = quakeFeature(events[0]);
    const impact = impactFeature(events[0]);
    expect(quake.geometry).toEqual({ type: 'Point', coordinates: [-68.7, 10.6] });
    expect(quake.properties.severity).toBe('critical');
    expect(impact.geometry.type).toBe('Polygon');
    expect((impact.geometry.coordinates[0] as any[]).length).toBeGreaterThan(20);
    expect(impact.properties.radius_km).toBe(impactRadiusKm(events[0]));
    expect(satelliteDamageFeature(satDamage[0]).geometry.type).toBe('Polygon');
  });

  it('returns a public geoseismic FeatureCollection with event and impact layers', async () => {
    const res = await layers.request('/geoseismic?include=events,impact,satellite_damage&minMag=0&impactMinMag=4', {}, makeEnv());
    expect(res.status).toBe(200);
    const j = await res.json() as any;
    expect(j.type).toBe('FeatureCollection');
    expect(j.counts.quake).toBe(2);
    expect(j.counts.impact).toBe(1);
    expect(j.counts.satellite_damage).toBe(1);
    const impact = j.features.find((f: any) => f.properties.layer === 'impact');
    expect(impact.properties.model).toBe('sismo911_provisional_radius_v1');
    const satellite = j.features.find((f: any) => f.properties.layer === 'satellite_damage');
    expect(satellite.properties.verification).toBe('unverified');
  });
});
