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
  // pooled/enrichment fields (from /danos sos_damage)
  triage?: string | null;        // rojo | naranja | amarillo | verde (Venezuela damage triage)
  peopleTrapped?: number;        // people_trapped from a structural-damage report
  sources?: string[];            // provenance when a building is confirmed by >1 feed
  sat?: SatMatch | null;         // satellite confirmation (Copernicus EMS / AI4G, ≤SAT_MATCH_M)
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

// ── /danos pooling (sos_damage) ───────────────────────────────────────────────
// The /danos map (table sos_damage, aggregated by sosvenezuela2026.com incl.
// terremotovenezuela) carries building-damage reports with a Venezuela triage
// color (rojo/naranja/amarillo/verde), verification, coords, and people_trapped.
// We pool the building categories into the reported-buildings inventory.
export interface SosDamageRow {
  id: string; category: string; severity: string | null; verification: string | null;
  title: string | null; description: string | null; lat: number | null; lng: number | null;
  municipio: string | null; parroquia: string | null; building_type: string | null;
  people_trapped: number | null; source_url: string | null; image_url: string | null;
  created_at: string | null;
}

// Building-damage categories we treat as buildings.
export const SOS_BUILDING_CATEGORIES = ['collapsed_building', 'damaged_building'];

// category + triage color → damage_level (total | severo | parcial).
export function sosDamageLevel(category: string, severity: string | null): string {
  if (category === 'collapsed_building') return 'total';
  const s = (severity || '').toLowerCase();
  if (s === 'rojo' || s === 'naranja') return 'severo';
  return 'parcial'; // amarillo | verde | unknown
}

export function mapSosDamageBuilding(row: SosDamageRow): TvBuilding {
  const damageLevel = sosDamageLevel(row.category, row.severity);
  const city = row.municipio || '';
  const state = tvState(city);
  const status = tvStatus(damageLevel);
  const score = STATUS_SCORE[status] ?? 62;
  const bandName = band(score);
  const cost = computeCost('RESIDENCIAL', state, status, bandName, undefined);
  const media = row.image_url ? [row.image_url] : [];
  return {
    id: row.id,
    name: row.title || 'Edificio sin nombre',
    addr: [row.parroquia, row.municipio].filter(Boolean).join(', '),
    city, zone: row.parroquia || '', state,
    lat: row.lat ?? null, lon: row.lng ?? null,
    damageLevel, status, band: bandName,
    verified: row.verification === 'official_verified' || row.verification === 'community_confirmed',
    hasMissing: (row.people_trapped ?? 0) > 0,
    notes: row.description || '', source: 'sosvenezuela2026.com',
    photo: row.image_url || null, media, mediaCount: media.length,
    cost, updatedAt: row.created_at ?? null,
    triage: row.severity ?? null, peopleTrapped: row.people_trapped ?? 0,
    sources: ['sosvenezuela2026.com'],
  };
}

// Merge terremotovenezuela buildings (rich galleries) with /danos sos_damage
// reports (triage + coords + people_trapped + 159 extra buildings). Dedupe by id:
// tv wins for galleries/name, but adopts sos coords when missing and carries the
// triage color + trapped count + a combined provenance list.
export function poolReportedBuildings(tv: TvBuilding[], sos: TvBuilding[]): TvBuilding[] {
  const byId = new Map<string, TvBuilding>();
  for (const b of tv) byId.set(b.id, { ...b, sources: [b.source] });
  for (const s of sos) {
    const existing = byId.get(s.id);
    if (existing) {
      // enrich the terremotovenezuela row with /danos signal
      existing.triage = s.triage ?? existing.triage ?? null;
      existing.peopleTrapped = Math.max(existing.peopleTrapped ?? 0, s.peopleTrapped ?? 0);
      if (existing.lat == null && s.lat != null) { existing.lat = s.lat; existing.lon = s.lon; }
      if (!existing.verified && s.verified) existing.verified = true;
      if (existing.mediaCount === 0 && s.photo) { existing.photo = existing.photo || s.photo; existing.media = s.media; existing.mediaCount = s.mediaCount; }
      if (!existing.sources) existing.sources = [existing.source];
      if (!existing.sources.includes('sosvenezuela2026.com')) existing.sources.push('sosvenezuela2026.com');
    } else {
      byId.set(s.id, s);
    }
  }
  return [...byId.values()];
}

// ── Satellite pooling (sat_edificaciones: Copernicus EMS + AI4G via CIVIS) ────
// The satellite evidence layer is cross-matched into the reported-buildings
// pool by proximity: a sat point within SAT_MATCH_M of a reported building
// CONFIRMS that building (b.sat set, verified upgraded); sat points with no
// nearby report join the pool as satellite-only buildings so their damage +
// HAZUS reconstruction cost count in the same inventory and each gets its own
// expediente card at /edificio/:id.
export const SAT_MATCH_M = 60;
export const SAT_SOURCE = 'Copernicus EMS + AI4G (satélite, vía CIVIS)';

