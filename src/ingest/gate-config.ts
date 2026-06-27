// src/ingest/gate-config.ts
//
// Shared gateRow() configs for the server-side (cron) ingests. rav-cron,
// familia-cron and the sos-damage sync all funnel mapped rows through these so a
// junk / link-spam / stored-XSS / SIMONE-BURATTI-flood row is dropped at the door
// instead of being written and mopped up later by the :15 cleanPersonas cron.
//
// gateRow() is pure + in-memory (no D1, no Context) — safe to call per row inside
// a cron loop that processes thousands of rows. See src/security/ingestion-gate.ts.

import { gateRow, REASON_CODES, type GateRowResult } from '../security/ingestion-gate';
import { z, nameField, textField } from '../security/validators';

// A mapped persona row (rav-cron / familia-cron). We validate the NAME strictly
// (no markup/link-spam/no-letter) and the free-text fields for markup + spam
// phrases. Other columns (edad/contacto/foto/…) ride along untouched — gateRow is
// used as a pass/REJECT filter, not to rewrite the stored values.
const PersonaRowSchema = z.object({
  nombre: nameField(200),
  ubicacion: textField(300).optional(),
  descripcion: textField(4000).optional(),
});

export const PERSONA_INGEST_GATE = {
  schema: PersonaRowSchema,
  allowedFields: ['nombre', 'ubicacion', 'descripcion'] as const,
  nameFields: ['nombre'] as const,
  textFields: ['ubicacion', 'descripcion'] as const,
};

// A mapped rav_reports row. title is the strict "name-like" field; description is
// free text. Citizen report titles are short, so the same name rules apply.
const RavReportRowSchema = z.object({
  title: nameField(200),
  description: textField(4000).optional(),
});

export const RAV_REPORT_INGEST_GATE = {
  schema: RavReportRowSchema,
  allowedFields: ['title', 'description'] as const,
  nameFields: ['title'] as const,
  textFields: ['description'] as const,
};

/** Gate a mapped persona row. Returns the gateRow result (ok → keep, !ok → skip). */
export function gatePersona(p: { nombre: string; ubicacion?: string | null; descripcion?: string | null }): GateRowResult<unknown> {
  // Door min-length: nameField(200) only caps the MAX, so 1–2 char junk ('ll',
  // 'NN', 'a', 'J') slipped in. A real name has ≥3 letters — reject shorter,
  // mirroring clean.ts's junk definition so the door and the cleaner agree.
  const letters = (p.nombre ?? '').replace(/[^\p{L}]/gu, '');
  if (letters.length < 3) {
    return { ok: false, reason: REASON_CODES.SCHEMA_INVALID, score: 0, reasons: ['name_too_short'], detail: `nombre too short: ${JSON.stringify(p.nombre)}` };
  }
  return gateRow(
    { nombre: p.nombre, ubicacion: p.ubicacion ?? undefined, descripcion: p.descripcion ?? undefined },
    PERSONA_INGEST_GATE,
  );
}

/** Gate a mapped rav_reports row. A report with no title but a description is
 *  allowed through with a synthetic title check skipped (title-less reports keep
 *  the cron's existing "title OR description" acceptance). */
export function gateRavReport(m: { title?: string | null; description?: string | null }): GateRowResult<unknown> {
  // The cron already accepts a row with only a description (no title). Only run
  // the strict title check when a title is actually present; otherwise validate
  // the description alone so we still catch markup/spam in description-only rows.
  if (!m.title || !m.title.trim()) {
    return gateRow({ title: '—', description: m.description ?? undefined }, RAV_REPORT_INGEST_GATE);
  }
  return gateRow({ title: m.title, description: m.description ?? undefined }, RAV_REPORT_INGEST_GATE);
}
