import type { Env } from '../types';
import { uid } from '../lib/db';
import { normName, splitNameVariants, dedupeKey, type HospEstado } from '../lib/hospital-registry';
import { titleCaseName } from '../lib/names';
import { collapseHospitalDupes } from '../lib/hospital-ingest';
import { logAgentActivity } from '../lib/agent-activity';

// ── CIVIS "atendidos" ingest ────────────────────────────────────────────────
// Pull people attended in hospitals/refugios that CIVIS Venezuela publishes at
// civisvenezuela.com/atendidos and mirror them into hospital_patients as full,
// name-deduped profiles that the reunification search + the case cross-match
// crons already consume.
//
// PUBLIC API SHAPE (reverse-engineered, no key required):
//   GET /api/atendidos/centros           → { centros: [{centro,total,tipo}] }
//   GET /api/atendidos?tipo=hospital     → { atendidos: [...] }  (40 most-recent, all hospitals)
//   GET /api/atendidos?centro=<name>     → { atendidos: [...] }  (up to 300 most-recent for that centro)
//   GET /api/atendidos?q=<term>          → { atendidos: [...] }  (up to 60 matches)
// The endpoint IGNORES limit/offset/page — every query is hard-capped. Record
// shape: { codigo:"ATN-…", nombre, identificacion, edad_aprox, sexo, estado,
//          condicion, foto_url, centro, creado_en }. `codigo` is stable/unique.
//
// COVERAGE STRATEGY (defeats the per-query cap without brute force): the 300-cap
// only limits a SINGLE snapshot. Because we persist by a stable key and records
// are returned newest-first, hourly polling accumulates a monotonically-growing
// registry — every new intake surfaces at the top and is captured before it
// falls out of the window. To sweep the deep tail of the big hospitals we ROTATE
// through the centro list a few per tick via a KV cursor, so all 40 hospitals are
// re-pulled roughly once a day while every tick stays well under the Free-plan
// 50-subrequest budget.

export interface CivisRecord {
  codigo: string; nombre: string | null; identificacion: string | null;
  edad_aprox: number | string | null; sexo: string | null; estado: string | null;
  condicion: string | null; foto_url: string | null; centro: string | null; creado_en: string | null;
}
interface Centro { centro: string; total: number; tipo: string; }

const clip = (v: unknown, n: number) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, n);
const KV_CURSOR = 'civis:centro_cursor';
const CENTROS_PER_TICK = 3;   // 3 fetches × ≤300 rows → ~24 subrequests worst-case; +tipo+centros ≈ under 50.

/** Map CIVIS estado → our HospEstado (fallecido > alta > hospitalizado > desconocido). */
export function mapCivisEstado(estado: string | null | undefined): HospEstado {
  const e = String(estado || '').toLowerCase();
  if (/fallec/.test(e)) return 'fallecido';
  if (/alta/.test(e)) return 'alta';                       // de_alta
  if (/atencion|atenci|internad|hospitaliz|ingres/.test(e)) return 'hospitalizado'; // en_atencion
  return 'desconocido';
}

/** One CIVIS record → a storable hospital_patients row (null if it has no usable name). */
export function civisToRow(rec: CivisRecord) {
  // Display in Title Case (source arrives mixed / ALL-CAPS); matching key stays
  // lowercased via normName (project HARD RULE: title-case display, never the key).
  const variants = splitNameVariants(rec.nombre).map(titleCaseName);
  const full = variants[0] || titleCaseName(clip(rec.nombre, 200));
  if (!full) return null;                                  // unnamed → not a person we can list
  const primaryNorm = normName(full);
  const estado = mapCivisEstado(rec.estado);
  const ident = String(rec.identificacion || '').toLowerCase().includes('no') ? 'No identificada' : 'Identificada';
  const obs = clip(
    `${rec.condicion || estado} · ${ident} · Fuente CIVIS ${rec.codigo}` +
    (rec.creado_en ? ` · ingreso ${String(rec.creado_en).slice(0, 16).replace('T', ' ')}` : ''),
    2000,
  );
  return {
    id: uid('hp'),
    dedupe_key: dedupeKey('', rec.centro, primaryNorm),    // CIVIS carries no cédula → name key
    hospital: clip(rec.centro, 160),
    full_name: clip(full, 200),
    name_variants: JSON.stringify(variants.slice(0, 6)),
    norm_name: primaryNorm,
    edad: clip(rec.edad_aprox, 24),
    sexo: clip(rec.sexo, 8),
    estado,
    observaciones: obs,
    foto_url: clip(rec.foto_url, 500),
    source_ref: clip(rec.codigo, 40),
  };
}

/** Self-heal: tolerate a DB where migration 0090 has not yet applied. */
async function ensureColumns(env: Env): Promise<void> {
  for (const col of ['source_ref TEXT', 'foto_url TEXT', 'sexo TEXT']) {
    try { await env.DB.prepare(`ALTER TABLE hospital_patients ADD COLUMN ${col}`).run(); }
    catch { /* duplicate column — already there */ }
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'user-agent': 'sismo911-civis-sync', accept: 'application/json' }, cf: { cacheTtl: 0 } as any });
  if (!res.ok) throw new Error(`fetch_${res.status}`);
  return res.json<T>();
}

