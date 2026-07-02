import type { Env } from '../types';

// redayudavenezuela.com (RAV) — public Supabase REST (PostgREST) data layer.
//
// Reverse-engineered from the site's Next.js bundle. The anon key is public
// (shipped in their browser JS); both URL + key have safe in-code fallbacks so
// the feature works even before the Worker vars are set. PostgREST caps a
// response at 1000 rows, so list reads paginate with the `Range` header and ask
// for the exact total via `Prefer: count=exact` (returned in `Content-Range`).

const DEFAULT_URL = 'https://cpavwkdonvkvrwygfzfo.supabase.co';
const DEFAULT_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNwYXZ3a2RvbnZrdnJ3eWdmemZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIzNjAyODMsImV4cCI6MjA5NzkzNjI4M30.-_FAsA2csTrB9qt267pBfjJkczMP7pcaUi4plMv3kv4';

export const RAV_PAGE = 1000;

function cfg(env: Env) {
  const url = ((env as any).RAV_SUPABASE_URL || DEFAULT_URL).replace(/\/+$/, '');
  const key = (env as any).RAV_SUPABASE_KEY || DEFAULT_ANON;
  return { url, key };
}

export interface RavPage<T> { rows: T[]; total: number; }

// Fetch one page [offset, offset+limit) from a RAV table. Returns the rows plus
// the exact table total parsed from the Content-Range header (e.g. "0-999/53341").
export async function ravFetch<T = any>(
  env: Env,
  table: string,
  opts: { select?: string; offset?: number; limit?: number; order?: string } = {},
): Promise<RavPage<T>> {
  const { url, key } = cfg(env);
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, Math.min(opts.limit ?? RAV_PAGE, RAV_PAGE));
  const qs = new URLSearchParams({ select: opts.select ?? '*' });
  if (opts.order) qs.set('order', opts.order);
  const res = await fetch(`${url}/rest/v1/${table}?${qs}`, {
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      accept: 'application/json',
      Range: `${offset}-${offset + limit - 1}`,
      Prefer: 'count=exact',
    },
  });
  if (!res.ok && res.status !== 206) throw new Error(`RAV ${table} HTTP ${res.status}`);
  const rows = (await res.json()) as T[];
  const cr = res.headers.get('content-range') || '';
  const total = Number(cr.split('/')[1]) || rows.length + offset;
  return { rows: Array.isArray(rows) ? rows : [], total };
}

// --- /api/data proxy (2026-07 lockdown) ---
// RAV revoked anon SELECT on missing_persons / reports / safe_reports
// (PostgREST 42501 → HTTP 401 since ~2026-06-28). Their frontend now reads
// through the site's own Next.js proxy: POST https://redayudavenezuela.com/api/data
// {op, ...params} → {ok, data}. verified_info + official_stats KEEP anon SELECT,
// so ravFetch still serves those two. missing_search pages are a fixed 40 rows
// (server-side pageSize, not overridable); totals come from op missing_count.

const DEFAULT_DATA_URL = 'https://redayudavenezuela.com/api/data';
export const RAV_MS_PAGE = 40;

export async function ravData<T = any>(env: Env, op: string, params: Record<string, unknown> = {}): Promise<T> {
  const url = ((env as any).RAV_DATA_URL || DEFAULT_DATA_URL) as string;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ op, ...params }),
  });
  if (!res.ok) throw new Error(`RAV data ${op} HTTP ${res.status}`);
  const j = (await res.json()) as { ok?: boolean; data?: T; error?: string };
  if (!j?.ok) throw new Error(`RAV data ${op} failed: ${j?.error || 'unknown'}`);
  return j.data as T;
}

// Cursor for the proxy-paged missing_persons sweep: "<status>:<page>". The sweep
// walks all `active` pages, then all `found` pages, then wraps back to active —
// so located-people status updates keep flowing even though the two lists are
// separate server-side queries. A legacy value (the old numeric PostgREST row
// offset) parses as a fresh `active:0`.
export type RavMissingStatus = 'active' | 'found';
export interface RavMissingCursor { status: RavMissingStatus; page: number; }

