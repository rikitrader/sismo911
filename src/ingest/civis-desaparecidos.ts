import type { Env } from '../types';
import { recordIngest } from '../lib/db';
import { mapRavEstado, type PersonaUpsert } from '../lib/rav';
import { gatePersona } from './gate-config';
import { syncDesaparecidosSheet } from '../lib/sheets-sync';
import { logAgentActivity, missingStats, missingPhrase } from '../lib/agent-activity';

// ── CIVIS "desaparecidos" ingest ────────────────────────────────────────────
// Pull the missing-persons registry CIVIS Venezuela publishes at
// civisvenezuela.com/api/desaparecidos into our `personas` registry — the SAME
// store + pipeline the RAV / Familia sources use. Photos, names, ages, locations
// and status all flow in; the existing source-agnostic photo mirror
// (mirrorFamiliaPhotos, :30) copies foto→R2 and the phash/dhash/face + exact/
// extid dedupe crons then collapse cross-source duplicates. No new table.
//
// PUBLIC API (reverse-engineered, no key):
//   GET /api/desaparecidos?limit=<=100&offset=<n>  → { personas: [...] }
//   Record: { id(uuid), codigo:"DESAP-…", nombre (sometimes privacy-redacted with
//             "…"), edadAprox?, ubicacion:{lat,lng,referencia?}, fotoUrl? (public
//             Supabase storage URL), fuente, estado(buscando|localizada|…), creadoEn }.
// Unlike /api/atendidos this endpoint PAGINATES: limit caps at 100 and `offset`
// works, so the whole set is reachable via a KV offset cursor over cron ticks.
//
// DEDUPE BY CONSTRUCTION: personas.id is `civis_<uuid>` and every write is an
// UPSERT, so re-runs refresh rather than duplicate. App-owned columns (estado /
// localizado_* / reportada* / foto_r2 / moderation) are set on INSERT only and
// never clobbered on update — same golden rule as rav-cron / familia-cron.
// Cross-source dups (same person also in RAV / Familia) are collapsed by the
// existing dedupePersonas modes (exact / photo / extid / phash / dhash).
// SPAM/junk is dropped at the door by gatePersona before it can land.

interface CivisDesap {
  id: string; codigo?: string; nombre?: string; edadAprox?: number | null;
  ubicacion?: { lat?: number; lng?: number; referencia?: string } | null;
  fotoUrl?: string | null; fuente?: string | null; estado?: string | null; creadoEn?: string | null;
}

const CURSOR_KEY = 'civis:desap_cursor';
const PAGE = 100;                  // API hard-caps limit at 100
const MAX_PAGES_PER_RUN = 5;       // ~500 rows / 5 subrequests per cron tick

/** One CIVIS desaparecido → personas UPSERT shape (null if unusable). */
export function mapCivisDesap(r: CivisDesap, runIso: string): PersonaUpsert | null {
  if (!r.id) return null;
  const nombre = String(r.nombre ?? '').replace(/…+$/, '').trim();   // drop the privacy-redaction ellipsis
  const foto = String(r.fotoUrl ?? '').trim();
  const loc = r.ubicacion || {};
  const ubic = String(loc.referencia || '').trim() ||
    (loc.lat && loc.lng ? `${loc.lat}, ${loc.lng}` : '');
  const fuente = String(r.fuente ?? 'civis').trim().toLowerCase();
  const created = r.creadoEn ? (Date.parse(r.creadoEn) || Date.parse(runIso)) : Date.parse(runIso);
  const tags = [
    'civis', `src:${fuente || 'civis'}`,
    foto ? 'has-photo' : 'no-photo',
    r.edadAprox != null ? 'has-age' : 'no-age',
    `status:${String(r.estado ?? 'buscando').toLowerCase()}`,
    r.codigo ? `codigo:${r.codigo}` : '',
  ].filter(Boolean);
  const desc = [
    r.codigo ? `Reporte CIVIS ${r.codigo}` : 'Reporte CIVIS',
    r.fuente ? `fuente: ${r.fuente}` : '',
    r.estado ? `estado origen: ${r.estado}` : '',
  ].filter(Boolean).join(' · ');
  return {
    id: `civis_${String(r.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 72)}`,
    nombre: nombre.slice(0, 120),
    edad: r.edadAprox != null && Number.isFinite(Number(r.edadAprox)) ? Math.trunc(Number(r.edadAprox)) : null,
    ubicacion: ubic.slice(0, 200),
    fecha: created ? new Date(created).toISOString().slice(0, 10) : null,
    descripcion: desc.slice(0, 2000),
    contacto: '',
    foto: foto.slice(0, 500),
    estado: mapRavEstado(r.estado),          // localiz* → 'localizado', else 'sin-contacto'
    origen: `civis:${fuente || 'civis'}`,
    ext_id: String(r.id).slice(0, 80),
    tags: JSON.stringify(tags),
    synced_at: r.creadoEn ?? null,
    created_at: created,
    updated_at: Date.parse(runIso),
    pulled_at: runIso,
  };
}

