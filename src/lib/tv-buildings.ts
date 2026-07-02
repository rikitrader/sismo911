import type { Env } from '../types';
import { computeCost, band, type Cost } from './building-score';

// terremotovenezuela.com — public Supabase REST (PostgREST) data layer for the
// "Mapa de Daños Venezuela": real, citizen-reported damaged buildings WITH photo
// galleries for the 24-jun-2026 quake. Reverse-engineered from the site's Vite
// bundle. The `sb_publishable_...` key is PUBLIC (shipped in their browser JS);
// both URL + key have in-code fallbacks so the feature works before Worker vars
// are set. PostgREST caps a response at 1000 rows → paginate with `Range`.

const DEFAULT_URL = 'https://jckifxsdlnsvbztxydes.supabase.co';
const DEFAULT_KEY = 'sb_publishable_i7iEDrCVZcSt0k3RGFrY4g_WrtZBB4w'; // pragma: allowlist secret — public publishable key

export const TV_PAGE = 1000;

function cfg(env: Env) {
  const url = ((env as any).TV_SUPABASE_URL || DEFAULT_URL).replace(/\/+$/, '');
  const key = (env as any).TV_SUPABASE_KEY || DEFAULT_KEY;
  return { url, key };
}

// Raw row shape from terremotovenezuela's `buildings` table.
export interface TvRow {
  id: string; name: string | null; address: string | null; city: string | null; zone: string | null;
  lat: number | null; lng: number | null; damage_level: string | null; status: string | null;
  main_photo_url: string | null; media_urls: string[] | null; general_source: string | null;
  notes: string | null; has_missing_persons: boolean | null;
  created_at: string | null; updated_at: string | null; last_updated_at: string | null;
}

export interface TvPage { rows: TvRow[]; total: number; }

// Fetch one page [offset, offset+limit) of the buildings table. Returns rows plus
// the exact total parsed from the Content-Range header ("0-999/795").
export async function tvFetch(env: Env, offset = 0, limit = TV_PAGE): Promise<TvPage> {
  const { url, key } = cfg(env);
  const off = Math.max(0, offset);
  const lim = Math.max(1, Math.min(limit, TV_PAGE));
  const select = 'id,name,address,city,zone,lat,lng,damage_level,status,main_photo_url,media_urls,general_source,notes,has_missing_persons,created_at,updated_at,last_updated_at';
  const res = await fetch(`${url}/rest/v1/buildings?select=${select}&order=updated_at.desc`, {
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      Range: `${off}-${off + lim - 1}`,
      Prefer: 'count=exact',
    },
  });
  if (!res.ok) throw new Error(`tv buildings fetch ${res.status}`);
  const rows = (await res.json()) as TvRow[];
  const cr = res.headers.get('content-range') || '';
  const total = Number(cr.split('/')[1]) || rows.length;
  return { rows, total };
}

// ── damage_level → sismo911 status (drives HAZUS cost damage ratio + score) ────
const DAMAGE_STATUS: Record<string, string> = {
  total: 'COLAPSO_TOTAL',
  severo: 'COLAPSO_PARCIAL',
  parcial: 'DANADO',
};
export function tvStatus(damageLevel: string): string {
  return DAMAGE_STATUS[(damageLevel || '').toLowerCase()] || 'DANADO';
}

