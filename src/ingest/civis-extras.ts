import type { Env } from '../types';
import { recordIngest } from '../lib/db';
import { logAgentActivity } from '../lib/agent-activity';

// ── CIVIS auxiliary endpoints ───────────────────────────────────────────────
// Two more public CIVIS feeds (no key), beyond atendidos + desaparecidos:
//   • /api/reportes/publicos → citizen damage/incident reports (photos + geo)
//                              → mirrored into the existing `sos_damage` table.
//   • /api/puntos            → aid / collection / help points (acopio, refugio,
//                              agua, médico) → new `civis_puntos` table.
// Both idempotent (UPSERT by CIVIS id). Skipped siblings, documented:
//   • /api/replicas    = FUNVISIS aftershocks — ALREADY ingested by ingestFunvisis
//                        into `events`; re-ingesting would duplicate. SKIP.
//   • /api/edificaciones = damaged buildings — overlaps the existing /edificios
//                        (terremotovenezuela) feature; deferred to avoid a
//                        second, competing buildings source.

const UA = 'sismo911-civis-sync';
const clip = (v: unknown, n: number) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, n);

async function civisFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, cf: { cacheTtl: 0 } as any });
  if (!res.ok) throw new Error(`fetch_${res.status}`);
  return res.json<T>();
}

// ── reportes/publicos → sos_damage ──────────────────────────────────────────
interface CivisReporte {
  id: string; codigo?: string; tipo?: string; subtipo?: string[] | string;
  gravedad?: string; estado?: string; fotoUrl?: string | null; fuente?: string | null;
  ubicacion?: { lat?: number; lng?: number; referencia?: string } | null; actualizadoEn?: string | null;
}

/** One CIVIS reporte → sos_damage row shape (null if no usable geo/id). */
export function reporteToRow(r: CivisReporte) {
  if (!r.id) return null;
  const loc = r.ubicacion || {};
  const lat = typeof loc.lat === 'number' ? loc.lat : null;
  const lng = typeof loc.lng === 'number' ? loc.lng : null;
  const sub = Array.isArray(r.subtipo) ? r.subtipo.join(', ') : String(r.subtipo || '');
  return {
    id: `civis_${clip(r.id, 72)}`,
    category: clip(r.tipo || 'dano', 40),
    severity: clip(r.gravedad || '', 24),
    resource_status: '',
    verification: clip(r.estado || '', 24),            // 'validado' etc.
    title: clip([r.codigo, sub].filter(Boolean).join(' · ') || 'Reporte CIVIS', 160),
    description: clip([sub, loc.referencia].filter(Boolean).join(' — '), 2000),
    lat, lng,
    municipio: '', parroquia: '', building_type: '', people_trapped: 0,
    source_url: `civis:${clip(r.codigo || r.id, 40)}`,   // provenance marker (traceable, non-clobbering)
    image_url: clip(r.fotoUrl || '', 500),
    created_at: clip(r.actualizadoEn || '', 40),
  };
}

async function ingestReportes(env: Env): Promise<number> {
  const base = (env.CIVIS_API_BASE || 'https://civisvenezuela.com').replace(/\/+$/, '');
  const { reportes } = await civisFetch<{ reportes: CivisReporte[] }>(`${base}/api/reportes/publicos`);
  const now = Date.now();
  const stmts: any[] = [];
  for (const rep of reportes ?? []) {
    const r = reporteToRow(rep);
    if (!r) continue;
    stmts.push(env.DB.prepare(
      `INSERT INTO sos_damage
         (id,category,severity,resource_status,verification,title,description,lat,lng,municipio,parroquia,
          building_type,people_trapped,source_url,image_url,created_at,synced_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         category=excluded.category, severity=excluded.severity, verification=excluded.verification,
         title=excluded.title, description=excluded.description, lat=excluded.lat, lng=excluded.lng,
         image_url=CASE WHEN excluded.image_url<>'' THEN excluded.image_url ELSE sos_damage.image_url END,
         created_at=excluded.created_at, synced_ms=excluded.synced_ms`
    ).bind(r.id, r.category, r.severity, r.resource_status, r.verification, r.title, r.description, r.lat, r.lng,
           r.municipio, r.parroquia, r.building_type, r.people_trapped, r.source_url, r.image_url, r.created_at, now));
  }
  let written = 0;
  for (let i = 0; i < stmts.length; i += 100) { await env.DB.batch(stmts.slice(i, i + 100)); written += Math.min(100, stmts.length - i); }
  return written;
}

// ── puntos → civis_puntos ───────────────────────────────────────────────────
interface CivisPunto {
  id: string; nombre?: string; tipo?: string; direccion?: string; estado?: string; detalle?: string;
  servicios?: string[] | null; necesidades?: string[] | null; pais?: string | null;
  ubicacion?: { lat?: number; lng?: number } | null; actualizadoEn?: string | null;
  confirmacionesCount?: number | null; totalPersonas?: number | null;
}

