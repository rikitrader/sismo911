// Venezuela geographic gazetteer for structured estado / municipio search.
//
// Free-text locations (persons.last_seen, personas.ubicacion,
// hospital_patients.direccion|hospital) are parsed into a canonical
// `geo_estado` (one of the 24 federal entities) and a best-effort
// `geo_municipio` slug. Parsing is BEST-EFFORT: unparsed rows keep NULL and
// stay findable via the raw-location LIKE fallback in the search query. Seed /
// planning honesty — a parsed estado is an inference from user text, not a
// surveyed truth.

import { normalizeText } from './search-normalize';

export interface Estado { slug: string; label: string; aliases: string[] }

// slug = accent-free lowercase canonical key stored in geo_estado.
// aliases = extra surface forms (old names, capitals, common shorthands) that
// should resolve to this estado. All matched after normalizeText().
export const ESTADOS: Estado[] = [
  { slug: 'amazonas', label: 'Amazonas', aliases: ['puerto ayacucho'] },
  { slug: 'anzoategui', label: 'Anzoátegui', aliases: ['barcelona', 'puerto la cruz', 'el tigre', 'anzoategui'] },
  { slug: 'apure', label: 'Apure', aliases: ['san fernando de apure'] },
  { slug: 'aragua', label: 'Aragua', aliases: ['maracay', 'la victoria', 'turmero', 'cagua'] },
  { slug: 'barinas', label: 'Barinas', aliases: [] },
  { slug: 'bolivar', label: 'Bolívar', aliases: ['ciudad bolivar', 'ciudad guayana', 'puerto ordaz', 'san felix', 'bolivar'] },
  { slug: 'carabobo', label: 'Carabobo', aliases: ['valencia', 'puerto cabello', 'guacara', 'naguanagua', 'carabobo'] },
  { slug: 'cojedes', label: 'Cojedes', aliases: ['san carlos'] },
  { slug: 'delta amacuro', label: 'Delta Amacuro', aliases: ['tucupita', 'delta amacuro'] },
  { slug: 'distrito capital', label: 'Distrito Capital', aliases: ['caracas', 'distrito federal', 'libertador', 'dtto capital', 'ccs'] },
  { slug: 'falcon', label: 'Falcón', aliases: ['coro', 'punto fijo', 'falcon'] },
  { slug: 'guarico', label: 'Guárico', aliases: ['san juan de los morros', 'calabozo', 'valle de la pascua', 'guarico'] },
  { slug: 'lara', label: 'Lara', aliases: ['barquisimeto', 'carora', 'el tocuyo', 'cabudare'] },
  { slug: 'merida', label: 'Mérida', aliases: ['el vigia', 'merida'] },
  { slug: 'miranda', label: 'Miranda', aliases: ['los teques', 'petare', 'guarenas', 'guatire', 'charallave', 'ocumare del tuy', 'baruta', 'chacao', 'el hatillo', 'sucre miranda'] },
  { slug: 'monagas', label: 'Monagas', aliases: ['maturin', 'monagas'] },
  { slug: 'nueva esparta', label: 'Nueva Esparta', aliases: ['margarita', 'porlamar', 'la asuncion', 'pampatar', 'nueva esparta', 'isla de margarita'] },
  { slug: 'portuguesa', label: 'Portuguesa', aliases: ['guanare', 'acarigua', 'araure', 'portuguesa'] },
  { slug: 'sucre', label: 'Sucre', aliases: ['cumana', 'carupano', 'sucre'] },
  { slug: 'tachira', label: 'Táchira', aliases: ['san cristobal', 'la fria', 'rubio', 'tachira'] },
  { slug: 'trujillo', label: 'Trujillo', aliases: ['valera', 'bocono', 'trujillo'] },
  { slug: 'la guaira', label: 'La Guaira', aliases: ['vargas', 'litoral', 'catia la mar', 'maiquetia', 'macuto', 'caraballeda', 'naiguata', 'carayaca', 'la guaira'] },
  { slug: 'yaracuy', label: 'Yaracuy', aliases: ['san felipe', 'yaritagua', 'nirgua', 'chivacoa', 'yumare', 'yaracuy'] },
  { slug: 'zulia', label: 'Zulia', aliases: ['maracaibo', 'cabimas', 'ciudad ojeda', 'san francisco', 'machiques', 'zulia'] },
];

