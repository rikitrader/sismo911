// OCR-artifact normalization for ingested people data.
// ---------------------------------------------------------------------------
// The 2026-07-05 roster incident put OCR artifacts into the intake stream:
// "22 ohms" (OCR of "22 años"), "ILEGIBLE SOL" (the transcriber's marker for an
// unreadable name), fused names ("JERRYSCOBAR"), stray glyphs. This module is
// the single place that handles them, under the platform's No-Fabrication rule:
//
//   REPAIR only what is mechanically unambiguous (an age unit misread — the
//   digits are the data, the unit is decoration). FLAG everything else and
//   preserve the original text — a name is never rewritten by guesswork.
//
// Flags ride ExtractedRecord.ocrFlags and force operator review downstream.

import { normalizeText } from './search-normalize';

/** Advisory flags — presence means "an operator must look at this". */
export type OcrFlag = 'illegible_marker' | 'suspect_glyphs' | 'age_unit_repaired';

const AGE_UNIT_CANON = 'anos';
// Explicit allowlist of misreads seen in the wild, checked before edit distance.
const AGE_UNIT_ALIASES = new Set(['ohms', 'ohm', 'afios', 'aftos', 'anios', 'aros', 'arios', 'anos', 'ano', 'aos']);

/** Levenshtein distance, small-string only (age-unit tokens are ≤6 chars). */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}

/** True when `token` reads as an OCR'd "años" (accent-folded, ≤2 edits). */
export function isAgeUnitToken(token: string): boolean {
  const t = normalizeText(token);
  if (!t || t.length > 6 || /\d/.test(t)) return false;
  if (AGE_UNIT_ALIASES.has(t)) return true;
  return editDistance(t, AGE_UNIT_CANON) <= 2 && t.startsWith('a');
}

export interface AgeRepair {
  age: number | null;
  rest: string; // the input with the trailing "<digits> <unit>" segment removed
  repaired: boolean; // true when the unit was an OCR misread (not a clean "años")
}

const AGE_TAIL_RE = /^(.*?)[\s·•\-–]*?(\d{1,3})\s*([\p{L}]{2,8})?\s*$/u;
const CLEAN_UNITS = new Set(['anos', 'ano']); // normalized forms of años/año

/**
 * Split a roster-line body into name + age, tolerating OCR'd age units.
 * "DENIS YANES · 22 ohms" → { rest: "DENIS YANES", age: 22, repaired: true }.
 * A trailing bare number also counts as an age ("MARIA PEREZ - 40").
 */
export function repairAgeToken(body: string): AgeRepair {
  const m = body.match(AGE_TAIL_RE);
  if (m) {
    const [, head, digits, unit] = m;
    const n = parseInt(digits, 10);
    const okAge = Number.isFinite(n) && n >= 0 && n < 130;
    const unitNorm = unit ? normalizeText(unit) : '';
    const unitOk = !unit || isAgeUnitToken(unit);
    if (okAge && unitOk && head.trim()) {
      return { age: n, rest: head.trim(), repaired: !!unit && !CLEAN_UNITS.has(unitNorm) };
    }
  }
  return { age: null, rest: body.trim(), repaired: false };
}

// "ILEGIBLE", "NO LEGIBLE", "(ilegible)" — transcriber markers, not names.
const ILLEGIBLE_RE = /\b(?:ilegible|no\s+legible|ininteligible)\b/i;
// Junk commonly left on line edges by OCR: pipes, tildes, carets, underscores…
const EDGE_JUNK_RE = /^[\s|_~^*·•°"“”'`]+|[\s|_~^*·•°"“”'`]+$/g;

export interface CleanedName {
  name: string | null; // cleaned display name, or null when only a marker remained
  flags: OcrFlag[];
  original: string; // the raw input, always preserved for the operator note
}

/** True for a token that looks OCR-garbled (digits inside a word, no vowels…). */
function suspectToken(t: string): boolean {
  if (/\d/.test(t)) return true; // digits inside a name token
  const folded = normalizeText(t);
  if (folded.length >= 4 && !/[aeiou]/.test(folded)) return true; // no vowels
  if (folded.length >= 14) return true; // likely two fused names (JERRYSCOBAR)
  return false;
}

/**
 * Clean a name read by OCR: strip edge junk, collapse whitespace, drop
 * transcriber "ILEGIBLE" markers, and FLAG (never rewrite) suspect tokens.
 */
export function cleanOcrName(raw: string | null | undefined): CleanedName {
  const original = String(raw ?? '');
  const flags: OcrFlag[] = [];
  let s = original.replace(EDGE_JUNK_RE, '').replace(/\s+/g, ' ').trim();

  if (ILLEGIBLE_RE.test(s)) {
    flags.push('illegible_marker');
    s = s
      .replace(ILLEGIBLE_RE, '')
      .replace(/\(\s*\)|\[\s*\]/g, '') // brackets left empty by the removal
      .replace(EDGE_JUNK_RE, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  if (s) {
    const tokens = s.split(' ');
    // A one-token "full name" ≥10 chars is usually two fused names
    // ("JERRYSCOBAR"); real single surnames in the wild top out around 9.
    const fusedSingle = tokens.length === 1 && normalizeText(tokens[0]).length >= 10;
    if (tokens.some(suspectToken) || fusedSingle) flags.push('suspect_glyphs');
  }

  return { name: s || null, flags, original };
}

/** Merge flag arrays without duplicates (order-stable). */
export function mergeFlags(...lists: Array<OcrFlag[] | undefined>): OcrFlag[] {
  const out: OcrFlag[] = [];
  for (const l of lists) for (const f of l ?? []) if (!out.includes(f)) out.push(f);
  return out;
}

/** Spanish operator note for a flagged record — carries the original text. */
export function ocrNote(flags: OcrFlag[], original: string): string {
  const labels: Record<OcrFlag, string> = {
    illegible_marker: 'marcador "ilegible" del transcriptor',
    suspect_glyphs: 'caracteres sospechosos de OCR',
    age_unit_repaired: 'unidad de edad reparada (p. ej. "ohms" → "años")',
  };
  const what = flags.map((f) => labels[f]).join('; ');
  return `Posible error de OCR (${what}). Texto original: "${original.slice(0, 160)}"`;
}
