import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import {
  scoreSite, computeCapacity, scoreTier, summarizeNinez,
  type SiteInput, type NinezSiteMeta, type CapabilityRow, type PopulationRow, type NeedRow,
} from '../refugios/engine';

// NIÑEZ Y POBLACIONES VULNERABLES (/api/ninez) — shelter-side classification,
// aggregated population counts and humanitarian needs board for minors and
// vulnerable groups (Módulo 11 + Giovanni #8). Built ON TOP of refugios_sites.
//
// PRIVACY (HARD, Módulo 11 mandate): these endpoints expose ONLY aggregated,
// shelter-level data — never an individual minor (no name, cédula, photo or
// street address is stored or returned). PUBLIC reads return official=1 rows
// only; planning estimates (official=0) are visible exclusively through the
// ninez:manage-gated /admin reads. Individual minor cases live in
// persons/personas and are governed by src/lib/minor-protect.ts.
export const ninez = new Hono<{ Bindings: Env }>();

// ── Controlled vocabularies (also drive the UI badges/forms via /catalog) ─────
export const CAPABILITY_KEYS = [
  // child age-care tiers
  'recien_nacido', 'lactante', 'nino_pequeno', 'escolar', 'adolescente',
  // child special care
  'discapacidad_infantil', 'cronico_infantil', 'medico_especializado',
  'espacio_lactancia', 'personal_infantil',
  // Giovanni #8 vulnerable groups
  'discapacidad', 'movilidad_reducida', 'adulto_mayor', 'embarazada',
  'familia_ninos', 'cronico', 'mascotas',
] as const;
export const POPULATION_KEYS = [
  'menores_0_5', 'menores_6_15', 'menores_16_17',
  'recien_nacidos', 'lactantes', 'embarazadas', 'adultos_mayores', 'discapacidad', 'total',
] as const;
export const NEED_KEYS = [
  'agua', 'formula_lactante', 'panales', 'ropa', 'mantas', 'medicamento_pediatrico',
  'atencion_medica', 'atencion_psicologica', 'vacunas', 'kit_higiene', 'leche',
  'alimento_especial', 'alimento_infantil',
] as const;
const NEED_STATUS = new Set(['requerido', 'parcial', 'cubierto']);
// Life-critical pediatric needs: an unmet one is a CRITICAL child alert.
const CRITICAL_NEEDS = new Set(['agua', 'formula_lactante', 'leche', 'vacunas', 'medicamento_pediatrico', 'atencion_medica']);
const MINOR_POP_KEYS = new Set(['menores_0_5', 'menores_6_15', 'menores_16_17', 'recien_nacidos', 'lactantes']);

const capSet = new Set<string>(CAPABILITY_KEYS);
const popSet = new Set<string>(POPULATION_KEYS);
const needSet = new Set<string>(NEED_KEYS);

const str = (v: unknown, max: number) => (v == null ? null : String(v).trim().slice(0, max) || null);
const num = (v: unknown): number | null => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const flag = (v: unknown): 0 | 1 => (v === 1 || v === '1' || v === true ? 1 : 0);

const SITE_COLS = `id,nombre,tipo,municipio,parroquia,lat,lon,area_m2,techado_m2,bed_type,
  capacity_estimate,road_access,road_distance_m,services_water,services_power,
  services_sanitation,services_kitchen,elevation_m,flood_risk,coast_distance_m,
  status,current_occupancy,notes`;

// Latest snapshot per (site, key) — population/needs are append-only time series.
// Pick exactly ONE row per group (newest as_of_ms, rowid breaks same-ms ties) so
// two snapshots written in the same millisecond never double-count.
const LATEST_POP = `SELECT site_id,category_key,count,official,source,as_of_ms FROM refugios_site_population p
  WHERE p.rowid = (SELECT x.rowid FROM refugios_site_population x
    WHERE x.site_id=p.site_id AND x.category_key=p.category_key ORDER BY x.as_of_ms DESC, x.rowid DESC LIMIT 1)`;
const LATEST_NEEDS = `SELECT site_id,need_key,status,qty_required,qty_received,unit,official,source,as_of_ms FROM refugios_site_needs n
  WHERE n.rowid = (SELECT x.rowid FROM refugios_site_needs x
    WHERE x.site_id=n.site_id AND x.need_key=n.need_key ORDER BY x.as_of_ms DESC, x.rowid DESC LIMIT 1)`;

