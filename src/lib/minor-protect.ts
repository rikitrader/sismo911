// SISMO911 — Minor (under-18) public-exposure protection for missing-person cases.
// ---------------------------------------------------------------------------
// A PURE, DETERMINISTIC module. It does not decide whether a child should be
// findable — a missing-child alert is legitimate and lifesaving. It decides how
// a minor's data is exposed on PUBLIC (anonymous) surfaces so the alert works
// without turning the child into a permanently search-indexed, precisely-located
// target.
//
// Chosen posture (2026-06-29) — "public alert, hardened":
//   1. Minor case stays publicly findable (name + photo + age + LOCALITY).
//   2. Its shareable article is NOT search-indexed (robots:noindex) and never
//      fed to the sitemap → no permanent Google cache of a child's name+face.
//   3. Last-seen is coarsened to ~locality level for the public (drop the street).
//   4. Once the case is RESOLVED (found alive/hospitalized/deceased) the alert is
//      no longer needed → the minor is auto-suppressed from public surfaces.
//   5. An operator may flag ANY case `protected` (trafficking/safety concern) →
//      it drops to responder-only (suppressed from every public surface).
//
// Minor detection mirrors src/lib/case-score.ts exactly (age ≤ 17, else the
// 'menor' incident type) so triage and protection never disagree.

export const MINOR_MAX_AGE = 17;

// Found-alive (found_safe / aparecido / hospitalizado) and deceased all resolve a
// case — no active public search is needed afterwards. Mirrors CaseStatus and the
// `personas.estado` vocabulary used across persons.ts / familia.ts.
const RESOLVED_STATUS = new Set(['found_safe', 'aparecido', 'hospitalizado', 'found_deceased']);
const RESOLVED_ESTADO = new Set(['localizado', 'aparecido', 'hospitalizado', 'fallecido']);

/** A case subject is a minor: age ≤ 17 when known, else the 'menor' incident type. */
export function isMinor(age?: number | null, incidentType?: string | null): boolean {
  const a = typeof age === 'number' && Number.isFinite(age) ? age : null;
  return a != null ? a >= 0 && a <= MINOR_MAX_AGE : incidentType === 'menor';
}

/** The case is resolved (found alive, hospitalized, or deceased) by either vocabulary. */
export function isResolved(opts: { status?: string | null; estado?: string | null }): boolean {
  return (opts.status != null && RESOLVED_STATUS.has(opts.status)) ||
    (opts.estado != null && RESOLVED_ESTADO.has(opts.estado));
}

/**
 * Should this case be hidden from PUBLIC (anonymous) surfaces entirely?
 *
 * DISASTER-ZONE RULE (operator policy): in an active mass-casualty response ALL
 * case data is public so families can locate their people — including resolved
 * minors (hospitalized/deceased), because hiding a found child stops a searching
 * family from ever learning what happened. The ONLY records hidden from the
 * public are operator-flagged `protected` cases. Operators always see everything.
 */
export function isPublicSuppressed(opts: {
  age?: number | null; incidentType?: string | null;
  status?: string | null; estado?: string | null; protected?: number | boolean | null;
}): boolean {
  return !!opts.protected;
}

/**
 * Coarsen a freeform "last seen" location to ~locality level for a minor's public
 * view: drop street-level detail (house/road numbers and the most-specific
 * comma-separated segments) and keep the coarsest locality token. Venezuelan
 * address convention runs most-specific → coarsest, so the locality (city/state)
 * is the LAST comma segment. Returns null/'' unchanged so "unknown" stays unknown.
 */
export function coarsenLocation(text?: string | null): string | null {
  const raw = (text ?? '').trim();
  if (!raw) return text ?? null;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  let coarse = parts.length > 1 ? parts[parts.length - 1] : (parts[0] ?? raw);
  // Strip any surviving house/road number tokens (e.g. "Caracas 1010", "Nº 5").
  coarse = coarse.replace(/[#nN]?[º°]?\s*\d[\d.\-/]*/g, '').replace(/\s{2,}/g, ' ').trim();
  return coarse || 'Venezuela';
}

// House/unit number locators — the SHARPEST doxxing-grade precise location, and
// the safest to redact because they (almost) never appear in a physical
// description ("#5", "Nº 12", "No. 5", "casa 5", "apto 3B", "piso 2", "torre 4").
const HOUSE_NO_RE = /(?:#|n[º°]|n[o0]\.)\s*\d[\w-]*/gi;
const UNIT_RE = /\b(?:casa|apto|apartamento|piso|local|edificio|edif|torre|bloque|manzana|mz|quinta|qta)\.?\s*#?\s*\d[\w-]*/gi;

/**
 * Conservative street-address scrubber for a MINOR's public free-text
 * (descripcion / notes). Defense-in-depth on top of coarsenLocation() + noindex:
 * it redacts the sharpest precise locators (house/apartment/floor numbers) while
 * leaving physical-description prose (clothing, height, features) intact. Best-
 * effort — operators always see the unredacted text. Null/'' pass through.
 */
export function scrubMinorText(text?: string | null): string | null {
  const raw = text ?? '';
  if (!raw) return text ?? null;
  const out = raw.replace(HOUSE_NO_RE, '[reservado]').replace(UNIT_RE, '[reservado]');
  return out.replace(/\s{2,}/g, ' ').trim();
}

// ---- SQL fragments (single source of truth with the predicates above) -------
// Parameterless WHERE fragments so the public list/gallery/blog queries suppress
// exactly the same rows isPublicSuppressed() does on read. Keep these in lockstep
// with RESOLVED_* and MINOR_MAX_AGE.

/** A `personas` row is a minor (citizen reports carry only `edad`). */
export const PERSONAS_MINOR_SQL = '(edad BETWEEN 0 AND 17)';

/** A `personas` row must be hidden from PUBLIC: operator-protected only. */
export const PERSONAS_PUBLIC_SUPPRESS_SQL = "(protected = 1)";

/** Same suppression for the native `persons` table (default alias `p`). */
export const personsPublicSuppressSql = (alias = 'p') => `(${alias}.protected = 1)`;