export interface SatEdifRow {
  id: string; lat: number | null; lng: number | null; severidad: string | null;
  oficial: number | null; zona: string | null; uso: string | null;
  maps_url: string | null; updated_ms?: number | null;
}

export interface SatMatch {
  id: string; severidad: string; oficial: boolean; distM: number;
  zona: string; uso: string; mapsUrl: string | null; detectedAt: string | null;
}

// severidad (colapso | grave) → damage_level (total | severo | parcial).
export function satDamageLevel(severidad: string | null): string {
  const s = (severidad || '').toLowerCase();
  if (s === 'colapso') return 'total';
  if (s === 'grave') return 'severo';
  return 'parcial';
}

export function satMatchOf(row: SatEdifRow, distM: number): SatMatch {
  return {
    id: row.id, severidad: (row.severidad || '').toLowerCase(), oficial: !!row.oficial,
    distM: Math.round(distM), zona: row.zona || '', uso: row.uso || '',
    mapsUrl: row.maps_url || null,
    detectedAt: row.updated_ms ? new Date(row.updated_ms).toISOString() : null,
  };
}

// Satellite-only building → pooled inventory shape (same HAZUS cost defaults
// as citizen reports: area/floors unknown → costConf LOW; honest, not a survey).
export function mapSatEdificacion(row: SatEdifRow): TvBuilding {
  const damageLevel = satDamageLevel(row.severidad);
  const status = tvStatus(damageLevel);
  const score = STATUS_SCORE[status] ?? 62;
  const bandName = band(score);
  const zona = row.zona || '';
  const state = tvState(zona.split('/').pop() || zona);
  const uso = row.uso && row.uso !== 'Unclassified' ? row.uso : '';
  const cost = computeCost('RESIDENCIAL', state, status, bandName, undefined);
  return {
    id: row.id,
    name: ['Edificación satélite', zona].filter(Boolean).join(' — '),
    addr: [uso, zona].filter(Boolean).join(', ') || 'Ubicación por coordenadas satelitales',
    city: zona, zone: zona, state,
    lat: row.lat ?? null, lon: row.lng ?? null,
    damageLevel, status, band: bandName,
    verified: !!row.oficial,
    hasMissing: false, notes: '', source: SAT_SOURCE,
    photo: null, media: [], mediaCount: 0,
    cost, updatedAt: row.updated_ms ? new Date(row.updated_ms).toISOString() : null,
    sources: [SAT_SOURCE],
    sat: satMatchOf(row, 0),
  };
}

// Equirectangular ground distance in meters — fine at building scale.
export function groundDistM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000, rad = Math.PI / 180;
  const x = (lon2 - lon1) * rad * Math.cos(((lat1 + lat2) / 2) * rad);
  const y = (lat2 - lat1) * rad;
  return Math.sqrt(x * x + y * y) * R;
}

// Cross-match satellite points into the pooled inventory. Matched buildings are
// ENRICHED in place (nearest sat point wins, verified upgraded, provenance
// appended); unmatched sat points are APPENDED as satellite-only buildings.
// Conservation: result.length === pooled.length + unmatched sat count.
export function poolSatellite(pooled: TvBuilding[], sats: SatEdifRow[], maxM = SAT_MATCH_M): TvBuilding[] {
  const located = pooled.filter((b) => b.lat != null && b.lon != null);
  const extra: TvBuilding[] = [];
  for (const s of sats) {
    if (s.lat == null || s.lng == null) { continue; } // unlocatable sat rows are dropped, not fabricated
    let best: TvBuilding | null = null; let bestD = Infinity;
    for (const b of located) {
      // cheap prefilter: ~0.001° ≈ 110 m
      if (Math.abs((b.lat as number) - s.lat) > 0.0015 || Math.abs((b.lon as number) - s.lng) > 0.0015) continue;
      const dM = groundDistM(b.lat as number, b.lon as number, s.lat, s.lng);
      if (dM < bestD) { bestD = dM; best = b; }
    }
    if (best && bestD <= maxM) {
      if (!best.sat || bestD < best.sat.distM) best.sat = satMatchOf(s, bestD);
      if (!best.verified && s.oficial) best.verified = true;
      if (!best.sources) best.sources = [best.source];
      if (!best.sources.includes(SAT_SOURCE)) best.sources.push(SAT_SOURCE);
    } else {
      extra.push(mapSatEdificacion(s));
    }
  }
  return [...pooled, ...extra];
}

function safeArr(s: any): string[] {
  if (Array.isArray(s)) return s;
  if (typeof s !== 'string' || !s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}
