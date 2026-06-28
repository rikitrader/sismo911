import type { Env } from '../types';
import { recordIngest } from '../lib/db';
import { gatePersona } from './gate-config';
import { isSafePublicUrl, safeFetch } from '../lib/sanitize';

// Hourly re-ingest of the missing-persons (Familia) registry from the public
// API into the DESAP `personas` DB. Source URL is FAMILIA_SOURCE_URL; without
// it this is a no-op (logged) so the feature ships safely.
//
// DEDUPE BY CONSTRUCTION: personas.id IS the API's own stable id, and every
// write is an UPSERT (ON CONFLICT(id) DO UPDATE). Re-runs refresh existing rows
// rather than duplicating them. Bio fields are refreshed, but APP-OWNED status
// columns (estado / localizado_* / reportada*) are NEVER overwritten — families
// set them through the app and the upstream scrape doesn't know about them, so
// refreshing would revert real "found safe/deceased" reports. created_at /
// moderation / foto_r2 are also preserved. Content-level dedupe of any rows that
// slip in with different ids stays with the daily dedupePersonas cron.
//
// PAGINATION: the API caps pageSize at 100 (~490 pages). To stay within Worker
// subrequest limits we fetch a bounded window of pages per run, advancing a
// cursor in KV so successive hourly runs cycle the whole dataset (~every 20h),
// keeping localizado/sin-contacto statuses fresh. The full initial backfill is
// done out-of-band by scripts/pull-familia.mjs.

const PAGE_SIZE = 100;
const MAX_PAGES_PER_RUN = 25;          // ~2500 rows/run, ~25 subrequests
const CURSOR_KEY = 'familia:cursor';

const pick = (o: any, keys: string[]) => { for (const k of keys) { const v = o?.[k]; if (v != null && v !== '') return v; } return null; };
function toArray(j: any): any[] {
  if (Array.isArray(j)) return j;
  for (const k of ['items', 'results', 'data', 'personas', 'records', 'features']) if (Array.isArray(j?.[k])) return j[k];
  return [];
}
function mapEstado(v: any): string {
  const s = String(v ?? '').toLowerCase();
  if (/localiz|encontrad|safe|a salvo|vivo/.test(s)) return 'localizado';
  if (/fallec|muert|decease|dead/.test(s)) return 'fallecido';
  return 'sin-contacto';
}
const asInt = (v: any): number | null => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null; };

// Detect the upstream "now requires a CAPTCHA" wall (theempire started returning
// 403 {"error":"ForbiddenError","message":"Verificación reCAPTCHA requerida"}).
// Pure + exported so it's unit-tested without mocking fetch. Matches a 401/403
// whose body mentions captcha/forbidden — the marker that a plain server-side
// fetch can no longer pull this feed (a real-Chrome resolver is needed).
export const RECAPTCHA_DEGRADED = 'degraded:recaptcha';
export function isRecaptchaBlock(status: number, body: string): boolean {
  if (status !== 403 && status !== 401) return false;
  return /recaptcha|captcha|forbiddenerror|verificaci[oó]n requerida/i.test(String(body || ''));
}

