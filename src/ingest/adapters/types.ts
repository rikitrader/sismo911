// SISMO911 — canonical external-ingest record + adapter contract.
// ---------------------------------------------------------------------------
// Every external website/source is normalized into THIS shape before anything
// touches D1. Never trust external data directly: an adapter validates,
// normalizes (Title Case display names, digit-only ids/phones), hashes the raw
// payload, and the pre-ingest gate dedupe-checks the batch before any write.

export interface CanonicalPersonRecord {
  full_name: string | null;
  national_id: string | null; // cédula, digits only
  phone: string | null;
  email: string | null;
  age: number | null;
  gender: string | null;
  status: string | null; // source status, mapped to app vocabulary where known
  location: string | null;
  municipality: string | null;
  state: string | null;
  country: string | null;
  last_seen_location: string | null;
  last_seen_at: string | null;
  hospital_name: string | null;
  shelter_name: string | null;
  family_contact_name: string | null;
  family_contact_phone: string | null;
  source_url: string | null;
  source_name: string; // REQUIRED — adapter identity, e.g. 'civis'
  source_record_id: string; // REQUIRED — upstream id (dedupe-by-construction key)
  confidence_score: number; // 0..1 adapter's trust in the mapping
  verification_status: 'unverified' | 'source_verified';
  raw_payload_hash: string; // fnv1a of the raw upstream JSON
  ingested_at: string; // ISO
  updated_at: string | null;
}

export interface IngestAdapter<Raw = unknown> {
  sourceName: string;
  /** Map ONE raw upstream record → canonical, or null when it is unusable. */
  toCanonical(raw: Raw, now?: string): CanonicalPersonRecord | null;
}

/** Tiny dependency-free FNV-1a hash for raw payload fingerprints. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