/** One CIVIS punto → civis_puntos row shape (null if no id). */
export function puntoToRow(p: CivisPunto, now: number) {
  if (!p.id) return null;
  const loc = p.ubicacion || {};
  return {
    id: clip(p.id, 72),
    nombre: clip(p.nombre || '', 160),
    tipo: clip(p.tipo || '', 40),
    lat: typeof loc.lat === 'number' ? loc.lat : null,
    lng: typeof loc.lng === 'number' ? loc.lng : null,
    direccion: clip(p.direccion || '', 300),
    estado: clip(p.estado || '', 24),
    detalle: clip(p.detalle || '', 2000),
    servicios: JSON.stringify(Array.isArray(p.servicios) ? p.servicios.slice(0, 40) : []),
    necesidades: JSON.stringify(Array.isArray(p.necesidades) ? p.necesidades.slice(0, 40) : []),
    pais: clip(p.pais || '', 40),
    confirmaciones: Number.isFinite(Number(p.confirmacionesCount)) ? Math.trunc(Number(p.confirmacionesCount)) : 0,
    total_personas: Number.isFinite(Number(p.totalPersonas)) ? Math.trunc(Number(p.totalPersonas)) : 0,
    actualizado: clip(p.actualizadoEn || '', 40),
    now,
  };
}

const PUNTOS_PAGE = 1000;   // API caps a page at 1000; ~1,957 total → 2 fetches.

async function ingestPuntos(env: Env): Promise<number> {
  const base = (env.CIVIS_API_BASE || 'https://civisvenezuela.com').replace(/\/+$/, '');
  const now = Date.now();
  const all: CivisPunto[] = [];
  for (let offset = 0; offset < 20000; offset += PUNTOS_PAGE) {
    const { puntos } = await civisFetch<{ puntos: CivisPunto[]; total?: number }>(`${base}/api/puntos?limit=${PUNTOS_PAGE}&offset=${offset}`);
    all.push(...(puntos ?? []));
    if (!puntos || puntos.length < PUNTOS_PAGE) break;   // last page
  }
  const stmts: any[] = [];
  for (const pt of all) {
    const r = puntoToRow(pt, now);
    if (!r) continue;
    stmts.push(env.DB.prepare(
      `INSERT INTO civis_puntos
         (id,nombre,tipo,lat,lng,direccion,estado,detalle,servicios,necesidades,pais,
          confirmaciones,total_personas,source,actualizado,created_ms,updated_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'civis', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         nombre=excluded.nombre, tipo=excluded.tipo, lat=excluded.lat, lng=excluded.lng,
         direccion=excluded.direccion, estado=excluded.estado, detalle=excluded.detalle,
         servicios=excluded.servicios, necesidades=excluded.necesidades, pais=excluded.pais,
         confirmaciones=excluded.confirmaciones, total_personas=excluded.total_personas,
         actualizado=excluded.actualizado, updated_ms=excluded.updated_ms`
    ).bind(r.id, r.nombre, r.tipo, r.lat, r.lng, r.direccion, r.estado, r.detalle, r.servicios,
           r.necesidades, r.pais, r.confirmaciones, r.total_personas, r.actualizado, r.now, r.now));
  }
  let written = 0;
  for (let i = 0; i < stmts.length; i += 100) { await env.DB.batch(stmts.slice(i, i + 100)); written += Math.min(100, stmts.length - i); }
  return written;
}

/** Self-heal: tolerate a DB where migration 0092 has not yet applied. */
async function ensurePuntos(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS civis_puntos (
       id TEXT PRIMARY KEY, nombre TEXT NOT NULL DEFAULT '', tipo TEXT, lat REAL, lng REAL,
       direccion TEXT, estado TEXT, detalle TEXT, servicios TEXT, necesidades TEXT, pais TEXT,
       confirmaciones INTEGER NOT NULL DEFAULT 0, total_personas INTEGER NOT NULL DEFAULT 0,
       source TEXT NOT NULL DEFAULT 'civis', actualizado TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL)`
  ).run().catch(() => {});
}

/** Hourly combined pull of both auxiliary CIVIS feeds. Isolated so one failing
 *  never aborts the other. No silent failure — each logs to agent_activity. */
export async function ingestCivisExtras(env: Env): Promise<{ reportes: number; puntos: number }> {
  let reportes = 0, puntos = 0;
  try {
    reportes = await ingestReportes(env);
    await recordIngest(env, 'civis-reportes', true, reportes);
  } catch (e: any) {
    const reason = String(e?.message || e).slice(0, 120);
    await recordIngest(env, 'civis-reportes', false, 0, reason).catch(() => {});
    await logAgentActivity(env, { source: 'civis-reportes', action: 'ingest', ok: false,
      summary: `⚠ Fallo al sincronizar reportes públicos CIVIS: ${reason}.` }).catch(() => {});
  }
  try {
    await ensurePuntos(env);
    puntos = await ingestPuntos(env);
    await recordIngest(env, 'civis-puntos', true, puntos);
  } catch (e: any) {
    const reason = String(e?.message || e).slice(0, 120);
    await recordIngest(env, 'civis-puntos', false, 0, reason).catch(() => {});
    await logAgentActivity(env, { source: 'civis-puntos', action: 'ingest', ok: false,
      summary: `⚠ Fallo al sincronizar puntos de ayuda CIVIS: ${reason}.` }).catch(() => {});
  }
  if (reportes || puntos) {
    await logAgentActivity(env, { source: 'civis-extras', action: 'ingest', fetched: reportes + puntos, created: reportes + puntos,
      summary: `🗺️ CIVIS auxiliares — ${reportes} reporte(s) de daños + ${puntos} punto(s) de ayuda actualizados.`, ok: true }).catch(() => {});
  }
  return { reportes, puntos };
}