// ── city → state resolver (state sets the VE-2026 unit cost in computeCost) ────
// Keys are lowercased city names; buckets map to the COST_USD_M2 states.
const CITY_STATE: Record<string, string> = {
  // Distrito Capital
  caracas: 'Distrito Capital', 'distrito capital': 'Distrito Capital', libertador: 'Distrito Capital',
  // La Guaira (ex-Vargas) coastal belt
  'la guaira': 'La Guaira', maiquetia: 'La Guaira', 'maiquetía': 'La Guaira', macuto: 'La Guaira',
  caraballeda: 'La Guaira', 'catia la mar': 'La Guaira', tanaguarena: 'La Guaira', naiguata: 'La Guaira',
  'naiguatá': 'La Guaira', 'la sabana': 'La Guaira', caruao: 'La Guaira',
  // Miranda
  guatire: 'Miranda', guarenas: 'Miranda', 'los teques': 'Miranda', 'san antonio': 'Miranda',
  petare: 'Miranda', baruta: 'Miranda', chacao: 'Miranda', 'el hatillo': 'Miranda', hatillo: 'Miranda',
  charallave: 'Miranda', 'santa teresa': 'Miranda', ocumare: 'Miranda',
  // Aragua
  maracay: 'Aragua', turmero: 'Aragua', 'la victoria': 'Aragua', cagua: 'Aragua', 'el limon': 'Aragua',
  // Carabobo
  valencia: 'Carabobo', naguanagua: 'Carabobo', 'san diego': 'Carabobo', guacara: 'Carabobo',
  'puerto cabello': 'Carabobo',
  // Yaracuy
  'san felipe': 'Yaracuy', yaritagua: 'Yaracuy',
};
export function tvState(city: string): string {
  const c = (city || '').trim().toLowerCase();
  if (CITY_STATE[c]) return CITY_STATE[c];
  // fuzzy: match on the longest known key contained in the city string
  for (const [k, v] of Object.entries(CITY_STATE)) if (c.includes(k)) return v;
  return 'La Guaira'; // event epicentre default (700 USD/m²)
}

// Normalized, cost-scored view of a reported building for the API/UI. Distinct
// from `Scored` (curated/OSM engine) — this carries the photo gallery + provenance.
export interface TvBuilding {
  id: string; name: string; addr: string; city: string; zone: string; state: string;
  lat: number | null; lon: number | null;
  damageLevel: string; status: string; band: string; verified: boolean;
  hasMissing: boolean; notes: string; source: string;
  photo: string | null; media: string[]; mediaCount: number;
  cost?: Cost; updatedAt: string | null;
}

const STATUS_SCORE: Record<string, number> = {
  COLAPSO_TOTAL: 98, COLAPSO_PARCIAL: 85, CONDENADO: 80, DANADO: 62,
};

// Photos only (drop videos) for the gallery; the app renders <img>.
function galleryUrls(row: TvRow): string[] {
  const all = Array.isArray(row.media_urls) ? row.media_urls : [];
  const imgs = all.filter((u) => typeof u === 'string' && !/\.(mp4|mov|webm|avi)(\?|$)/i.test(u));
  if (row.main_photo_url && !imgs.includes(row.main_photo_url)) imgs.unshift(row.main_photo_url);
  return imgs;
}

// Map a stored DB row (media_urls is a JSON string in D1) into the API/UI shape,
// computing HAZUS replacement + repair cost. `row` may be a raw TvRow (media_urls
// = array) or a D1 row (media_urls = JSON string) — both handled.
export function mapTvBuilding(row: any): TvBuilding {
  const media: string[] = Array.isArray(row.media_urls)
    ? galleryUrls(row)
    : galleryUrls({ ...row, media_urls: safeArr(row.media_urls) });
  const state = tvState(row.city || '');
  const status = tvStatus(row.damage_level || '');
  const score = STATUS_SCORE[status] ?? 62;
  const bandName = band(score);
  // Area/levels unknown for citizen reports → computeCost uses its EST defaults
  // (350 m² × 3 levels) → costConf = LOW. Honest: not a survey.
  const cost = computeCost('RESIDENCIAL', state, status, bandName, undefined);
  return {
    id: row.id,
    name: row.name || 'Edificio sin nombre',
    addr: row.address || [row.zone, row.city].filter(Boolean).join(', '),
    city: row.city || '', zone: row.zone || '', state,
    lat: row.lat ?? null, lon: row.lng ?? null,
    damageLevel: row.damage_level || '', status, band: bandName,
    verified: row.status === 'verificado',
    hasMissing: !!row.has_missing_persons,
    notes: row.notes || '', source: row.general_source || 'terremotovenezuela.com',
    photo: row.main_photo_url || (media[0] ?? null),
    media, mediaCount: media.length,
    cost, updatedAt: row.tv_updated_at || row.updated_at || row.last_updated_at || null,
  };
}

function safeArr(s: any): string[] {
  if (Array.isArray(s)) return s;
  if (typeof s !== 'string' || !s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}
