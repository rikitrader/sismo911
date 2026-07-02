import { describe, it, expect } from 'vitest';
import { edificacionToRow } from '../src/ingest/civis-edificaciones';

const NOW = 1751470000000;

const base = {
  id: 'f54f9828-98ee-4e33-86b4-ea52bb347673',
  lat: 10.5134743,
  lng: -66.9033068,
  severidad: 'colapso',
  oficial: true,
  zona: 'Caracas',
  uso: 'Unclassified',
  url: 'https://www.google.com/maps/search/?api=1&query=10.5134743,-66.9033068',
};

describe('edificacionToRow (CIVIS /api/edificaciones → sat_edificaciones)', () => {
  it('maps a full satellite edificación', () => {
    const r = edificacionToRow(base, NOW)!;
    expect(r.id).toBe(base.id);
    expect(r.lat).toBe(10.5134743);
    expect(r.lng).toBe(-66.9033068);
    expect(r.severidad).toBe('colapso');
    expect(r.oficial).toBe(1);
    expect(r.zona).toBe('Caracas');
    expect(r.uso).toBe('Unclassified');
    expect(r.maps_url).toBe(base.url);
    expect(r.now).toBe(NOW);
  });

  it('returns null without an id', () => {
    expect(edificacionToRow({ ...base, id: '' }, NOW)).toBeNull();
  });

  it('non-numeric geo becomes null (never NaN/strings into D1)', () => {
    const r = edificacionToRow({ ...base, lat: undefined, lng: '10.5' as any }, NOW)!;
    expect(r.lat).toBeNull();
    expect(r.lng).toBeNull();
  });

  it('oficial=false and missing optionals map to safe defaults', () => {
    const r = edificacionToRow({ id: 'x', severidad: 'grave', oficial: false }, NOW)!;
    expect(r.oficial).toBe(0);
    expect(r.severidad).toBe('grave');
    expect(r.zona).toBe('');
    expect(r.uso).toBe('');
    expect(r.maps_url).toBe('');
  });
});