/** Pull capabilities/population/needs (optionally official-only) for assembling. */
async function loadData(env: Env, officialOnly: boolean) {
  const offCap = officialOnly ? ` WHERE official=1` : '';
  const [sites, caps, pop, needs] = await Promise.all([
    env.DB.prepare(`SELECT ${SITE_COLS} FROM refugios_sites WHERE moderation='approved'`).all(),
    env.DB.prepare(`SELECT site_id,capability_key,value,notes,official,source FROM refugios_site_capabilities${offCap}`).all(),
    env.DB.prepare(officialOnly ? `SELECT * FROM (${LATEST_POP}) WHERE official=1` : LATEST_POP).all(),
    env.DB.prepare(officialOnly ? `SELECT * FROM (${LATEST_NEEDS}) WHERE official=1` : LATEST_NEEDS).all(),
  ]);
  return {
    sites: (sites.results ?? []) as any[],
    caps: (caps.results ?? []) as any[],
    pop: (pop.results ?? []) as any[],
    needs: (needs.results ?? []) as any[],
  };
}

/** Assemble per-shelter cards (only shelters with any child/vulnerable data). */
function assemble(sites: any[], caps: any[], pop: any[], needs: any[]) {
  const byCap = new Map<string, any[]>();
  const byPop = new Map<string, any[]>();
  const byNeed = new Map<string, any[]>();
  for (const c of caps) (byCap.get(c.site_id) ?? byCap.set(c.site_id, []).get(c.site_id)!).push(c);
  for (const p of pop) (byPop.get(p.site_id) ?? byPop.set(p.site_id, []).get(p.site_id)!).push(p);
  for (const n of needs) (byNeed.get(n.site_id) ?? byNeed.set(n.site_id, []).get(n.site_id)!).push(n);
  const out: any[] = [];
  for (const s of sites) {
    const capabilities = byCap.get(s.id) ?? [];
    const population = byPop.get(s.id) ?? [];
    const sneeds = byNeed.get(s.id) ?? [];
    if (!capabilities.length && !population.length && !sneeds.length) continue; // skip shelters with no child data
    const breakdown = scoreSite(s as SiteInput);
    const capacity = computeCapacity(s as SiteInput);
    out.push({
      id: s.id, nombre: s.nombre, tipo: s.tipo, municipio: s.municipio, parroquia: s.parroquia,
      lat: s.lat, lon: s.lon, status: s.status, capacity, tier: scoreTier(breakdown.total),
      current_occupancy: s.current_occupancy ?? 0,
      capabilities, population, needs: sneeds,
    });
  }
  out.sort((a, b) => (b.population.length - a.population.length) || a.nombre.localeCompare(b.nombre));
  return out;
}

/** Classify child-priority alerts from assembled shelter cards. Pure + deterministic.
 *  Módulo 11: "Clasificación de alertas relacionadas con niños y adolescentes" +
 *  "Alertas prioritarias relacionadas con la infancia". */
export function deriveNinezAlerts(cards: any[]) {
  const alerts: any[] = [];
  for (const s of cards) {
    const minors = (s.population || [])
      .filter((p: any) => MINOR_POP_KEYS.has(p.category_key))
      .reduce((a: number, p: any) => a + (p.count || 0), 0);
    const hasChildCare = (s.capabilities || []).length > 0;

    // Unmet needs → one alert each (critical for life-critical pediatric needs).
    for (const n of s.needs || []) {
      if (n.status !== 'requerido') continue;
      alerts.push({
        kind: 'necesidad', site_id: s.id, site_nombre: s.nombre, region: s.parroquia || s.municipio || null,
        need_key: n.need_key, severity: CRITICAL_NEEDS.has(n.need_key) ? 'critica' : 'alerta', minors,
      });
    }
    // Shelter with minors at/over capacity.
    if (minors > 0 && s.status === 'lleno') {
      alerts.push({ kind: 'capacidad', site_id: s.id, site_nombre: s.nombre, region: s.parroquia || s.municipio || null, severity: 'critica', minors });
    } else if (minors > 0 && s.capacity > 0 && (s.current_occupancy || 0) / s.capacity >= 0.85) {
      alerts.push({ kind: 'capacidad', site_id: s.id, site_nombre: s.nombre, region: s.parroquia || s.municipio || null, severity: 'alerta', minors });
    }
    // Child-capable shelter that has closed.
    if (hasChildCare && s.status === 'cerrado') {
      alerts.push({ kind: 'cierre', site_id: s.id, site_nombre: s.nombre, region: s.parroquia || s.municipio || null, severity: 'info', minors });
    }
  }
  const rank: Record<string, number> = { critica: 0, alerta: 1, info: 2 };
  alerts.sort((a, b) => (rank[a.severity] - rank[b.severity]) || b.minors - a.minors || a.site_nombre.localeCompare(b.site_nombre));
  return alerts;
}

// ── GET /api/ninez/alertas — child-priority alerts, OFFICIAL only (public) ─────
ninez.get('/alertas', async (c) => {
  const { sites, caps, pop, needs } = await loadData(c.env, true);
  const cards = assemble(sites, caps, pop, needs);
  const alertas = deriveNinezAlerts(cards);
  const counts = alertas.reduce((m: Record<string, number>, a) => ((m[a.severity] = (m[a.severity] ?? 0) + 1), m), {});
  return c.json({ alertas, counts });
});

