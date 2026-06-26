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
