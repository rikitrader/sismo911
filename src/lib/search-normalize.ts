// Shared text normalization for accent- and case-insensitive search.
//
// Used by the unified case search endpoint, the persons/personas write paths,
// the backfill script, and the tests — one definition so the search term and
// the stored `name_norm` are folded identically. Mirrors the historic inline
// `normName` in src/routes/persons.ts (kept behaviourally identical).

/** Fold to lowercase, strip diacritics/ñ, collapse whitespace. Keeps letters,
 *  digits and single spaces. Safe on null/undefined. */
export function normalizeText(s: string | null | undefined): string {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // combining diacritics (á→a, é→e, ü→u …)
    .replace(/ñ/g, 'n')             // ñ decomposes to n + tilde above; belt & braces
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalized person name for the `name_norm` column / search key. */
export const normalizeName = normalizeText;

/** LIKE pattern for a normalized substring search (`%term%`). Empty term → ''. */
export function likeTerm(s: string | null | undefined): string {
  const n = normalizeText(s);
  return n ? `%${n}%` : '';
}
