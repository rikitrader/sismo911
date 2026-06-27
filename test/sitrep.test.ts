import { describe, expect, it } from 'vitest';
import { buildCapAlertXml, buildEsfStatus, buildOperationalTimeline, sitrep } from '../src/routes/sitrep';

const now = Date.now();

function makeDB() {
  const stmt = (sql: string) => ({
    bind: () => stmt(sql),
    all: async () => {
      if (/FROM events/.test(sql)) return { results: [
        { id: 'ev1', mag: 6.2, place: 'Yumare, Venezuela', place_es: 'Yumare', time_ms: now - 1000, lat: 10.6, lon: -68.7, depth_km: 12, alert: 'orange', tsunami: 0, url: 'https://example.test' },
      ] };
      if (/FROM map_reports/.test(sql) && /ORDER BY created_ms/.test(sql)) return { results: [{ category: 'trapped_people', severity: 'rojo', estado: 'Distrito Capital', municipio: 'Caracas', created_ms: now - 2000 }] };
      if (/FROM map_reports/.test(sql) && /GROUP BY severity/.test(sql)) return { results: [{ severity: 'rojo', n: 2 }] };
      if (/FROM checkins/.test(sql) && /MAX\(created_ms\)/.test(sql)) return { results: [{ status: 'need_help', n: 1, updated_ms: now - 5000 }] };
      if (/FROM checkins/.test(sql)) return { results: [{ status: 'safe', n: 5 }, { status: 'need_help', n: 1 }] };
      if (/FROM sos_alerts/.test(sql) && /MAX/.test(sql)) return { results: [{ status: 'active', n: 2, updated_ms: now - 4000 }] };
      if (/FROM sos_alerts/.test(sql)) return { results: [{ status: 'active', n: 2 }] };
      if (/FROM resources/.test(sql)) return { results: [{ status: 'low', n: 1 }] };
      if (/FROM shelter_status/.test(sql) && /ORDER BY updated_ms/.test(sql)) return { results: [{ status: 'lleno', updated_ms: now - 6000 }] };
      if (/FROM shelter_status/.test(sql)) return { results: [{ status: 'activo', n: 3 }] };
      if (/FROM acopio_inventory/.test(sql)) return { results: [{ commodity: 'agua', total: 100, centers: 2 }] };
      if (/FROM acopio_needs/.test(sql) && /ORDER BY updated_ms/.test(sql)) return { results: [{ status: 'open', priority: 1, updated_ms: now - 7000 }] };
      if (/FROM acopio_needs/.test(sql)) return { results: [{ status: 'open', priority: 1, n: 1 }] };
      if (/FROM acopio_shipments/.test(sql) && /ORDER BY updated_ms/.test(sql)) return { results: [{ status: 'en_transito', updated_ms: now - 8000 }] };
      if (/FROM acopio_shipments/.test(sql)) return { results: [{ status: 'en_transito', n: 1 }] };
      if (/FROM sat_damage/.test(sql) && /ORDER BY created_ms/.test(sql)) return { results: [{ severity: 'grave', verification: 'unverified', created_ms: now - 3000 }] };
      if (/FROM sat_damage/.test(sql)) return { results: [
        { severity: 'grave', verification: 'unverified', n: 2 },
        { severity: 'leve', verification: 'verified', n: 1 },
      ] };
      if (/FROM ingest_log/.test(sql)) return { results: [{ source: 'usgs', last_ok_ms: now, last_error: null }] };
      return { results: [] };
    },
    first: async () => {
      if (/FROM map_reports/.test(sql)) return { total: 4, critical: 2, resources: 1, trapped: 1 };
      if (/FROM acopio_custody/.test(sql)) return { n: 3 };
      if (/FROM acopio_inventory_lots/.test(sql)) return { quarantine: 1, expired: 0, within30: 1, total_lots: 4 };
      return null;
    },
  });
  return { prepare: (sql: string) => stmt(sql) } as any;
}