/** Idempotent upsert of a batch of CIVIS records. Name-collision → ONE row (dedupe_key). */
async function upsertCivis(env: Env, recs: CivisRecord[]): Promise<number> {
  const now = Date.now();
  const stmts: any[] = [];
  const seen = new Set<string>();
  for (const rec of recs) {
    const r = civisToRow(rec);
    if (!r || !r.dedupe_key || seen.has(r.dedupe_key)) continue; // de-dupe within the batch too
    seen.add(r.dedupe_key);
    stmts.push(env.DB.prepare(
      `INSERT INTO hospital_patients
         (id,dedupe_key,hospital,full_name,name_variants,norm_name,edad,sexo,cedula,telefono,direccion,
          estado,conflict,observaciones,foto_url,source,source_ref,source_updated,match_confidence,created_ms,updated_ms)
       VALUES (?,?,?,?,?,?,?,?,'','','',?,0,?,?, 'civis', ?, ?, 'none', ?, ?)
       ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO UPDATE SET
         hospital=excluded.hospital, full_name=excluded.full_name, name_variants=excluded.name_variants,
         norm_name=excluded.norm_name, edad=CASE WHEN excluded.edad<>'' THEN excluded.edad ELSE hospital_patients.edad END,
         sexo=CASE WHEN excluded.sexo<>'' THEN excluded.sexo ELSE hospital_patients.sexo END,
         -- Status is STICKY UPWARD: fallecido > alta > hospitalizado > desconocido,
         -- so a later 'desconocido' re-pull never clobbers a known outcome.
         estado=CASE
           WHEN excluded.estado='fallecido'     OR hospital_patients.estado='fallecido'     THEN 'fallecido'
           WHEN excluded.estado='alta'          OR hospital_patients.estado='alta'          THEN 'alta'
           WHEN excluded.estado='hospitalizado' OR hospital_patients.estado='hospitalizado' THEN 'hospitalizado'
           ELSE excluded.estado END,
         observaciones=excluded.observaciones,
         foto_url=CASE WHEN excluded.foto_url<>'' THEN excluded.foto_url ELSE hospital_patients.foto_url END,
         source_ref=excluded.source_ref, source=excluded.source,
         source_updated=excluded.source_updated, updated_ms=excluded.updated_ms`
    ).bind(r.id, r.dedupe_key, r.hospital, r.full_name, r.name_variants, r.norm_name, r.edad, r.sexo,
           r.estado, r.observaciones, r.foto_url, r.source_ref, String(now), now, now));
  }
  let written = 0;
  for (let i = 0; i < stmts.length; i += 50) { await env.DB.batch(stmts.slice(i, i + 50)); written += Math.min(50, stmts.length - i); }
  return written;
}

/**
 * One hourly tick: pull the newest hospital feed + a rotating slice of centros,
 * upsert (name-deduped), then collapse cross-source name duplicates (reversible).
 * Bounded to stay under the Free-plan 50-subrequest cap. No silent failure.
 */
export async function ingestCivisAtendidos(env: Env): Promise<{ ok: boolean; written?: number; centros?: number; collapsed?: number; reason?: string }> {
  const base = (env.CIVIS_API_BASE || 'https://civisvenezuela.com').replace(/\/+$/, '');
  try {
    await ensureColumns(env);

    // 1. Newest 40 across all hospitals — cheap, always catches fresh intakes first.
    let written = 0;
    try {
      const recent = await fetchJson<{ atendidos: CivisRecord[] }>(`${base}/api/atendidos?tipo=hospital`);
      written += await upsertCivis(env, recent.atendidos ?? []);
    } catch (e: any) { console.warn('[civis] recent pull failed', String(e?.message || e)); }

    // 2. Rotate through the centro list, CENTROS_PER_TICK per tick (KV cursor).
    const { centros } = await fetchJson<{ centros: Centro[] }>(`${base}/api/atendidos/centros`);
    const list = (centros ?? []).map((c) => c.centro).filter(Boolean).sort(); // stable order for the cursor
    let touched = 0;
    if (list.length) {
      const cur = Math.max(0, parseInt((await env.CACHE.get(KV_CURSOR)) || '0', 10) || 0) % list.length;
      for (let k = 0; k < CENTROS_PER_TICK && k < list.length; k++) {
        const name = list[(cur + k) % list.length];
        try {
          const data = await fetchJson<{ atendidos: CivisRecord[] }>(`${base}/api/atendidos?centro=${encodeURIComponent(name)}`);
          written += await upsertCivis(env, data.atendidos ?? []);
          touched++;
        } catch (e: any) { console.warn('[civis] centro pull failed', name, String(e?.message || e)); }
      }
      await env.CACHE.put(KV_CURSOR, String((cur + CENTROS_PER_TICK) % list.length));
    }

    // 3. Collapse name-collision duplicates created by the upsert (reversible archive).
    const col = await collapseHospitalDupes(env);

    await logAgentActivity(env, {
      source: 'civis-atendidos', action: 'ingest', fetched: written, created: written,
      summary: `🏥 CIVIS atendidos sincronizado — ${written} perfil(es) actualizado(s) desde ${touched} centro(s)` +
               `${col.collapsed ? `, ${col.collapsed} duplicado(s) por nombre fusionado(s)` : ''}.`,
      ok: true,
    });
    return { ok: true, written, centros: touched, collapsed: col.collapsed };
  } catch (e: any) {
    const reason = String(e?.message || e).slice(0, 120);
    await logAgentActivity(env, { source: 'civis-atendidos', action: 'ingest', ok: false,
      summary: `⚠ Fallo al sincronizar CIVIS atendidos: ${reason}.` }).catch(() => {});
    console.error('[civis-atendidos]', reason);
    return { ok: false, reason };
  }
}