/** UPSERT keyed on id — app-owned status/photo-mirror columns preserved on update. */
function upsertStmt(env: Env, p: PersonaUpsert) {
  return env.DB.prepare(
    `INSERT INTO personas
       (id, nombre, edad, ubicacion, fecha, descripcion, contacto, foto, estado,
        origen, ext_id, tags, synced_at, created_at, updated_at, pulled_at, moderation)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'approved')
     ON CONFLICT(id) DO UPDATE SET
        nombre=excluded.nombre, edad=excluded.edad, ubicacion=excluded.ubicacion, fecha=excluded.fecha,
        descripcion=excluded.descripcion,
        foto=CASE WHEN excluded.foto <> '' THEN excluded.foto ELSE personas.foto END,
        origen=excluded.origen, ext_id=excluded.ext_id, tags=excluded.tags,
        synced_at=excluded.synced_at, updated_at=excluded.updated_at, pulled_at=excluded.pulled_at`,
  ).bind(
    p.id, p.nombre, p.edad, p.ubicacion, p.fecha, p.descripcion, p.contacto, p.foto, p.estado,
    p.origen, p.ext_id, p.tags, p.synced_at, p.created_at, p.updated_at, p.pulled_at,
  );
}

async function fetchPage(base: string, offset: number): Promise<CivisDesap[]> {
  const res = await fetch(`${base}/api/desaparecidos?limit=${PAGE}&offset=${offset}`, {
    headers: { 'user-agent': 'sismo911-civis-sync', accept: 'application/json' }, cf: { cacheTtl: 0 } as any,
  });
  if (!res.ok) throw new Error(`fetch_${res.status}`);
  const j = await res.json<{ personas?: CivisDesap[] }>();
  return j.personas ?? [];
}

export interface CivisDesapResult { ok: boolean; written?: number; rejected?: number; from?: number; to?: number; next?: number; mirrored?: number; reason?: string; }

/**
 * Ingest up to `pages` pages from the KV offset cursor. New people → new personas
 * rows; already-seen → updated in place. Wraps the cursor to 0 after a short page
 * that signals end-of-data so successive ticks cycle the whole registry.
 */
export async function ingestCivisDesaparecidos(env: Env, pages = MAX_PAGES_PER_RUN): Promise<CivisDesapResult> {
  const base = (env.CIVIS_API_BASE || 'https://civisvenezuela.com').replace(/\/+$/, '');
  try {
    let offset = 0;
    try { offset = Math.max(0, parseInt((await env.CACHE.get(CURSOR_KEY)) || '0', 10) || 0); } catch { /* default 0 */ }
    const runIso = new Date().toISOString();

    const collected: CivisDesap[] = [];
    let cur = offset, reachedEnd = false;
    const want = Math.max(1, Math.min(pages, 25));
    for (let i = 0; i < want; i++) {
      const rows = await fetchPage(base, cur);
      collected.push(...rows);
      cur += PAGE;
      if (rows.length < PAGE) { reachedEnd = true; break; }   // last page
    }
    // If we started past the end (dataset shrank), restart from 0 next time.
    if (offset > 0 && collected.length === 0) { await env.CACHE.put(CURSOR_KEY, '0').catch(() => {}); }

    const stmts = [];
    let rejected = 0;
    for (const r of collected) {
      const p = mapCivisDesap(r, runIso);
      if (!p || !p.nombre) continue;                          // unnamed/blank → skip
      if (!gatePersona(p).ok) { rejected++; continue; }       // spam / junk / XSS door
      stmts.push(upsertStmt(env, p));
    }
    let written = 0;
    for (let i = 0; i < stmts.length; i += 100) { await env.DB.batch(stmts.slice(i, i + 100)); written += Math.min(100, stmts.length - i); }

    const next = reachedEnd ? 0 : cur;                         // wrap after a full cycle
    await env.CACHE.put(CURSOR_KEY, String(next)).catch(() => {});
    await recordIngest(env, 'civis-desaparecidos', true, written);
    // Refresh the Google Sheet "Desaparecidos" tab (best-effort; no-op w/o creds).
    const mirrored = await syncDesaparecidosSheet(env).catch(() => 0);
    if (written > 0) {
      const m = await missingStats(env);
      await logAgentActivity(env, {
        source: 'civis-desaparecidos', action: 'ingest', fetched: collected.length, created: written, rejected,
        summary: `🔎 CIVIS desaparecidos sincronizado — ${written} persona(s) creada(s)/actualizada(s)` +
                 `${rejected ? `, ${rejected} descartada(s) por spam/basura` : ''}. ${missingPhrase(m)}.`,
        ok: true,
      } as any);
    }
    return { ok: true, written, rejected, from: offset, to: cur, next, mirrored } as CivisDesapResult;
  } catch (e: any) {
    const reason = String(e?.message || e).slice(0, 120);
    await recordIngest(env, 'civis-desaparecidos', false, 0, reason).catch(() => {});
    await logAgentActivity(env, { source: 'civis-desaparecidos', action: 'ingest', ok: false,
      summary: `⚠ Fallo al sincronizar CIVIS desaparecidos: ${reason}.` }).catch(() => {});
    console.error('[civis-desaparecidos]', reason);
    return { ok: false, reason };
  }
}
