// SISMO911 — Telegram bot data adapter (READ-ONLY).
// ---------------------------------------------------------------------------
// The single boundary between the bot and the SISMO911 D1 database. It performs
// STRICT, parameterized lookups against the three case registries and returns
// fully-typed CaseRecords. It is the only place that:
//   • maps an internal status (persons.status / personas.estado /
//     hospital_patients.estado) onto a PUBLIC status;
//   • applies the verification gate — a final ALIVE/DEATH/MISSING status is only
//     emitted for VERIFIED/OFFICIAL rows; anything else collapses to
//     PENDING_VERIFICATION;
//   • marks how sensitive each field is so redactSensitiveFields can strip PII.
//
// It NEVER guesses, infers from weak matches, or writes. No status is ever
// produced by an LLM here — only by reading a row. Reuses existing project
// helpers (identity.normalizeCedula/namesRoughlyMatch, minor-protect) so there
// is one source of truth for cédula/name/minor logic.

import type { Env } from '../types';
import type { CaseRecord, MatchStrength, PublicStatus, Registry, VerificationLevel } from '../telegram/types';
import { normalizeCedula, namesRoughlyMatch } from '../lib/identity';
import { coarsenLocation, isMinor, isPublicSuppressed } from '../lib/minor-protect';

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;
const MAX_RESULTS = 12; // hard ceiling so a broad name can't fan out / scrape

// ---- input normalization ----------------------------------------------------

export interface NormalizedInput {
  name?: string;
  normName?: string;
  cedula?: string;
  dob?: string;
  ageFromDob?: number;
}

