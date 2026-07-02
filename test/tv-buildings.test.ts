import { describe, it, expect } from 'vitest';
import {
  mapTvBuilding, mapSosDamageBuilding, poolReportedBuildings, sosDamageLevel, tvStatus, tvState,
  type SosDamageRow,
} from '../src/lib/tv-buildings';

describe('tv-buildings mapping', () => {
  it('maps damage_level → status', () => {
    expect(tvStatus('total')).toBe('COLAPSO_TOTAL');
    expect(tvStatus('severo')).toBe('COLAPSO_PARCIAL');
    expect(tvStatus('parcial')).toBe('DANADO');
    expect(tvStatus('unknown')).toBe('DANADO');
  });

  it('resolves city → state for cost', () => {
    expect(tvState('Caracas')).toBe('Distrito Capital');
    expect(tvState('Caraballeda')).toBe('La Guaira');
    expect(tvState('Maracay')).toBe('Aragua');
    expect(tvState('Valencia')).toBe('Carabobo');
    expect(tvState('nowhere')).toBe('La Guaira'); // epicentre default
  });

  it('mapTvBuilding computes a cost and gallery', () => {
    const b = mapTvBuilding({
      id: 'a', name: 'Edif X', city: 'Caracas', damage_level: 'total',
      status: 'verificado', main_photo_url: 'p.jpg',
      media_urls: JSON.stringify(['p.jpg', 'q.jpg', 'v.mp4']),
    });
    expect(b.status).toBe('COLAPSO_TOTAL');
    expect(b.verified).toBe(true);
    expect(b.media).toContain('q.jpg');
    expect(b.media).not.toContain('v.mp4'); // videos dropped
    expect(b.cost?.replacementUsd).toBeGreaterThan(0);
  });
});

describe('/danos sos_damage pooling', () => {
  it('maps category+triage → damage level', () => {
    expect(sosDamageLevel('collapsed_building', 'amarillo')).toBe('total');
    expect(sosDamageLevel('damaged_building', 'rojo')).toBe('severo');
    expect(sosDamageLevel('damaged_building', 'naranja')).toBe('severo');
    expect(sosDamageLevel('damaged_building', 'amarillo')).toBe('parcial');
    expect(sosDamageLevel('damaged_building', null)).toBe('parcial');
  });

  const sos = (over: Partial<SosDamageRow>): SosDamageRow => ({
    id: 's', category: 'collapsed_building', severity: 'rojo', verification: 'community_confirmed',
    title: 'Torre S', description: 'colapso', lat: 10.5, lng: -66.9, municipio: 'Caracas',
    parroquia: 'La Candelaria', building_type: null, people_trapped: 3, source_url: null,
    image_url: 'img.jpg', created_at: '2026-06-25', ...over,
  });

  it('mapSosDamageBuilding carries triage + trapped + verified + cost', () => {
    const b = mapSosDamageBuilding(sos({}));
    expect(b.damageLevel).toBe('total');
    expect(b.triage).toBe('rojo');
    expect(b.peopleTrapped).toBe(3);
    expect(b.verified).toBe(true);
    expect(b.cost?.repairUsd).toBeGreaterThan(0);
    expect(b.media).toEqual(['img.jpg']);
  });

  it('pool dedupes by id: tv gallery wins, danos enriches triage/coords/trapped', () => {
    const tv = mapTvBuilding({ id: 'x', name: 'Los Alpes', city: 'Caracas', damage_level: 'parcial',
      status: 'verificado', main_photo_url: 'a.jpg', media_urls: JSON.stringify(['a.jpg', 'b.jpg']) });
    const tvNoCoords = { ...tv, lat: null, lon: null };
    const d = mapSosDamageBuilding(sos({ id: 'x', category: 'damaged_building', severity: 'naranja', people_trapped: 2 }));
    const pooled = poolReportedBuildings([tvNoCoords], [d]);
    expect(pooled).toHaveLength(1); // deduped
    const m = pooled[0];
    expect(m.mediaCount).toBe(2);        // tv gallery kept
    expect(m.triage).toBe('naranja');    // danos triage adopted
    expect(m.peopleTrapped).toBe(2);     // trapped adopted
    expect(m.lat).toBe(10.5);            // coords backfilled from danos
    expect(m.sources).toContain('sosvenezuela2026.com');
  });

  it('pool adds danos-only buildings not in tv', () => {
    const tv = mapTvBuilding({ id: 'x', name: 'A', city: 'Caracas', damage_level: 'parcial' });
    const d = mapSosDamageBuilding(sos({ id: 'y', title: 'B' }));
    const pooled = poolReportedBuildings([tv], [d]);
    expect(pooled.map((b) => b.id).sort()).toEqual(['x', 'y']);
  });
});
