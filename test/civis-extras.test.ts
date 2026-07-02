import { describe, it, expect } from 'vitest';
import { reporteToRow, puntoToRow } from '../src/ingest/civis-extras';

describe('reporteToRow (→ sos_damage)', () => {
  const base = {
    id: 'e911c305-45f2-45b7-80d7-493bead91708', codigo: 'CIVIS-002702', tipo: 'dano',
    subtipo: ['edificio_agrietado'], gravedad: 'grave', estado: 'validado',
    fotoUrl: 'https://q.supabase.co/x.jpg', fuente: 'civis',
    ubicacion: { lat: 10.61, lng: -67.02, referencia: 'Playamar, Maiquetía' }, actualizadoEn: '2026-07-02T10:00:00Z',
  };
  it('maps a report into a namespaced, geo-located sos_damage row', () => {
    const r = reporteToRow(base)!;
    expect(r.id).toBe('civis_e911c305-45f2-45b7-80d7-493bead91708');
    expect(r.category).toBe('dano');
    expect(r.severity).toBe('grave');
    expect(r.verification).toBe('validado');
    expect(r.lat).toBe(10.61); expect(r.lng).toBe(-67.02);
    expect(r.image_url).toBe('https://q.supabase.co/x.jpg');
    expect(r.title).toContain('CIVIS-002702');
    expect(r.description).toContain('edificio_agrietado');
    expect(r.source_url).toBe('civis:CIVIS-002702');
  });
  it('handles missing geo (null lat/lng) and string subtipo', () => {
    const r = reporteToRow({ ...base, ubicacion: null, subtipo: 'grieta' })!;
    expect(r.lat).toBeNull(); expect(r.lng).toBeNull();
    expect(r.description).toContain('grieta');
  });
  it('returns null without an id', () => {
    expect(reporteToRow({ ...base, id: '' } as any)).toBeNull();
  });
});

describe('puntoToRow (→ civis_puntos)', () => {
  const base = {
    id: 'd2b92123-f624-4933-8916-f17cba16f70d', nombre: 'Centro Mormón - Caracas', tipo: 'acopio',
    ubicacion: { lat: 10.611, lng: -66.886 }, direccion: 'Caracas', estado: 'abierto', detalle: 'Recibe agua',
    servicios: ['agua', 'comida'], necesidades: ['pañales'], pais: 'VE',
    actualizadoEn: '2026-07-02T09:00:00Z', confirmacionesCount: 3, totalPersonas: 40,
  };
  it('maps an aid point with JSON-encoded servicios/necesidades', () => {
    const r = puntoToRow(base, 1000)!;
    expect(r.id).toBe('d2b92123-f624-4933-8916-f17cba16f70d');
    expect(r.tipo).toBe('acopio');
    expect(r.lat).toBe(10.611); expect(r.lng).toBe(-66.886);
    expect(JSON.parse(r.servicios)).toEqual(['agua', 'comida']);
    expect(JSON.parse(r.necesidades)).toEqual(['pañales']);
    expect(r.confirmaciones).toBe(3);
    expect(r.total_personas).toBe(40);
  });
  it('defaults counts to 0 and arrays to [] when absent', () => {
    const r = puntoToRow({ id: 'x', nombre: 'P' } as any, 1000)!;
    expect(r.confirmaciones).toBe(0); expect(r.total_personas).toBe(0);
    expect(JSON.parse(r.servicios)).toEqual([]); expect(JSON.parse(r.necesidades)).toEqual([]);
  });
  it('returns null without an id', () => {
    expect(puntoToRow({ id: '' } as any, 1000)).toBeNull();
  });
});