export function parseRavCursor(v: string | null | undefined): RavMissingCursor {
  const m = /^(active|found):(\d+)$/.exec(String(v ?? '').trim());
  if (!m) return { status: 'active', page: 0 };
  return { status: m[1] as RavMissingStatus, page: Math.max(0, parseInt(m[2], 10) || 0) };
}

// Advance after a run that stopped at `nextPage`. `exhausted` (an empty/short
// page was hit) flips to the other status list at page 0; a full active→found
// cycle therefore alternates statuses forever. Returns the cursor string to store.
export function advanceRavCursor(cur: RavMissingCursor, nextPage: number, exhausted: boolean): string {
  if (exhausted) return cur.status === 'active' ? 'found:0' : 'active:0';
  return `${cur.status}:${Math.max(0, nextPage)}`;
}

// RAV status → personas estado. RAV uses literal 'active' | 'found'; map found →
// localizado (safe/located) and everything else → sin-contacto (still missing).
export function mapRavEstado(status: any): string {
  return /found|localiz|safe|vivo|a salvo/i.test(String(status ?? '')) ? 'localizado' : 'sin-contacto';
}

const asInt = (v: any): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};
const toIso = (v: any): string | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(n) ? new Date(n).toISOString() : (typeof v === 'string' ? v : null);
};

export interface RavPersonRow {
  id: string; ext_id?: string; name?: string; age?: number | null;
  description?: string; last_seen?: string; contact?: string;
  photo_url?: string | null; status?: string; source?: string;
  ext_created?: number | null; synced_at?: string | null;
}

export interface PersonaUpsert {
  id: string; nombre: string; edad: number | null; ubicacion: string; fecha: string | null;
  descripcion: string; contacto: string; foto: string; estado: string;
  origen: string; ext_id: string; tags: string; synced_at: string | null;
  created_at: number; updated_at: number; pulled_at: string;
}

// Map a RAV missing_persons row → personas UPSERT shape. id is namespaced
// `rav_<uuid>` so it never collides with theempire (`pa…`) / familia ids, making
// re-pull dedupe impossible by construction. Tags capture provenance + quick
// facets (photo / age / status) for filtering and enrichment.
export function mapRavPersona(r: RavPersonRow, runIso: string): PersonaUpsert | null {
  const nombre = String(r.name ?? '').trim();
  if (!r.id) return null;
  const srcRaw = String(r.source ?? 'rav').trim().toLowerCase();
  const origen = `rav:${srcRaw || 'rav'}`;
  const foto = String(r.photo_url ?? '').trim();
  const created = asInt(r.ext_created) ?? Date.parse(runIso);
  const synced = toIso(r.synced_at);
  const tags = [
    'rav',
    `src:${srcRaw || 'rav'}`,
    foto ? 'has-photo' : 'no-photo',
    r.age != null ? 'has-age' : 'no-age',
    `status:${String(r.status ?? 'active').toLowerCase()}`,
  ];
  return {
    id: `rav_${String(r.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 72)}`,
    nombre: nombre.slice(0, 120),
    edad: asInt(r.age),
    ubicacion: String(r.last_seen ?? '').slice(0, 200),
    fecha: synced ? synced.slice(0, 10) : (created ? new Date(created).toISOString().slice(0, 10) : null),
    descripcion: String(r.description ?? '').slice(0, 2000),
    contacto: String(r.contact ?? '').slice(0, 80),
    foto: foto.slice(0, 500),
    estado: mapRavEstado(r.status),
    origen,
    ext_id: String(r.ext_id ?? r.id).slice(0, 80),
    tags: JSON.stringify(tags),
    synced_at: synced,
    created_at: created,
    updated_at: Date.parse(synced ?? runIso) || Date.parse(runIso),
    pulled_at: runIso,
  };
}

