import { describe, it, expect } from 'vitest';
import { mapCivisDesap } from '../src/ingest/civis-desaparecidos';

const RUN = '2026-07-02T12:00:00.000Z';
const rec = (o: any = {}) => ({
  id: 'c1fd7dba-4316-437e-b060-98c9652782dd', codigo: 'DESAP-385083',
  nombre: 'Julian Melian', edadAprox: 69, ubicacion: { lat: 0, lng: 0 },
  fotoUrl: null, fuente: 'venezuelareporta.org', estado: 'buscando',
  creadoEn: '2026-07-02T11:22:06.308353+00:00', ...o,
});

describe('mapCivisDesap', () => {
  it('maps a record into a personas UPSERT with civis-namespaced id + origen', () => {
    const p = mapCivisDesap(rec(), RUN)!;
    expect(p.id).toBe('civis_c1fd7dba-4316-437e-b060-98c9652782dd'); // dedupe by construction
    expect(p.ext_id).toBe('c1fd7dba-4316-437e-b060-98c9652782dd');
    expect(p.origen).toBe('civis:venezuelareporta.org');
    expect(p.nombre).toBe('Julian Melian');
    expect(p.edad).toBe(69);
    expect(p.descripcion).toContain('DESAP-385083');
  });

  it('carries the photo URL when present', () => {
    const url = 'https://qextdcliwlueqdqrmblu.supabase.co/storage/v1/object/public/reportes/x.jpg';
    const p = mapCivisDesap(rec({ fotoUrl: url }), RUN)!;
    expect(p.foto).toBe(url);
    expect(p.tags).toContain('has-photo');
  });

  it('maps estado: localizada → localizado, buscando → sin-contacto', () => {
    expect(mapCivisDesap(rec({ estado: 'localizada' }), RUN)!.estado).toBe('localizado');
    expect(mapCivisDesap(rec({ estado: 'buscando' }), RUN)!.estado).toBe('sin-contacto');
  });

  it('strips the privacy-redaction ellipsis from names', () => {
    const p = mapCivisDesap(rec({ nombre: 'douglanyelis Jos…' }), RUN)!;
    expect(p.nombre).toBe('douglanyelis Jos');
  });

  it('uses ubicacion.referencia when present, else lat/lng', () => {
    expect(mapCivisDesap(rec({ ubicacion: { referencia: 'Hospital Perez Carreño' } }), RUN)!.ubicacion)
      .toBe('Hospital Perez Carreño');
    expect(mapCivisDesap(rec({ ubicacion: { lat: 10.5, lng: -66.9 } }), RUN)!.ubicacion).toBe('10.5, -66.9');
  });

  it('returns null for a record with no id', () => {
    expect(mapCivisDesap(rec({ id: '' }), RUN)).toBeNull();
  });
});