describe('public sitrep', () => {
  it('returns a non-PII common operating picture across seismic, humanitarian and logistics signals', async () => {
    const res = await sitrep.request('/', {}, { DB: makeDB() } as any);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('max-age=30');
    const j = await res.json() as any;
    expect(j.scope).toBe('public_non_pii');
    expect(j.readiness.status).toBe('emergency');
    expect(j.geoseismic.maxMag24h).toBe(6.2);
    expect(j.humanitarian.sos.unresolved).toBe(2);
    expect(j.logistics.needs.critical).toBe(1);
    expect(j.logistics.lots.at_risk).toBe(2);
    expect(j.damage.satellite).toMatchObject({ total: 3, severe: 2, unverified: 2, verified: 1 });
    expect(j.readiness.priorities).toContain('Verificar evaluaciones satelitales graves/severas.');
    expect(j.esf.framework).toBe('FEMA_ESF_style_operational_matrix');
    expect(j.esf.functions.find((x: any) => x.code === 'ESF-9')).toMatchObject({ status: 'emergency' });
    expect(JSON.stringify(j)).not.toMatch(/phone|contact_phone|name|note/i);
  });

  it('exports the focused public ESF mission matrix without incident-level data', async () => {
    const esf = buildEsfStatus({
      generated_ms: now,
      geoseismic: { maxMag24h: 6.2 },
      humanitarian: { sos: { unresolved: 2 }, checkins: { need_help: 1 }, resources: { low: 1, depleted: 0 } },
      logistics: { needs: { open: 3, critical: 1 }, shipments: { in_transit: 1, delivered: 1 }, lots: { at_risk: 2 } },
      shelters: { full: 1, closed: 0 },
      damage: { reports: { trapped: 1, critical: 2 }, satellite: { severe: 2, unverified: 2 } },
      feeds: { ingest: [{ source: 'usgs' }], social_configured: 0, social_live: 0 },
    });
    expect(esf.summary.emergency).toBeGreaterThan(0);
    expect(esf.functions.find((x) => x.code === 'ESF-7')?.status).toBe('elevated');

    const res = await sitrep.request('/esf', {}, { DB: makeDB() } as any);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('max-age=30');
    const j = await res.json() as any;
    expect(j.scope).toBe('public_non_pii');
    expect(j.functions.map((x: any) => x.code)).toContain('ESF-9');
    expect(JSON.stringify(j)).not.toMatch(/phone|contact_phone|name|note|lat|lon/i);
  });

  it('exports a public ICS-209-lite text summary from the same sitrep data', async () => {
    const res = await sitrep.request('/ics-209', {}, { DB: makeDB() } as any);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('SISMO911 ICS-209-LITE INCIDENT STATUS SUMMARY');
    expect(body).toContain('READINESS: EMERGENCY');
    expect(body).toContain('ESF MISSION STATUS');
    expect(body).toContain('ESF-9 Search and Rescue: EMERGENCY');
    expect(body).toContain('Satellite severe/unverified: 2 / 2');
    expect(body).toContain('Open needs / critical needs: 1 / 1');
    expect(body).not.toMatch(/phone|contact_phone|name|note/i);
  });

  it('exports a public CAP XML alert from the same aggregate sitrep', async () => {
    const xml = buildCapAlertXml({
      generated_ms: now,
      readiness: { status: 'emergency', priorities: ['Resolver SOS activos.'], threat: { label: 'Alerta Roja' } },
      geoseismic: { maxMag24h: 6.2, latest: { place_es: 'Yumare' } },
      humanitarian: { sos: { unresolved: 2 } },
      damage: { reports: { critical: 2, trapped: 1 } },
      logistics: { needs: { critical: 1 }, lots: { at_risk: 2 } },
      esf: { functions: [{ code: 'ESF-9', status: 'emergency', score: 21 }] },
    });
    expect(xml).toContain('<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">');
    expect(xml).toContain('<severity>Extreme</severity>');
    expect(xml).toContain('<areaDesc>Venezuela</areaDesc>');

    const res = await sitrep.request('/cap', {}, { DB: makeDB() } as any);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/cap+xml');
    const body = await res.text();
    expect(body).toContain('<sender>alerts@sismo911.com</sender>');
    expect(body).toContain('<event>Venezuela Earthquake Response / SISMO911</event>');
    expect(body).toContain('<parameter><valueName>scope</valueName><value>public_non_pii</value></parameter>');
    expect(body).not.toMatch(/contact_phone|<phone|<lat|<lon|reporter|person_name/i);
  });

  it('exports a public non-PII operational timeline', async () => {
    const direct = await buildOperationalTimeline({ DB: makeDB() } as any, 20, now);
    expect(direct.scope).toBe('public_non_pii');
    expect(direct.items.length).toBeGreaterThan(4);
    expect(direct.items[0]).toMatchObject({ domain: 'geoseismic', kind: 'quake' });

    const res = await sitrep.request('/timeline?limit=20', {}, { DB: makeDB() } as any);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('max-age=30');
    const j = await res.json() as any;
    expect(j.privacy).toBe('aggregate_and_public_operational_events_no_pii');
    expect(j.items.map((x: any) => x.domain)).toContain('logistics');
    expect(j.items.map((x: any) => x.domain)).toContain('humanitarian');
    expect(JSON.stringify(j)).not.toMatch(/phone|contact_phone|name|note|driver|actor|lat|lon/i);
  });
});