/** Lowercase/accent-fold a name into a stable matching key. */
function normName(s: string): string {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// SQLite's built-in lower() is ASCII-only and never folds accents, so a stored
// "Moisés" would NOT match a typed "Moises". These helpers build SQL expressions
// that fold the common Spanish accents (both cases) → bare ASCII, so LIKE is
// accent- AND case-insensitive. Verbose but correct and index-agnostic.
const ACCENTS: ReadonlyArray<[string, string]> = [
  ['á', 'a'], ['é', 'e'], ['í', 'i'], ['ó', 'o'], ['ú', 'u'], ['ü', 'u'], ['ñ', 'n'],
  ['Á', 'a'], ['É', 'e'], ['Í', 'i'], ['Ó', 'o'], ['Ú', 'u'], ['Ü', 'u'], ['Ñ', 'n'],
  ['à', 'a'], ['è', 'e'], ['ì', 'i'], ['ò', 'o'], ['ù', 'u'],
  ['â', 'a'], ['ê', 'e'], ['î', 'i'], ['ô', 'o'], ['û', 'u'],
];

/** SQL expression: column folded to lowercase, accent-stripped. */
function fold(col: string): string {
  let expr = col;
  for (const [a, b] of ACCENTS) expr = `replace(${expr},'${a}','${b}')`;
  return `lower(${expr})`;
}

/** SQL expression: column reduced to bare cédula digits (drops dots/dashes/
 *  spaces and the V-/E- nationality prefix) so formatting never blocks a match. */
function digitsExpr(col: string): string {
  let e = col;
  for (const ch of ['.', '-', ' ', 'V', 'E', 'v', 'e']) e = `replace(${e},'${ch}','')`;
  return e;
}

/** Split a normalized name into matchable tokens (≥2 chars). Falls back to the
 *  whole string when every token is too short (e.g. "Jo"). */
function nameTokens(norm: string): string[] {
  const toks = norm.split(' ').filter((t) => t.length >= 2);
  return toks.length ? toks : norm ? [norm] : [];
}

/** Build an accent/case-insensitive, order-independent name predicate: every
 *  search token must appear (as a substring) in at least one of `cols`. */
function nameWhere(cols: string[], tokenCount: number): string {
  const perToken = '(' + cols.map((c) => `${fold(c)} LIKE ?`).join(' OR ') + ')';
  return Array.from({ length: tokenCount }, () => perToken).join(' AND ');
}

/** Binds for nameWhere: `%token%` once per column, per token (matching order). */
function nameBinds(cols: string[], tokens: string[]): string[] {
  const binds: string[] = [];
  for (const t of tokens) for (let i = 0; i < cols.length; i++) binds.push(`%${t}%`);
  return binds;
}

/** Normalize the raw identifiers a user supplied. Pure. */
export function normalizePersonInput(input: {
  name?: string;
  cedula?: string;
  dob?: string;
}, nowMs = Date.now()): NormalizedInput {
  const out: NormalizedInput = {};
  if (input.name && input.name.trim()) {
    out.name = input.name.trim();
    out.normName = normName(input.name);
  }
  if (input.cedula) {
    const c = normalizeCedula(input.cedula);
    if (c) out.cedula = c;
  }
  if (input.dob && /^\d{4}-\d{2}-\d{2}$/.test(input.dob)) {
    out.dob = input.dob;
    const ms = Date.parse(input.dob + 'T00:00:00Z');
    if (Number.isFinite(ms)) out.ageFromDob = Math.floor((nowMs - ms) / YEAR_MS);
  }
  return out;
}

// ---- status mapping (internal → public) ------------------------------------

const PERSONS_MAP: Record<string, PublicStatus> = {
  missing: 'MISSING',
  found_safe: 'LOCATED',
  aparecido: 'LOCATED',
  hospitalizado: 'HOSPITALIZED',
  found_deceased: 'DEATH',
  unknown: 'UNKNOWN',
};
const PERSONAS_MAP: Record<string, PublicStatus> = {
  'sin-contacto': 'MISSING',
  localizado: 'LOCATED',
  aparecido: 'LOCATED',
  hospitalizado: 'HOSPITALIZED',
  fallecido: 'DEATH',
};
const HOSPITAL_MAP: Record<string, PublicStatus> = {
  hospitalizado: 'HOSPITALIZED',
  alta: 'ALIVE',
  fallecido: 'DEATH',
  desconocido: 'UNKNOWN',
};

/** Map a raw registry status to the public vocabulary (verification applied
 *  separately by gatePublicStatus). Unknown values fail safe to UNKNOWN. */
export function mapInternalStatusToPublicStatus(registry: Registry, status: string): PublicStatus {
  const s = String(status || '').toLowerCase().trim();
  const table = registry === 'persons' ? PERSONS_MAP : registry === 'personas' ? PERSONAS_MAP : HOSPITAL_MAP;
  return table[s] ?? 'UNKNOWN';
}

/**
 * The verification gate. A definitive status (ALIVE/DEATH/MISSING/HOSPITALIZED/
 * LOCATED) may only stand when the record is VERIFIED or OFFICIAL; otherwise we
 * return PENDING_VERIFICATION and never assert the underlying claim.
 */
export function gatePublicStatus(mapped: PublicStatus, level: VerificationLevel): PublicStatus {
  if (level === 'PENDING_VERIFICATION') return 'PENDING_VERIFICATION';
  return mapped;
}

// ---- row → CaseRecord hydration --------------------------------------------

function hydratePerson(row: any, matchStrength: MatchStrength): CaseRecord {
  const level: VerificationLevel = row.review === 'approved' ? 'VERIFIED' : 'PENDING_VERIFICATION';
  const mapped = mapInternalStatusToPublicStatus('persons', row.status);
  const age = row.age == null ? null : Number(row.age);
  return {
    registry: 'persons',
    internalId: String(row.id),
    caseId: row.case_number || `CASE-${row.id}`,
    fullName: String(row.full_name ?? ''),
    age: Number.isFinite(age as number) ? (age as number) : null,
    isMinor: isMinor(age, row.incident_type),
    protectedFlag: !!row.protected,
    internalStatus: String(row.status ?? ''),
    publicStatus: gatePublicStatus(mapped, level),
    verification: level,
    generalLocation: coarsenLocation(row.last_seen),
    lastVerifiedMs: row.updated_ms == null ? null : Number(row.updated_ms),
    matchStrength,
    sensitive: {
      phone: row.contact_phone ?? null,
      address: row.last_seen ?? null,
      medicalNotes: row.notes ?? null,
    },
  };
}

function hydratePersona(row: any, matchStrength: MatchStrength): CaseRecord {
  const level: VerificationLevel = row.moderation === 'approved' ? 'VERIFIED' : 'PENDING_VERIFICATION';
  const mapped = mapInternalStatusToPublicStatus('personas', row.estado);
  const age = row.edad == null ? null : Number(row.edad);
  return {
    registry: 'personas',
    internalId: String(row.id),
    caseId: `FAM-${row.id}`,
    fullName: String(row.nombre ?? ''),
    age: Number.isFinite(age as number) ? (age as number) : null,
    isMinor: isMinor(age, null),
    protectedFlag: !!row.protected,
    internalStatus: String(row.estado ?? ''),
    publicStatus: gatePublicStatus(mapped, level),
    verification: level,
    generalLocation: coarsenLocation(row.ubicacion),
    lastVerifiedMs: row.updated_at == null ? null : Number(row.updated_at),
    matchStrength,
    sensitive: {
      phone: row.contacto ?? null,
      address: row.ubicacion ?? null,
      familyContact: row.localizado_contacto ?? null,
    },
  };
}

function hydrateHospital(row: any, matchStrength: MatchStrength): CaseRecord {
  // The hospital feed is an official registry; a row is VERIFIED unless flagged
  // "ESTADO EN CONFLICTO" (conflict=1), which means operators must reconcile it.
  const level: VerificationLevel = row.conflict ? 'PENDING_VERIFICATION' : 'VERIFIED';
  const mapped = mapInternalStatusToPublicStatus('hospital', row.estado);
  const ageNum = Number(String(row.edad ?? '').replace(/[^0-9]/g, ''));
  const age = Number.isFinite(ageNum) && ageNum > 0 ? ageNum : null;
  return {
    registry: 'hospital',
    internalId: String(row.id),
    caseId: `HOSP-${row.id}`,
    fullName: String(row.full_name ?? ''),
    age,
    isMinor: isMinor(age, null),
    protectedFlag: false,
    internalStatus: String(row.estado ?? ''),
    publicStatus: gatePublicStatus(mapped, level),
    verification: level,
    generalLocation: coarsenLocation(row.direccion),
    lastVerifiedMs: row.updated_ms == null ? null : Number(row.updated_ms),
    matchStrength,
    sensitive: {
      cedula: row.cedula ?? null,
      phone: row.telefono ?? null,
      address: row.direccion ?? null,
      hospital: row.hospital ?? null,
      medicalNotes: row.observaciones ?? null,
    },
  };
}

const PERSON_COLS = 'id, full_name, age, status, review, case_number, incident_type, protected, contact_phone, notes, last_seen, updated_ms';
const PERSONA_COLS = 'id, nombre, edad, estado, moderation, protected, contacto, ubicacion, localizado_contacto, updated_at';
const HOSP_COLS = 'id, full_name, edad, cedula, telefono, direccion, hospital, estado, conflict, observaciones, updated_ms';

// ---- public adapter API -----------------------------------------------------

/** Look up a single case by its public/human id (EXP-/FAM-/HOSP-/internal). */
export async function getCaseById(env: Env, caseIdRaw: string): Promise<CaseRecord | null> {
  const caseId = String(caseIdRaw || '').trim();
  if (!caseId) return null;
  const up = caseId.toUpperCase();

  if (up.startsWith('FAM-')) {
    const id = caseId.slice(4);
    const row: any = await env.DB.prepare(`SELECT ${PERSONA_COLS} FROM personas WHERE id = ?`).bind(id).first();
    return row ? hydratePersona(row, 'case_id') : null;
  }
  if (up.startsWith('HOSP-')) {
    const id = caseId.slice(5);
    const row: any = await env.DB.prepare(`SELECT ${HOSP_COLS} FROM hospital_patients WHERE id = ?`).bind(id).first();
    return row ? hydrateHospital(row, 'case_id') : null;
  }
  // Native persons: by case_number (EXP-2026-NNNN) first, then raw id.
  let row: any = await env.DB
    .prepare(`SELECT ${PERSON_COLS} FROM persons WHERE case_number = ? OR id = ? LIMIT 1`)
    .bind(caseId, caseId)
    .first();
  if (row) return hydratePerson(row, 'case_id');
  // Fall back to a raw personas / hospital id (CASE-/hosp-/fam- internal forms).
  row = await env.DB.prepare(`SELECT ${PERSONA_COLS} FROM personas WHERE id = ?`).bind(caseId).first();
  if (row) return hydratePersona(row, 'case_id');
  row = await env.DB.prepare(`SELECT ${HOSP_COLS} FROM hospital_patients WHERE id = ?`).bind(caseId).first();
  if (row) return hydrateHospital(row, 'case_id');
  return null;
}

/**
 * Look up by national id (cédula). Strong match. Cédula is only stored on
 * hospital_patients and on the operator-only case_identity table; we resolve
 * case_identity → its underlying case so a verified id maps to a real status.
 */
export async function searchPersonById(env: Env, cedulaRaw: string): Promise<CaseRecord[]> {
  const cedula = normalizeCedula(cedulaRaw);
  if (!cedula || cedula.length < 5) return [];
  const out: CaseRecord[] = [];

  const hosp: any = await env.DB
    .prepare(`SELECT ${HOSP_COLS} FROM hospital_patients WHERE ${digitsExpr('cedula')} = ? LIMIT ${MAX_RESULTS}`)
    .bind(cedula)
    .all();
  for (const r of hosp?.results ?? []) out.push(hydrateHospital(r, 'national_id'));

  // case_identity.cedula → person_id ('per_…' | 'fam-<id>' | 'hosp-<id>'). Only
  // rows where the institutional verification actually matched are trustworthy.
  const ident: any = await env.DB
    .prepare(`SELECT person_id, result FROM case_identity WHERE ${digitsExpr('cedula')} = ? AND result = 'match' LIMIT ${MAX_RESULTS}`)
    .bind(cedula)
    .all();
  for (const r of ident?.results ?? []) {
    const rec = await resolveByPersonId(env, String(r.person_id), 'national_id');
    if (rec) {
      rec.verification = 'OFFICIAL'; // confirmed against an institution (CNE/SAIME)
      rec.publicStatus = gatePublicStatus(mapInternalStatusToPublicStatus(rec.registry, rec.internalStatus), 'OFFICIAL');
      out.push(rec);
    }
  }
  return dedupe(out);
}

/** Resolve a federated person_id ('per_…' | 'fam-<id>' | 'hosp-<id>') to a record. */
async function resolveByPersonId(env: Env, personId: string, strength: MatchStrength): Promise<CaseRecord | null> {
  if (personId.startsWith('fam-')) {
    const row: any = await env.DB.prepare(`SELECT ${PERSONA_COLS} FROM personas WHERE id = ?`).bind(personId.slice(4)).first();
    return row ? hydratePersona(row, strength) : null;
  }
  if (personId.startsWith('hosp-')) {
    const row: any = await env.DB.prepare(`SELECT ${HOSP_COLS} FROM hospital_patients WHERE id = ?`).bind(personId.slice(5)).first();
    return row ? hydrateHospital(row, strength) : null;
  }
  const row: any = await env.DB.prepare(`SELECT ${PERSON_COLS} FROM persons WHERE id = ?`).bind(personId).first();
  return row ? hydratePerson(row, strength) : null;
}

/**
 * Search by full name (and optional DOB/age corroboration) across the native
 * persons registry and the Familia personas registry. A DOB whose derived age
 * matches the row's age upgrades the match to 'name_dob' (strong); otherwise it
 * stays 'name' (weak — existence only). Partial names should be filtered out by
 * the caller before reaching here.
 */
export async function searchPersonByName(
  env: Env,
  input: { name: string; dob?: string },
  nowMs = Date.now(),
): Promise<CaseRecord[]> {
  const norm = normalizePersonInput({ name: input.name, dob: input.dob }, nowMs);
  if (!norm.name) return [];
  const tokens = nameTokens(norm.normName ?? '');
  if (!tokens.length) return [];
  const out: CaseRecord[] = [];

  const persons: any = await env.DB
    .prepare(`SELECT ${PERSON_COLS} FROM persons WHERE ${nameWhere(['full_name'], tokens.length)} LIMIT ${MAX_RESULTS}`)
    .bind(...nameBinds(['full_name'], tokens))
    .all();
  for (const r of persons?.results ?? []) out.push(hydratePerson(r, 'name'));

  const personas: any = await env.DB
    .prepare(`SELECT ${PERSONA_COLS} FROM personas WHERE ${nameWhere(['nombre'], tokens.length)} LIMIT ${MAX_RESULTS}`)
    .bind(...nameBinds(['nombre'], tokens))
    .all();
  for (const r of personas?.results ?? []) out.push(hydratePersona(r, 'name'));

  // Corroborate with DOB-derived age + a real name overlap → strong match.
  for (const rec of out) {
    const nameOverlap = namesRoughlyMatch(norm.name, rec.fullName);
    if (norm.ageFromDob != null && rec.age != null && Math.abs(norm.ageFromDob - rec.age) <= 1 && nameOverlap) {
      rec.matchStrength = 'name_dob';
    }
  }
  return dedupe(out).slice(0, MAX_RESULTS);
}

/** Search the hospital registry by name (and optional cédula). */
export async function searchHospitalized(
  env: Env,
  input: { name?: string; cedula?: string },
): Promise<CaseRecord[]> {
  const out: CaseRecord[] = [];
  const cedula = input.cedula ? normalizeCedula(input.cedula) : '';
  if (cedula && cedula.length >= 5) {
    const r: any = await env.DB
      .prepare(`SELECT ${HOSP_COLS} FROM hospital_patients WHERE ${digitsExpr('cedula')} = ? LIMIT ${MAX_RESULTS}`)
      .bind(cedula)
      .all();
    for (const row of r?.results ?? []) out.push(hydrateHospital(row, 'national_id'));
  }
  if (input.name && input.name.trim()) {
    const cols = ['full_name', 'name_variants'];
    const tokens = nameTokens(normName(input.name));
    if (tokens.length) {
      const r: any = await env.DB
        .prepare(
          `SELECT ${HOSP_COLS} FROM hospital_patients
           WHERE ${nameWhere(cols, tokens.length)}
           ORDER BY (estado='hospitalizado') DESC LIMIT ${MAX_RESULTS}`,
        )
        .bind(...nameBinds(cols, tokens))
        .all();
      for (const row of r?.results ?? []) out.push(hydrateHospital(row, 'name'));
    }
  }
  return dedupe(out).slice(0, MAX_RESULTS);
}

/**
 * Search by phone number. SENSITIVE — callers must gate this to operators
 * before invoking. Matches persons.contact_phone / personas.contacto /
 * hospital_patients.telefono on their digit-only form.
 */
export async function searchByPhone(env: Env, phoneRaw: string): Promise<CaseRecord[]> {
  const digits = String(phoneRaw || '').replace(/[^0-9]/g, '');
  if (digits.length < 7) return [];
  const like = `%${digits.slice(-7)}%`; // match on the last 7 digits (ignore country/area prefixes)
  const out: CaseRecord[] = [];
  const p: any = await env.DB
    .prepare(`SELECT ${PERSON_COLS} FROM persons WHERE replace(replace(replace(contact_phone,' ',''),'-',''),'+','') LIKE ? LIMIT ${MAX_RESULTS}`)
    .bind(like)
    .all();
  for (const r of p?.results ?? []) out.push(hydratePerson(r, 'phone'));
  const h: any = await env.DB
    .prepare(`SELECT ${HOSP_COLS} FROM hospital_patients WHERE replace(replace(replace(telefono,' ',''),'-',''),'+','') LIKE ? LIMIT ${MAX_RESULTS}`)
    .bind(like)
    .all();
  for (const r of h?.results ?? []) out.push(hydrateHospital(r, 'phone'));
  return dedupe(out).slice(0, MAX_RESULTS);
}

/** Search ONLY still-missing cases by name (persons.status='missing' /
 *  personas.estado='sin-contacto'). */
export async function searchMissing(env: Env, input: { name: string }): Promise<CaseRecord[]> {
  const all = await searchPersonByName(env, { name: input.name });
  return all.filter((r) => r.publicStatus === 'MISSING' || r.internalStatus === 'missing' || r.internalStatus === 'sin-contacto');
}

/**
 * Return a copy of the record with sensitive fields removed unless the viewer is
 * authorized to see them. The default (public) path NEVER carries cédula, phone,
 * address, hospital name, medical notes, or family contact.
 */
export function redactSensitiveFields(record: CaseRecord, canSeeSensitive: boolean): CaseRecord {
  if (canSeeSensitive) return record;
  return { ...record, sensitive: {} };
}

/** True when a public (non-privileged) viewer must not see this record at all
 *  (operator-protected case, or a resolved minor whose alert is no longer needed). */
export function isHiddenFromPublic(record: CaseRecord): boolean {
  return isPublicSuppressed({
    age: record.age,
    status: record.registry === 'persons' ? record.internalStatus : undefined,
    estado: record.registry !== 'persons' ? record.internalStatus : undefined,
    protected: record.protectedFlag ? 1 : 0,
  });
}

function dedupe(records: CaseRecord[]): CaseRecord[] {
  const seen = new Set<string>();
  const out: CaseRecord[] = [];
  for (const r of records) {
    const key = `${r.registry}:${r.internalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
