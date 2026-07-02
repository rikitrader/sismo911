// Display-name normalization for INGESTED data.
//
// RULE (see CLAUDE.md → "Ingested names are Title Case"): external feeds (the
// Cruz Roja hospital registry, roster PDFs, etc.) arrive in ALL-CAPS. When we
// store a person's name for display we normalize it to Title Case — first letter
// of each word upper, the rest lower — so cards/tabs read "Abello Matilde", not
// "ABELLO MATILDE". This is a DISPLAY transform only: matching/dedupe keys are
// still built from normName() (lowercased, accent-stripped) and are unaffected.

// Spanish/Portuguese/Dutch name particles kept lowercase when they sit *between*
// given/family names (never when they are the first word). "MARIA DE LA CRUZ" →
// "Maria de la Cruz". "DE LEON JOSE" → "De Leon Jose" (leading particle stays cap).
const NAME_PARTICLES = new Set([
  'de', 'del', 'de la', 'la', 'las', 'los', 'y', 'e',
  'da', 'das', 'do', 'dos', 'di', 'van', 'von', 'der',
]);

function capWord(w: string): string {
  if (!w) return w;
  // Uppercase the first character (locale-aware so "ángel" → "Ángel"), lower the rest.
  return w.charAt(0).toLocaleUpperCase('es') + w.slice(1).toLocaleLowerCase('es');
}

/**
 * Title-case a person's name for display. Handles ALL-CAPS input, accents,
 * hyphenated names (Jean-Paul), and keeps Spanish particles lowercase mid-name.
 * Returns '' for empty/nullish input. Never throws.
 */
export function titleCaseName(input: string | null | undefined): string {
  const str = String(input || '').replace(/\s+/g, ' ').trim();
  if (!str) return '';
  const words = str.split(' ');
  return words
    .map((word, i) => {
      const lower = word.toLocaleLowerCase('es');
      if (i > 0 && NAME_PARTICLES.has(lower)) return lower; // mid-name particle stays lowercase
      // Capitalize each hyphen-separated sub-part (Jean-Paul, Ndiaye-Bâ).
      return word.split('-').map(capWord).join('-');
    })
    .join(' ');
}