export async function ingestFamilia(env: Env): Promise<number> {
  const base = (env as any).FAMILIA_SOURCE_URL as string | undefined;
  if (!base) { console.warn('[familia] FAMILIA_SOURCE_URL not set — skipping'); return 0; }
  const sep = base.includes('?') ? '&' : '?';
  try {
    let start = 1;
    try { start = Math.max(1, parseInt((await env.CACHE.get(CURSOR_KEY)) || '1', 10) || 1); } catch { /* default 1 */ }

    const fetchPage = async (page: number) => {
      const res = await fetch(`${base}${sep}page=${page}&pageSize=${PAGE_SIZE}`, { headers: { accept: 'application/json' } });
      if (!res.ok) {
        // Read a bounded slice of the body to classify the failure. A reCAPTCHA
        // wall is a known, structured degradation (not a transient blip): record
        // it as `degraded:recaptcha` so /api/status flags theempire as DOWN and
        // an operator knows the real-Chrome resolver is needed — RAV stays the
        // source of truth meanwhile. Fail fast (don't grind the page loop).
        const body = await res.text().catch(() => '');
        if (isRecaptchaBlock(res.status, body)) throw new Error(RECAPTCHA_DEGRADED);
        throw new Error(`HTTP ${res.status}`);
      }
      return res.json() as Promise<any>;
    };

    const first = await fetchPage(start);
    const totalPages = Math.max(1, asInt(first.totalPages) ?? 1);
    if (start > totalPages) start = 1; // dataset shrank — restart cursor

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const seen = new Map<string, any>();
    const addRows = (rows: any[]) => { for (const r of rows) { const o = r.properties ? { ...r.properties, ...r } : r; const id = pick(o, ['id', '_id', 'uuid', 'codigo']); if (id) seen.set(String(id), o); } };
    addRows(toArray(first));

    const lastPage = Math.min(totalPages, start + MAX_PAGES_PER_RUN - 1);
    for (let p = start + 1; p <= lastPage; p++) addRows(toArray(await fetchPage(p)));

    const stmts = [];
    let rejected = 0;
    for (const [rawId, o] of seen) {
      const nombre = pick(o, ['nombre', 'name', 'full_name', 'nombre_completo']);
      if (!nombre) continue;
      // Door check: drop junk / link-spam / stored-XSS / flood names before they
      // land (in-memory, no D1). The golden-rule UPSERT below is untouched.
      const ubic = String(pick(o, ['ubicacion', 'last_seen', 'location', 'lugar']) ?? '');
      const desc = String(pick(o, ['descripcion', 'notes', 'detalle', 'description', 'senas']) ?? '');
      if (!gatePersona({ nombre: String(nombre), ubicacion: ubic, descripcion: desc }).ok) { rejected++; continue; }
      const id = rawId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
      // SSRF/scheme guard: the upstream feed is unmoderated, so reject any foto
      // that isn't a public http(s) URL before it's stored (later server-side
      // fetched + rendered). Bad/empty values store as '' (no foto).
      const fotoRaw = String(pick(o, ['foto', 'photo', 'image', 'imagen', 'photo_url']) ?? '').slice(0, 500);
      const foto = isSafePublicUrl(fotoRaw) ? fotoRaw : '';
      stmts.push(env.DB.prepare(
        `INSERT INTO personas (id, nombre, edad, ubicacion, fecha, descripcion, contacto, foto, estado,
            localizado_por, localizado_contacto, localizado_relacion, localizado_nota,
            reportada, reportes, reportada_at, created_at, updated_at, pulled_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           nombre=excluded.nombre, edad=excluded.edad, ubicacion=excluded.ubicacion, fecha=excluded.fecha,
           descripcion=excluded.descripcion, contacto=excluded.contacto,
           foto=COALESCE(excluded.foto, personas.foto), reportes=excluded.reportes,
           updated_at=excluded.updated_at, pulled_at=excluded.pulled_at`
      ).bind(
        id, String(nombre).slice(0, 120), asInt(pick(o, ['edad', 'age'])),
        String(pick(o, ['ubicacion', 'last_seen', 'location', 'lugar']) ?? '').slice(0, 200),
        pick(o, ['fecha', 'date']),
        String(pick(o, ['descripcion', 'notes', 'detalle', 'description', 'senas']) ?? '').slice(0, 2000),
        String(pick(o, ['contacto', 'phone', 'telefono', 'celular']) ?? '').slice(0, 80),
        foto,
        mapEstado(pick(o, ['estado', 'status', 'situacion'])),
        pick(o, ['localizadoPor', 'localizado_por']), pick(o, ['localizadoContacto', 'localizado_contacto']),
        pick(o, ['localizadoRelacion', 'localizado_relacion']), pick(o, ['localizadoNota', 'localizado_nota']),
        pick(o, ['reportada']) ? 1 : 0, asInt(pick(o, ['reportes'])) ?? 0, asInt(pick(o, ['reportadaAt', 'reportada_at'])),
        asInt(pick(o, ['createdAt', 'created_at'])) ?? now, asInt(pick(o, ['updatedAt', 'updated_at'])) ?? now, nowIso,
      ));
    }

    let written = 0;
    for (let i = 0; i < stmts.length; i += 100) { await env.DB.batch(stmts.slice(i, i + 100)); written += Math.min(100, stmts.length - i); }

    const next = lastPage >= totalPages ? 1 : lastPage + 1;   // wrap to 1 after a full cycle
    await env.CACHE.put(CURSOR_KEY, String(next)).catch(() => {});
    await recordIngest(env, 'familia', true, written);
    console.log(`[familia] pages ${start}-${lastPage}/${totalPages}: upserted ${written}, rejected ${rejected}; next cursor=${next}`);
    return written;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg === RECAPTCHA_DEGRADED) {
      // Known degradation, not a crash: one clear line, no alarm spam. RAV remains
      // the live source; /api/status will report theempire as DOWN until a
      // real-Chrome resolver (CNE pattern) restores access.
      console.warn('[familia] source DEGRADED (reCAPTCHA wall) — theempire unreachable by server fetch; RAV remains source of truth. See /api/status.');
    } else {
      console.error('[familia] ingest failed:', msg);
    }
    await recordIngest(env, 'familia', false, 0, msg).catch(() => {});
    return 0;
  }
}

