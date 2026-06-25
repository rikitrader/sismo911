import type { Env } from '../types';
import { recordIngest } from '../lib/db';

// Hourly re-ingest of the missing-persons (Familia) registry from the public
// API into the DESAP `personas` DB. Source URL is FAMILIA_SOURCE_URL; without
// it this is a no-op (logged) so the feature ships safely.
//
// DEDUPE BY CONSTRUCTION: personas.id IS the API's own stable id, and every
// write is an UPSERT (ON CONFLICT(id) DO UPDATE). Re-runs refresh existing rows
// rather than duplicating them. created_at / moderation / foto_r2 are preserved
// on conflict (admin/first-seen owned). Content-level dedupe of any rows that
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

export async function ingestFamilia(env: Env): Promise<number> {
  const base = (env as any).FAMILIA_SOURCE_URL as string | undefined;
  if (!base) { console.warn('[familia] FAMILIA_SOURCE_URL not set — skipping'); return 0; }
  const sep = base.includes('?') ? '&' : '?';
  try {
    let start = 1;
    try { start = Math.max(1, parseInt((await env.CACHE.get(CURSOR_KEY)) || '1', 10) || 1); } catch { /* default 1 */ }

    const fetchPage = async (page: number) => {
      const res = await fetch(`${base}${sep}page=${page}&pageSize=${PAGE_SIZE}`, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
    for (const [rawId, o] of seen) {
      const nombre = pick(o, ['nombre', 'name', 'full_name', 'nombre_completo']);
      if (!nombre) continue;
      const id = rawId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
      stmts.push(env.DB.prepare(
        `INSERT INTO personas (id, nombre, edad, ubicacion, fecha, descripcion, contacto, foto, estado,
            localizado_por, localizado_contacto, localizado_relacion, localizado_nota,
            reportada, reportes, reportada_at, created_at, updated_at, pulled_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           nombre=excluded.nombre, edad=excluded.edad, ubicacion=excluded.ubicacion, fecha=excluded.fecha,
           descripcion=excluded.descripcion, contacto=excluded.contacto,
           foto=COALESCE(excluded.foto, personas.foto), estado=excluded.estado,
           localizado_por=excluded.localizado_por, localizado_contacto=excluded.localizado_contacto,
           localizado_relacion=excluded.localizado_relacion, localizado_nota=excluded.localizado_nota,
           reportada=excluded.reportada, reportes=excluded.reportes, reportada_at=excluded.reportada_at,
           updated_at=excluded.updated_at, pulled_at=excluded.pulled_at`
      ).bind(
        id, String(nombre).slice(0, 120), asInt(pick(o, ['edad', 'age'])),
        String(pick(o, ['ubicacion', 'last_seen', 'location', 'lugar']) ?? '').slice(0, 200),
        pick(o, ['fecha', 'date']),
        String(pick(o, ['descripcion', 'notes', 'detalle', 'description', 'senas']) ?? '').slice(0, 2000),
        String(pick(o, ['contacto', 'phone', 'telefono', 'celular']) ?? '').slice(0, 80),
        String(pick(o, ['foto', 'photo', 'image', 'imagen', 'photo_url']) ?? '').slice(0, 500),
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
    console.log(`[familia] pages ${start}-${lastPage}/${totalPages}: upserted ${written}; next cursor=${next}`);
    return written;
  } catch (e: any) {
    console.error('[familia] ingest failed:', e?.message ?? e);
    await recordIngest(env, 'familia', false, 0, String(e?.message ?? e)).catch(() => {});
    return 0;
  }
}
