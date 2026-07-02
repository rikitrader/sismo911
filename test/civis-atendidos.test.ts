import { describe, it, expect } from 'vitest';
import { civisToRow, mapCivisEstado, type CivisRecord } from '../src/ingest/civis-atendidos';

const rec = (o: Partial<CivisRecord>): CivisRecord => ({
  codigo: 'ATN-0761F027', nombre: 'Yeni Garcia', identificacion: 'identificada',
  edad_aprox: null, sexo: null, estado: 'de_alta', condicion: 'De alta',
  foto_url: null, centro: 'Hospital Vargas de Caracas', creado_en: '2026-07-02T03:44:00.407406+00:00',
  ...o,
});

describe('mapCivisEstado', () => {
  it('maps the CIVIS estado enum to our sticky-upward status', () => {
    expect(mapCivisEstado('de_alta')).toBe('alta');
    expect(mapCivisEstado('en_atencion')).toBe('hospitalizado');
    expect(mapCivisEstado('fallecido')).toBe('fallecido');
    expect(mapCivisEstado('fallecida')).toBe('fallecido');
    expect(mapCivisEstado(null)).toBe('desconocido');
    expect(mapCivisEstado('cualquier_cosa')).toBe('desconocido');
  });
});

describe('civisToRow', () => {
  it('maps a record into a storable, Title-Cased, name-keyed profile', () => {
    const r = civisToRow(rec({ nombre: 'MARIELIS VEGA', estado: 'en_atencion', condicion: 'Herido' }))!;
    expect(r).not.toBeNull();
    expect(r.full_name).toBe('Marielis Vega');          // Title Case display
    expect(r.norm_name).toBe('marielis vega');           // lowercased matching key (unchanged)
    expect(r.dedupe_key).toBe('n:marielis vega');        // name key (no cédula in CIVIS)
    expect(r.estado).toBe('hospitalizado');
    expect(r.source_ref).toBe('ATN-0761F027');
    expect(r.observaciones).toContain('CIVIS ATN-0761F027');
  });

  it('carries sexo, edad and foto_url when present', () => {
    const r = civisToRow(rec({ sexo: 'F', edad_aprox: 34, foto_url: 'https://x/y.jpg' }))!;
    expect(r.sexo).toBe('F');
    expect(r.edad).toBe('34');
    expect(r.foto_url).toBe('https://x/y.jpg');
  });

  it('returns null for an unnamed record (not a listable person)', () => {
    expect(civisToRow(rec({ nombre: '' }))).toBeNull();
    expect(civisToRow(rec({ nombre: null }))).toBeNull();
  });

  it('a de_alta record maps to alta, not desconocido', () => {
    const r = civisToRow(rec({ estado: 'de_alta' }))!;
    expect(r.estado).toBe('alta');
  });
});