// Municipio / parroquia gazetteer, keyed by estado slug. Best-effort coverage:
// the earthquake-affected + most populous entities, plus La Guaira parroquias
// (Vargas has a single municipio but many parroquias people actually name).
// Names are stored as the geo_municipio slug (already accent-free lowercase).
const MUNICIPIOS: Record<string, string[]> = {
  'distrito capital': ['libertador'],
  'la guaira': ['catia la mar', 'maiquetia', 'la guaira', 'macuto', 'caraballeda', 'naiguata', 'carayaca', 'el junko'],
  miranda: ['sucre', 'baruta', 'chacao', 'el hatillo', 'guaicaipuro', 'los teques', 'plaza', 'guarenas', 'zamora', 'guatire', 'cristobal rojas', 'charallave', 'urdaneta', 'ocumare del tuy', 'paz castillo', 'santa lucia', 'acevedo', 'brion', 'higuerote'],
  aragua: ['girardot', 'maracay', 'santiago marino', 'turmero', 'sucre aragua', 'cagua', 'zamora aragua', 'villa de cura', 'jose felix ribas', 'la victoria', 'mario briceno iragorry', 'el limon', 'linares alcantara'],
  carabobo: ['valencia', 'puerto cabello', 'guacara', 'naguanagua', 'san diego', 'los guayos', 'libertador carabobo', 'tocuyito', 'bejuma', 'montalban', 'guigue', 'carlos arvelo'],
  yaracuy: ['san felipe', 'independencia', 'yaritagua', 'nirgua', 'bruzual', 'chivacoa', 'bolivar yaracuy', 'manuel monge', 'yumare', 'cocorote', 'la trinidad'],
  falcon: ['miranda falcon', 'coro', 'carirubana', 'punto fijo', 'los taques', 'zamora falcon', 'puerto cumarebo', 'silva', 'tucacas'],
  lara: ['iribarren', 'barquisimeto', 'palavecino', 'cabudare', 'torres', 'carora', 'moran', 'el tocuyo', 'jimenez', 'quibor'],
  zulia: ['maracaibo', 'san francisco', 'cabimas', 'lagunillas', 'ciudad ojeda', 'machiques', 'santa rita', 'la canada de urdaneta', 'mara', 'jesus enrique lossada'],
  anzoategui: ['bolivar anzoategui', 'barcelona', 'sotillo', 'puerto la cruz', 'simon bolivar', 'guanta', 'urbaneja', 'lecheria', 'anaco', 'el tigre', 'simon rodriguez'],
  bolivar: ['heres', 'ciudad bolivar', 'caroni', 'ciudad guayana', 'puerto ordaz', 'san felix'],
  tachira: ['san cristobal', 'cardenas', 'tariba', 'garcia de hevia', 'la fria', 'junin', 'rubio'],
  merida: ['libertador merida', 'merida', 'alberto adriani', 'el vigia', 'campo elias', 'ejido'],
  monagas: ['maturin', 'ezequiel zamora punta de mata'],
  sucre: ['sucre cumana', 'cumana', 'bermudez', 'carupano'],
  'nueva esparta': ['mariño', 'porlamar', 'maneiro', 'pampatar', 'garcia', 'la asuncion', 'arismendi'],
  portuguesa: ['guanare', 'paez', 'acarigua', 'araure', 'ospino'],
};

// Flat reverse index: municipio slug → estado slug (for inferring the estado
// when only a municipio/parroquia is named). Longer names win (checked first).
const MUNI_TO_ESTADO: Array<{ muni: string; estado: string }> = Object.entries(MUNICIPIOS)
  .flatMap(([estado, munis]) => munis.map((muni) => ({ muni, estado })))
  .sort((a, b) => b.muni.length - a.muni.length);

// Estado alias index, longest-first so "puerto la cruz" beats "cruz" etc.
const ESTADO_ALIASES: Array<{ term: string; slug: string }> = ESTADOS
  .flatMap((e) => [e.slug, ...e.aliases].map((term) => ({ term: normalizeText(term), slug: e.slug })))
  .filter((x) => x.term.length >= 3)
  .sort((a, b) => b.term.length - a.term.length);

/** Whole-word-ish substring test on already-normalized text (space-delimited). */
function hasPhrase(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return (' ' + haystack + ' ').includes(' ' + needle + ' ') || haystack.includes(needle);
}

export interface GeoParse { estado: string | null; municipio: string | null }

/** Parse one or more free-text location fragments into {estado, municipio}.
 *  Pass every location-ish field you have (e.g. last_seen + hospital); the
 *  first confident match wins. Returns nulls when nothing matches. */
export function parseLocation(...parts: Array<string | null | undefined>): GeoParse {
  const text = normalizeText(parts.filter(Boolean).join(' '));
  if (!text) return { estado: null, municipio: null };

  let estado: string | null = null;
  let municipio: string | null = null;

  // 1) municipio/parroquia (more specific) — also fixes the estado.
  for (const { muni, estado: est } of MUNI_TO_ESTADO) {
    if (hasPhrase(text, muni)) { municipio = muni; estado = est; break; }
  }

  // 2) estado directly (or to confirm/override when municipio gave none).
  if (!estado) {
    for (const { term, slug } of ESTADO_ALIASES) {
      if (hasPhrase(text, term)) { estado = slug; break; }
    }
  }

  return { estado, municipio };
}

/** Canonical estado slug for a user-supplied estado value (label/alias/slug),
 *  or '' if it doesn't resolve. Used to sanitize the ?estado= filter input. */
export function canonicalEstado(input: string | null | undefined): string {
  const n = normalizeText(input);
  if (!n) return '';
  for (const { term, slug } of ESTADO_ALIASES) if (term === n) return slug;
  // also accept an exact slug
  const direct = ESTADOS.find((e) => e.slug === n);
  return direct ? direct.slug : '';
}

/** Parse a free-text age (e.g. "34", "34 años", "30-40", "aprox 25", "") to a
 *  representative integer age, or null. For ranges, returns the low bound. */
export function parseAge(input: string | number | null | undefined): number | null {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 && input <= 130 ? Math.floor(input) : null;
  const m = String(input).match(/\d{1,3}/);
  if (!m) return null;
  const n = Number(m[0]);
  return n >= 0 && n <= 130 ? n : null;
}

/** The estado list for building the frontend <select> (slug + display label). */
export const ESTADO_OPTIONS = ESTADOS.map((e) => ({ slug: e.slug, label: e.label }));