export interface RavVerifiedRow {
  id: string; source?: string; title?: string; body?: string;
  url?: string; topic?: string; published_at?: string | null;
}
export function mapRavVerified(r: RavVerifiedRow, runIso: string) {
  const topic = String(r.topic ?? '').trim().toLowerCase();
  return {
    id: String(r.id),
    source: String(r.source ?? '').slice(0, 120),
    title: String(r.title ?? '').slice(0, 300),
    body: String(r.body ?? '').slice(0, 4000),
    url: String(r.url ?? '').slice(0, 600) || null,
    topic: topic || 'general',
    tags: JSON.stringify(['rav', topic ? `topic:${topic}` : 'topic:general']),
    published_at: toIso(r.published_at),
    synced_at: runIso,
    pulled_at: runIso,
  };
}

export interface RavStatsRow {
  fallecidos?: number | null; heridos?: number | null;
  refugiados?: number | null; desaparecidos?: number | null;
  source?: string; updated_at?: string | null;
}
export function mapRavStats(r: RavStatsRow, runIso: string) {
  return {
    fallecidos: asInt(r.fallecidos),
    heridos: asInt(r.heridos),
    refugiados: asInt(r.refugiados),
    desaparecidos: asInt(r.desaparecidos),
    source: String(r.source ?? '').slice(0, 200),
    updated_at: toIso(r.updated_at),
    pulled_at: runIso,
  };
}

// --- reports (multi-kind citizen reports: pets/volunteers/trapped/aid/damage) ---
export interface RavReportRow {
  id: string; kind?: string; category?: string; title?: string; description?: string;
  city?: string; state?: string; area?: string; lat?: number | null; lng?: number | null;
  contact?: string; status?: string; photo_url?: string | null; meta?: any;
  source?: string | null; ext_id?: string | null; created_at?: string | null;
}
export function mapRavReport(r: RavReportRow, runIso: string) {
  const kind = String(r.kind ?? '').trim().toLowerCase();
  const cat = String(r.category ?? '').trim().toLowerCase();
  const photo = String(r.photo_url ?? '').trim();
  const tags = ['rav', kind ? `kind:${kind}` : 'kind:otro', cat ? `cat:${cat}` : null,
    photo ? 'has-photo' : 'no-photo', `status:${String(r.status ?? 'activo').toLowerCase()}`].filter(Boolean);
  const num = (v: any) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
  return {
    id: String(r.id), kind: kind || 'otro', category: cat || null,
    title: String(r.title ?? '').slice(0, 300), description: String(r.description ?? '').slice(0, 3000),
    city: String(r.city ?? '').slice(0, 120) || null, state: String(r.state ?? '').slice(0, 120) || null,
    area: String(r.area ?? '').slice(0, 120) || null, lat: num(r.lat), lng: num(r.lng),
    contact: String(r.contact ?? '').slice(0, 120) || null, status: String(r.status ?? '').slice(0, 40) || null,
    photo_url: photo.slice(0, 600) || null, meta: JSON.stringify(r.meta ?? {}).slice(0, 2000),
    tags: JSON.stringify(tags), ext_id: r.ext_id ? String(r.ext_id).slice(0, 80) : null,
    created_at: toIso(r.created_at), synced_at: runIso, pulled_at: runIso,
  };
}

// --- safe_reports ("estoy a salvo" citizen check-ins) ---
export interface RavSafeRow {
  id: string; slug?: string; name?: string; city?: string; state?: string;
  area?: string; status?: string; note?: string | null; photo_url?: string | null; created_at?: string | null;
}
export function mapRavSafe(r: RavSafeRow, runIso: string) {
  const photo = String(r.photo_url ?? '').trim();
  return {
    id: String(r.id), slug: String(r.slug ?? '').slice(0, 40) || null,
    name: String(r.name ?? '').slice(0, 160), city: String(r.city ?? '').slice(0, 120) || null,
    state: String(r.state ?? '').slice(0, 120) || null, area: String(r.area ?? '').slice(0, 120) || null,
    status: String(r.status ?? '').slice(0, 40) || null, note: r.note ? String(r.note).slice(0, 600) : null,
    photo_url: photo.slice(0, 600) || null,
    tags: JSON.stringify(['rav', `status:${String(r.status ?? 'bien').toLowerCase()}`, photo ? 'has-photo' : 'no-photo']),
    created_at: toIso(r.created_at), synced_at: runIso, pulled_at: runIso,
  };
}
