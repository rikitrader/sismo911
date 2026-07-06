// SISMO911 — Telegram photo/PDF intake: shared types.
// ---------------------------------------------------------------------------
// The intake pipeline turns a Telegram photo or PDF into either (a) a lead
// attached to an existing missing-person case, or (b) a NEW draft case queued
// for operator review. Nothing it creates is ever public until an operator
// confirms it — every auto-created persona is moderation='pending'.

/** Structured fields extracted from the submitted media (null = not found; never invented). */
export interface ExtractedRecord {
  nombre: string | null;
  cedula: string | null; // digits only, no "V-" / dots
  edad: number | null;
  ubicacion: string | null; // last-seen location / city / state
  fecha: string | null; // free-text date of disappearance or event
  contacto: string | null; // phone or email
  descripcion: string | null; // clothing / features / notes
  // Advisory OCR-quality flags (src/lib/ocr-normalize.ts). Presence forces
  // operator review — a flagged record is never auto-approved. Serialized
  // inside extracted_json, so the console surfaces it with no schema change.
  ocrFlags?: string[];
}

/** The media the bot pulled off a Telegram message. */
export interface IntakeMedia {
  fileId: string;
  mime: string; // image/jpeg | image/png | application/pdf | ...
  fileName: string;
  bytes: Uint8Array;
}

export interface MatchResult {
  personId: string | null; // fam-<personas.id> when matched
  score: number; // 0..1 confidence of the chosen match
  reason: 'cedula' | 'name' | 'none';
}

export type IntakeOutcome = 'matched' | 'created' | 'needs_review' | 'rejected' | 'error';

/** Result of persisting a submission — drives the operator alert + user reply. */
export interface IntakeResult {
  submissionId: string; // itk_xxxxxxxx
  code: string; // public code shown to the user: ITK-XXXXXX
  outcome: IntakeOutcome;
  personId: string | null;
  intelId: string | null;
  fields: ExtractedRecord;
  score: number;
  note: string; // short human-readable note (Spanish)
  // True when the submission came from an ADMIN and was published immediately
  // (persona approved + lead verified) — no operator review needed.
  autoApproved?: boolean;
}
