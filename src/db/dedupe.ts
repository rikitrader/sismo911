// SISMO911 — layered duplicate-scoring engine (pure; no I/O).
// ---------------------------------------------------------------------------
// Scores a PAIR of person-like records with layered matching:
//   exact      — cedula / source-record / phone / email
//   strong     — fuzzy name + corroborating fields (age, municipio, estado,
//                family phone, last-seen location)
//   weak       — name-only / location-only (never actionable alone)
// Thresholds: score ≥90 → auto-merge candidate · 70–89 → human review · <70 no.
//
// SENSITIVE GUARDS (hard, override any score):
//   · estado conflict (one alive/localizada, other fallecida) → NEVER auto,
//     always a critical conflict for human review.
//   · either record a minor (edad < 18) → never auto-merge.
//   · name-only evidence (no exact key AND no corroborating field) → never
//     auto-merge regardless of name similarity (namesakes: maria gonzalez ×9).
//
// Callers (cleanup script, hourly cron, pre-ingest gate) do the SQL and feed
// records in; this module stays deterministic and unit-testable.

import { normalizeName } from '../lib/search-normalize';

/** Minimal shape the engine scores. Map each table's columns into this. */
export interface DedupeRecord {
  id: string;
  fullName: string | null;
  cedula: string | null; // digits only
  phone: string | null;
  email: string | null;
  age: number | null;
  municipality: string | null;
  state: string | null;
  familyPhone: string | null;
  lastSeenLocation: string | null;
  sourceName: string | null;
  sourceRecordId: string | null;
  status: string | null; // table-specific estado/status value
  updatedMs: number | null;
  /** number of non-null informative fields — completeness for keeper choice */
  completeness?: number;
}

export interface PairScore {
  score: number;
  signals: string[]; // rule names that fired, e.g. ['cedula', 'name_fuzzy', 'age']
  decision: 'auto_merge' | 'review' | 'ignore';
  conflicts: Array<{ field: string; valueA: string; valueB: string; severity: 'review' | 'critical' }>;
}

export const AUTO_MERGE_THRESHOLD = 90;
export const REVIEW_THRESHOLD = 70;

// Estado buckets: merging across ALIVE and DECEASED is a critical conflict.
const DECEASED = /fallecid|deceased|muert/i;
const ALIVE = /localizad|atendid|vivo|alive|hospitaliz|encontrad/i;
function statusBucket(s: string | null): 'deceased' | 'alive' | 'unknown' {
  if (!s) return 'unknown';
  if (DECEASED.test(s)) return 'deceased';
  if (ALIVE.test(s)) return 'alive';
  return 'unknown';
}

const digits = (s: string | null): string => (s ?? '').replace(/\D/g, '');

/** Phone equality on the last 10 digits (tolerates +58 / 0 prefixes). */
function phonesMatch(a: string | null, b: string | null): boolean {
  const da = digits(a);
  const db = digits(b);
  if (da.length < 7 || db.length < 7) return false;
  return da.slice(-10) === db.slice(-10);
}

function tokens(name: string | null): string[] {
  return [...new Set(normalizeName(name ?? '').split(' ').filter((t) => t.length >= 3))];
}

/** Jaccard token overlap of the two names (0..1). */
export function nameSimilarity(a: string | null, b: string | null): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const setB = new Set(tb);
  const inter = ta.filter((t) => setB.has(t)).length;
  return inter / (ta.length + tb.length - inter);
}

const NAME_FUZZY_MIN = 0.6;

/** Count informative fields — used to pick the keeper (most complete wins). */
export function completeness(r: DedupeRecord): number {
  return [r.fullName, r.cedula, r.phone, r.email, r.age, r.municipality, r.state, r.familyPhone, r.lastSeenLocation, r.status].filter(
    (v) => v !== null && v !== undefined && String(v).trim() !== '',
  ).length;
}