// ── GET /api/ninez/catalog — controlled vocabularies for the UI (public) ───────
ninez.get('/catalog', (c) => c.json({
  capabilities: CAPABILITY_KEYS, population: POPULATION_KEYS, needs: NEED_KEYS,
  need_status: ['requerido', 'parcial', 'cubierto'],
}));

// ── GET /api/ninez/refugios — child-capable shelters, OFFICIAL only (public) ───
ninez.get('/refugios', async (c) => {
  const { sites, caps, pop, needs } = await loadData(c.env, true);
  return c.json({ refugios: assemble(sites, caps, pop, needs), official_only: true });
});

// ── GET /api/ninez/summary — aggregated stats panel, OFFICIAL only (public) ────
ninez.get('/summary', async (c) => {
  const { sites, caps, pop, needs } = await loadData(c.env, true);
  const meta: NinezSiteMeta[] = sites.map((s) => ({ id: s.id, parroquia: s.parroquia, municipio: s.municipio, status: s.status }));
  return c.json(summarizeNinez(meta, caps as CapabilityRow[], pop as PopulationRow[], needs as NeedRow[], true));
});

// ── Operator reads (gated ninez:manage in route-policy) — include estimates ────
ninez.get('/admin/refugios', async (c) => {
  const { sites, caps, pop, needs } = await loadData(c.env, false);
  return c.json({ refugios: assemble(sites, caps, pop, needs), official_only: false });
});
ninez.get('/admin/summary', async (c) => {
  const { sites, caps, pop, needs } = await loadData(c.env, false);
  const meta: NinezSiteMeta[] = sites.map((s) => ({ id: s.id, parroquia: s.parroquia, municipio: s.municipio, status: s.status }));
  return c.json(summarizeNinez(meta, caps as CapabilityRow[], pop as PopulationRow[], needs as NeedRow[], false));
});

// ── POST /api/ninez/refugios/:id/capability — upsert a capability (gated) ──────
ninez.post('/refugios/:id/capability', async (c) => {
  const b = await c.req.json().catch(() => null);
  const key = str(b?.capability_key, 40);
  if (!key || !capSet.has(key)) return c.json({ error: 'capability_key_invalido' }, 400);
  const value = num(b?.value) ?? 1;
  await c.env.DB.prepare(
    `INSERT INTO refugios_site_capabilities (site_id,capability_key,value,notes,official,source,updated_ms)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(site_id,capability_key) DO UPDATE SET value=excluded.value, notes=excluded.notes,
       official=excluded.official, source=excluded.source, updated_ms=excluded.updated_ms`,
  ).bind(c.req.param('id'), key, value, str(b?.notes, 500), flag(b?.official), str(b?.source, 120), Date.now()).run();
  return c.json({ ok: true }, 201);
});

// ── DELETE /api/ninez/refugios/:id/capability/:key — remove a capability ───────
ninez.delete('/refugios/:id/capability/:key', async (c) => {
  const r = await c.env.DB.prepare(
    `DELETE FROM refugios_site_capabilities WHERE site_id=? AND capability_key=?`,
  ).bind(c.req.param('id'), c.req.param('key')).run();
  return c.json({ ok: true, deleted: r.meta.changes });
});

// ── POST /api/ninez/refugios/:id/population — record an aggregated count ───────
ninez.post('/refugios/:id/population', async (c) => {
  const b = await c.req.json().catch(() => null);
  const key = str(b?.category_key, 40);
  if (!key || !popSet.has(key)) return c.json({ error: 'category_key_invalido' }, 400);
  const count = Math.max(0, Math.round(num(b?.count) ?? 0));
  await c.env.DB.prepare(
    `INSERT INTO refugios_site_population (id,site_id,category_key,count,as_of_ms,official,source) VALUES (?,?,?,?,?,?,?)`,
  ).bind(uid('pop'), c.req.param('id'), key, count, Date.now(), flag(b?.official), str(b?.source, 120)).run();
  return c.json({ ok: true }, 201);
});

// ── POST /api/ninez/refugios/:id/need — record/update a need snapshot ──────────
ninez.post('/refugios/:id/need', async (c) => {
  const b = await c.req.json().catch(() => null);
  const key = str(b?.need_key, 40);
  if (!key || !needSet.has(key)) return c.json({ error: 'need_key_invalido' }, 400);
  const status = str(b?.status, 20) ?? 'requerido';
  if (!NEED_STATUS.has(status)) return c.json({ error: 'status_invalido' }, 400);
  await c.env.DB.prepare(
    `INSERT INTO refugios_site_needs (id,site_id,need_key,status,qty_required,qty_received,unit,as_of_ms,official,source)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    uid('need'), c.req.param('id'), key, status, num(b?.qty_required), num(b?.qty_received),
    str(b?.unit, 20), Date.now(), flag(b?.official), str(b?.source, 120),
  ).run();
  return c.json({ ok: true }, 201);
});