// Mirror external `foto` URLs into the DESAP_FOTOS R2 bucket and set foto_r2, so
// /api/familia/photo/:id serves a self-hosted copy instead of hot-linking the
// origin. Bounded per run to stay within Worker subrequest/CPU limits; successive
// hourly runs grind down the backlog. Ported from the decommissioned
// desaparecidos-vzla-api worker (its only unique job).
const MIRROR_BATCH = 50;
const MIRROR_CONCURRENCY = 6;

export async function mirrorFamiliaPhotos(env: Env, batchSize = MIRROR_BATCH): Promise<number> {
  if (!env.DESAP_FOTOS) { console.warn('[familia] DESAP_FOTOS R2 not bound — skip photo mirror'); return 0; }
  const { results } = await env.DB.prepare(
    `SELECT id, foto FROM personas WHERE foto <> '' AND foto_r2 IS NULL ORDER BY updated_at DESC LIMIT ?`
  ).bind(batchSize).all<{ id: string; foto: string }>();
  if (!results?.length) return 0;

  const done: [string, string][] = [];
  let i = 0, failed = 0;
  const worker = async () => {
    while (i < results.length) {
      const row = results[i++];
      try {
        // SSRF-safe: validates the URL + re-checks every redirect hop. A null
        // return means the URL/hop was unsafe → skip and count as failed.
        const res = await safeFetch(row.foto);
        if (!res || !res.ok || !res.body) { failed++; continue; }
        const key = `fotos/${row.id}.jpg`;
        await env.DESAP_FOTOS.put(key, res.body, {
          httpMetadata: { contentType: res.headers.get('content-type') || 'image/jpeg' },
        });
        done.push([key, row.id]);
      } catch { failed++; }
    }
  };
  await Promise.all(Array.from({ length: MIRROR_CONCURRENCY }, worker));
  if (done.length) {
    for (let j = 0; j < done.length; j += 100)
      await env.DB.batch(done.slice(j, j + 100).map(([key, id]) =>
        env.DB.prepare('UPDATE personas SET foto_r2 = ? WHERE id = ?').bind(key, id)));
  }
  console.log(`[familia] photo mirror: ${done.length} copied, ${failed} failed`);
  return done.length;
}
