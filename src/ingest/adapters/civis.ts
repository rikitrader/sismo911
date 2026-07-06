// Reference adapter: CIVIS Venezuela desaparecidos → canonical record.
// ---------------------------------------------------------------------------
// Mirrors the field semantics src/ingest/civis-desaparecidos.ts already relies
// on (same upstream API), expressed through the canonical contract so the
// pre-ingest gate can validate/dedupe CIVIS batches like any external website.

import { titleCaseName } from '../../lib/names';
import { type CanonicalPersonRecord, type IngestAdapter, fnv1a } from './types';

export interface CivisDesapRaw {
  id?: string;
  codigo?: string;
  nombre?: string;
  edadAprox?: number | null;
  ubicacion?: { lat?: number; lng?: number; referencia?: string } | null;
  fotoUrl?: string | null;
  fuente?: string | null;
  estado?: string | null;
  creadoEn?: string | null;
}

const ESTADO_MAP: Record<string, string> = {
  buscando: 'sin-contacto',
  localizada: 'localizado',
  localizado: 'localizado',
};

export const civisAdapter: IngestAdapter<CivisDesapRaw> = {
  sourceName: 'civis',
  toCanonical(raw, now = new Date().toISOString()): CanonicalPersonRecord | null {
    if (!raw || typeof raw !== 'object' || !raw.id) return null;
    const nombre = String(raw.nombre ?? '').trim();
    // Upstream privacy-redacts minors' names to "…" — unusable as a person row.
    if (!nombre || /^[….\s]+$/.test(nombre)) return null;
    const age = typeof raw.edadAprox === 'number' && raw.edadAprox >= 0 && raw.edadAprox < 130 ? Math.trunc(raw.edadAprox) : null;
    const estado = String(raw.estado ?? '').toLowerCase();
    return {
      full_name: titleCaseName(nombre).slice(0, 140),
      national_id: null,
      phone: null,
      email: null,
      age,
      gender: null,
      status: ESTADO_MAP[estado] ?? (estado || null),
      location: raw.ubicacion?.referencia?.slice(0, 200) ?? null,
      municipality: null,
      state: null,
      country: 'VE',
      last_seen_location: raw.ubicacion?.referencia?.slice(0, 200) ?? null,
      last_seen_at: raw.creadoEn ?? null,
      hospital_name: null,
      shelter_name: null,
      family_contact_name: null,
      family_contact_phone: null,
      source_url: 'https://civisvenezuela.com/api/desaparecidos',
      source_name: 'civis',
      source_record_id: String(raw.id),
      confidence_score: 0.7,
      verification_status: 'unverified',
      raw_payload_hash: fnv1a(JSON.stringify(raw)),
      ingested_at: now,
      updated_at: raw.creadoEn ?? null,
    };
  },
};

export const ADAPTERS: Record<string, IngestAdapter> = {
  civis: civisAdapter as IngestAdapter,
};
