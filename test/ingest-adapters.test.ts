// Canonical adapter contract — CIVIS reference adapter.
import { describe, it, expect } from 'vitest';
import { civisAdapter } from '../src/ingest/adapters/civis';
import { fnv1a } from '../src/ingest/adapters/types';

const RAW = {
  id: 'e04e2cd6-59fd-4cc4-9581-767b64b63202',
  codigo: 'DESAP-1234',
  nombre: 'YOILER CARIAS',
  edadAprox: 10,
  ubicacion: { lat: 10.6, lng: -66.9, referencia: 'Catia La Mar' },
  estado: 'buscando',
  creadoEn: '2026-07-01T12:00:00Z',
};

describe('civisAdapter.toCanonical', () => {
  it('maps a full record with Title Case name and app estado vocabulary', () => {
    const c = civisAdapter.toCanonical(RAW, '2026-07-05T00:00:00Z');
    expect(c).toMatchObject({
      full_name: 'Yoiler Carias',
      age: 10,
      status: 'sin-contacto', // buscando → app vocab
      last_seen_location: 'Catia La Mar',
      source_name: 'civis',
      source_record_id: RAW.id,
      country: 'VE',
      verification_status: 'unverified',
      ingested_at: '2026-07-05T00:00:00Z',
    });
    expect(c?.raw_payload_hash).toBe(fnv1a(JSON.stringify(RAW)));
  });

  it('rejects privacy-redacted and id-less records', () => {
    expect(civisAdapter.toCanonical({ ...RAW, nombre: '…' })).toBeNull();
    expect(civisAdapter.toCanonical({ ...RAW, nombre: '  ' })).toBeNull();
    expect(civisAdapter.toCanonical({ nombre: 'X Y' })).toBeNull(); // no upstream id
  });

  it('clamps invalid ages to null and passes unknown estados through', () => {
    expect(civisAdapter.toCanonical({ ...RAW, edadAprox: 400 })?.age).toBeNull();
    expect(civisAdapter.toCanonical({ ...RAW, estado: 'revisando' })?.status).toBe('revisando');
  });
});

describe('fnv1a', () => {
  it('is stable and input-sensitive', () => {
    expect(fnv1a('abc')).toBe(fnv1a('abc'));
    expect(fnv1a('abc')).not.toBe(fnv1a('abd'));
  });
});