/** Score one pair. Pure — same input, same output. */
export function scorePair(a: DedupeRecord, b: DedupeRecord): PairScore {
  let score = 0;
  const signals: string[] = [];
  const add = (points: number, signal: string): void => {
    score += points;
    signals.push(signal);
  };

  // --- exact layer ---------------------------------------------------------
  if (a.cedula && b.cedula && digits(a.cedula) === digits(b.cedula) && digits(a.cedula).length >= 5) add(100, 'cedula');
  if (a.sourceRecordId && b.sourceRecordId && a.sourceName && a.sourceName === b.sourceName && a.sourceRecordId === b.sourceRecordId) add(95, 'source_record');
  if (phonesMatch(a.phone, b.phone)) add(90, 'phone');
  if (a.email && b.email && a.email.trim().toLowerCase() === b.email.trim().toLowerCase()) add(90, 'email');
  const exact = signals.length > 0;

  // --- strong fuzzy layer --------------------------------------------------
  const sim = nameSimilarity(a.fullName, b.fullName);
  if (sim >= NAME_FUZZY_MIN) add(40, 'name_fuzzy');
  if (a.age != null && b.age != null && Math.abs(a.age - b.age) <= 1) add(15, 'age');
  if (a.municipality && b.municipality && normalizeName(a.municipality) === normalizeName(b.municipality)) add(15, 'municipality');
  if (a.state && b.state && normalizeName(a.state) === normalizeName(b.state)) add(10, 'state');
  if (phonesMatch(a.familyPhone, b.familyPhone)) add(30, 'family_phone');
  if (a.lastSeenLocation && b.lastSeenLocation && nameSimilarity(a.lastSeenLocation, b.lastSeenLocation) >= 0.5) add(20, 'last_seen');

  // --- conflicts ------------------------------------------------------------
  const conflicts: PairScore['conflicts'] = [];
  const ba = statusBucket(a.status);
  const bb = statusBucket(b.status);
  if (ba !== 'unknown' && bb !== 'unknown' && ba !== bb) {
    conflicts.push({ field: 'status', valueA: String(a.status), valueB: String(b.status), severity: 'critical' });
  }
  if (a.age != null && b.age != null && Math.abs(a.age - b.age) > 5) {
    conflicts.push({ field: 'age', valueA: String(a.age), valueB: String(b.age), severity: 'review' });
  }

  // --- decision -------------------------------------------------------------
  let decision: PairScore['decision'] = score >= AUTO_MERGE_THRESHOLD ? 'auto_merge' : score >= REVIEW_THRESHOLD ? 'review' : 'ignore';

  // Sensitive guards — demote auto_merge, never promote.
  if (decision === 'auto_merge') {
    const minor = (a.age != null && a.age < 18) || (b.age != null && b.age < 18);
    const criticalConflict = conflicts.some((c) => c.severity === 'critical');
    // Name-only evidence: nothing exact fired and the only strong signal is the
    // name itself (no corroboration) → review, never auto (namesake risk).
    const corroborated = signals.some((s) => !['name_fuzzy'].includes(s));
    if (minor || criticalConflict || (!exact && !corroborated)) decision = 'review';
  }

  return { score, signals, decision, conflicts };
}

/** Pick the keeper: most complete record wins; ties go to most recent. */
export function pickKeeper(a: DedupeRecord, b: DedupeRecord): { keeper: DedupeRecord; loser: DedupeRecord } {
  const ca = a.completeness ?? completeness(a);
  const cb = b.completeness ?? completeness(b);
  if (ca !== cb) return ca > cb ? { keeper: a, loser: b } : { keeper: b, loser: a };
  const ua = a.updatedMs ?? 0;
  const ub = b.updatedMs ?? 0;
  if (ua !== ub) return ua > ub ? { keeper: a, loser: b } : { keeper: b, loser: a };
  return a.id <= b.id ? { keeper: a, loser: b } : { keeper: b, loser: a };
}

/** Stable candidate id for the UNIQUE(table,id_a,id_b) idempotency contract. */
export function pairKey(table: string, idA: string, idB: string): { idA: string; idB: string; key: string } {
  const [x, y] = idA <= idB ? [idA, idB] : [idB, idA];
  return { idA: x, idB: y, key: `${table}:${x}:${y}` };
}
