// ============================================================================
// REFUGIOS / EVACUACIÓN ENGINE — La Guaira (ex-Vargas)
// ----------------------------------------------------------------------------
// Pure, deterministic, dependency-free functions that:
//   1. SCORE a candidate site for holding displaced people (roads, services,
//      bed type, safety) → 0-100 suitability.
//   2. Estimate CAPACITY from usable area + bed type (Sphere space standards).
//   3. ASSIGN an at-risk population (by zone) to the best available shelters
//      respecting capacity and proximity (greedy nearest-suitable).
//   4. Compute full LOGISTICS for a sheltered population: water, food (kcal →
//      kg staples), sanitation, and the human ORG TABLE (doctors, nurses,
//      security, kitchen, WASH, managers).
//
// Standards used (planning factors — verify in the field before committing):
//   • Sphere Handbook 2018 — water 15 L/p/day, covered space 3.5 m²/p, camp
//     area 45 m²/p, 1 latrine/20 p, 1 water tap/250 p, 1 shower/50 p.
//   • WFP/WHO general food ration ≈ 2,100 kcal/p/day.
//   • Health staffing densities below are acute-shelter planning ratios, denser
//     than steady-state WHO minimums because population is concentrated.
// All ratios are overridable via LogisticsParams so an operator can tune them.
// ============================================================================

export type BedType = 'permanente' | 'temporal' | 'mixto';

export type SiteType =
  | 'polideportivo' | 'estadio' | 'campo_golf' | 'iglesia' | 'club_puerto'
  | 'escuela_nautica' | 'deposito_contenedores' | 'zona_baldia' | 'gimnasio'
  | 'escuela' | 'hospital' | 'aeropuerto';

/** Raw site inputs the scoring/capacity engine reads. 0-5 ordinal scales unless noted. */
export interface SiteInput {
  id?: string;
  nombre?: string;
  tipo?: SiteType | string;
  area_m2?: number | null;        // total usable surface area
  techado_m2?: number | null;     // covered/roofed area (drives permanent-bed capacity)
  bed_type?: BedType | string | null;
  capacity_estimate?: number | null; // manual override; if set, used as-is

  road_access?: number | null;    // 0-5 quality/number of access routes
  road_distance_m?: number | null;// meters to nearest carretera principal
  services_water?: number | null; // 0-5
  services_power?: number | null; // 0-5
  services_sanitation?: number | null; // 0-5
  services_kitchen?: number | null;    // 0-5

  elevation_m?: number | null;    // altitude — mudslide/tsunami safety in Vargas
  flood_risk?: number | null;     // 0-5 (HIGHER = riskier: near quebrada / coast)
  coast_distance_m?: number | null; // tsunami buffer (m)
}

// ── Space standards (m² per person) ──────────────────────────────────────────
export const SPACE = {
  coveredPerPerson: 3.5,   // Sphere: minimum covered living area, permanent beds
  campPerPerson: 45,       // Sphere: total site area incl. roads/services, tents
  temporaryPerPerson: 4.5, // open-field temporary holding (denser than full camp)
} as const;

// ── Scoring weights (sum = 1.0) ──────────────────────────────────────────────
export const SCORE_WEIGHTS = {
  roads: 0.25,
  services: 0.30,
  bedCapacity: 0.20,
  safety: 0.25, // Vargas: the 1999 deslave makes safety non-negotiable
} as const;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const n0 = (v: number | null | undefined, d = 0) => (v == null || Number.isNaN(v) ? d : Number(v));

/**
 * Estimate how many people a site can hold.
 *  - manual capacity_estimate wins if provided
 *  - 'permanente' → covered area / 3.5 m²
 *  - 'temporal'   → usable area / 4.5 m² (open holding)
 *  - 'mixto'      → covered permanent + remaining open temporary
 */
export function computeCapacity(s: SiteInput): number {
  if (s.capacity_estimate != null && s.capacity_estimate > 0) return Math.round(s.capacity_estimate);
  const area = n0(s.area_m2);
  const covered = n0(s.techado_m2);
  const bed = (s.bed_type ?? 'temporal') as BedType;
  if (bed === 'permanente') return Math.floor(covered / SPACE.coveredPerPerson);
  if (bed === 'mixto') {
    const perm = Math.floor(covered / SPACE.coveredPerPerson);
    const openArea = Math.max(0, area - covered);
    const temp = Math.floor(openArea / SPACE.temporaryPerPerson);
    return perm + temp;
  }
  // temporal
  return Math.floor(area / SPACE.temporaryPerPerson);
}

/** Sub-scores 0-100 for transparency in the UI. */
export interface ScoreBreakdown {
  roads: number; services: number; bedCapacity: number; safety: number;
  total: number; // weighted 0-100
}

/**
 * Score a site 0-100 for suitability to hold displaced people.
 * roads:    access quality + penalty for distance to a main road
 * services: water/power/sanitation/kitchen (water & sanitation weighted heaviest)
 * bedCap:   capacity (log-scaled) blended with bed permanence
 * safety:   elevation reward, flood-risk penalty, coast-distance (tsunami) reward
 */
export function scoreSite(s: SiteInput): ScoreBreakdown {
  // — roads —
  const accessPct = (clamp(n0(s.road_access), 0, 5) / 5) * 100;
  const dist = n0(s.road_distance_m, 1500);
  const distPct = clamp(100 - (dist / 2000) * 100, 0, 100); // 0 m → 100, ≥2 km → 0
  const roads = Math.round(0.6 * accessPct + 0.4 * distPct);

  // — services — (water + sanitation are life-critical, weighted 35% each)
  const w = (clamp(n0(s.services_water), 0, 5) / 5) * 100;
  const san = (clamp(n0(s.services_sanitation), 0, 5) / 5) * 100;
  const p = (clamp(n0(s.services_power), 0, 5) / 5) * 100;
  const k = (clamp(n0(s.services_kitchen), 0, 5) / 5) * 100;
  const services = Math.round(0.35 * w + 0.35 * san + 0.15 * p + 0.15 * k);

  // — bed / capacity — capacity log-scaled (1000+ people → ~100) blended w/ permanence
  const cap = computeCapacity(s);
  const capPct = clamp((Math.log10(Math.max(cap, 1)) / 3) * 100, 0, 100); // 10^3 = 1000 → 100
  const bed = (s.bed_type ?? 'temporal') as BedType;
  const permPct = bed === 'permanente' ? 100 : bed === 'mixto' ? 70 : 45;
  const bedCapacity = Math.round(0.6 * capPct + 0.4 * permPct);

  // — safety — Vargas-specific: elevation good, flood/quebrada bad, coast distance good
  const elev = clamp((n0(s.elevation_m) / 60) * 100, 0, 100); // ≥60 m → full marks
  const floodPenalty = (clamp(n0(s.flood_risk), 0, 5) / 5) * 100;
  const coast = clamp((n0(s.coast_distance_m, 500) / 1000) * 100, 0, 100); // ≥1 km from sea → full
  const safety = Math.round(clamp(0.45 * elev + 0.25 * coast + 0.30 * (100 - floodPenalty), 0, 100));

  const total = Math.round(
    SCORE_WEIGHTS.roads * roads +
    SCORE_WEIGHTS.services * services +
    SCORE_WEIGHTS.bedCapacity * bedCapacity +
    SCORE_WEIGHTS.safety * safety,
  );
  return { roads, services, bedCapacity, safety, total };
}

/** Tier label for a total score (UI color coding). */
export function scoreTier(total: number): 'optimo' | 'apto' | 'marginal' | 'no_apto' {
  if (total >= 75) return 'optimo';
  if (total >= 55) return 'apto';
  if (total >= 40) return 'marginal';
  return 'no_apto';
}

// ── Geo ──────────────────────────────────────────────────────────────────────
/** Haversine great-circle distance in km. */
export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180, la2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ── Assignment ────────────────────────────────────────────────────────────────
export interface ZoneInput { id: string; nombre?: string; lat: number; lon: number; population: number; }
export interface SiteForAssign {
  id: string; nombre?: string; lat: number; lon: number;
  capacity: number; score: number; status?: string;
}
export interface Assignment { zone_id: string; zone_nombre?: string; site_id: string; site_nombre?: string; people: number; distance_km: number; }
export interface AssignmentResult {
  assignments: Assignment[];
  unassigned: { zone_id: string; zone_nombre?: string; people: number }[];
  totals: { population: number; sheltered: number; unsheltered: number; capacityUsed: number; capacityTotal: number };
}

/**
 * Assign each zone's population to the best available shelters.
 * Strategy: per zone (largest first), fill nearest suitable shelters first,
 * where "suitable" ranks by score then by proximity. Capacity is consumed
 * across zones so the result is a feasible, non-overlapping allocation.
 * Excludes sites with status 'cerrado'. Deterministic (stable sort by id ties).
 */
export function assignPopulation(zones: ZoneInput[], sites: SiteForAssign[]): AssignmentResult {
  const remaining = new Map(
    sites.filter((s) => s.status !== 'cerrado' && s.capacity > 0)
         .map((s) => [s.id, s.capacity]),
  );
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const assignments: Assignment[] = [];
  const unassigned: AssignmentResult['unassigned'] = [];

  const orderedZones = [...zones].sort((a, b) => b.population - a.population || a.id.localeCompare(b.id));
  for (const z of orderedZones) {
    let need = Math.max(0, Math.round(z.population));
    // rank candidate sites: higher score first, then nearer, then id for stability
    const ranked = sites
      .filter((s) => (remaining.get(s.id) ?? 0) > 0)
      .map((s) => ({ s, d: haversineKm(z.lat, z.lon, s.lat, s.lon) }))
      .sort((a, b) => b.s.score - a.s.score || a.d - b.d || a.s.id.localeCompare(b.s.id));

    for (const { s, d } of ranked) {
      if (need <= 0) break;
      const free = remaining.get(s.id) ?? 0;
      if (free <= 0) continue;
      const take = Math.min(free, need);
      remaining.set(s.id, free - take);
      need -= take;
      assignments.push({
        zone_id: z.id, zone_nombre: z.nombre, site_id: s.id, site_nombre: s.nombre,
        people: take, distance_km: Math.round(d * 10) / 10,
      });
    }
    if (need > 0) unassigned.push({ zone_id: z.id, zone_nombre: z.nombre, people: need });
  }

  const capacityTotal = sites.reduce((a, s) => a + (s.status === 'cerrado' ? 0 : s.capacity), 0);
  const capacityUsed = [...remaining.entries()].reduce((a, [id, free]) => a + ((siteById.get(id)?.capacity ?? 0) - free), 0);
  const population = zones.reduce((a, z) => a + Math.max(0, Math.round(z.population)), 0);
  const unsheltered = unassigned.reduce((a, u) => a + u.people, 0);
  return {
    assignments, unassigned,
    totals: { population, sheltered: population - unsheltered, unsheltered, capacityUsed, capacityTotal },
  };
}

// ── Logistics & organization ──────────────────────────────────────────────────
export interface LogisticsParams {
  waterLPerPersonDay: number;     // 15 (Sphere)
  kcalPerPersonDay: number;       // 2100 (WFP/WHO)
  // staple breakdown (kg/person/day) — a simple, locally-relevant ration
  cerealKgPerPersonDay: number;   // rice/maize/pasta
  pulsesKgPerPersonDay: number;   // beans/lentils
  oilKgPerPersonDay: number;
  saltKgPerPersonDay: number;
  // sanitation (people per unit)
  peoplePerLatrine: number;       // 20
  peoplePerShower: number;        // 50
  peoplePerWaterTap: number;      // 250
  // staffing (1 staff per N people, unless absolute)
  peoplePerDoctor: number;        // 2000 (acute shelter clinic)
  peoplePerNurse: number;         // 1000
  peoplePerParamedic: number;     // 500
  peoplePerPsychologist: number;  // 3000
  peoplePerSecurity: number;      // 50 (FANB/PNB/PC)
  peoplePerCook: number;          // 100
  peoplePerWashTech: number;      // 250
  peoplePerShelterStaff: number;  // 250 (general site staff)
}

export const DEFAULT_LOGISTICS: LogisticsParams = {
  waterLPerPersonDay: 15,
  kcalPerPersonDay: 2100,
  cerealKgPerPersonDay: 0.45,
  pulsesKgPerPersonDay: 0.06,
  oilKgPerPersonDay: 0.03,
  saltKgPerPersonDay: 0.005,
  peoplePerLatrine: 20,
  peoplePerShower: 50,
  peoplePerWaterTap: 250,
  peoplePerDoctor: 2000,
  peoplePerNurse: 1000,
  peoplePerParamedic: 500,
  peoplePerPsychologist: 3000,
  peoplePerSecurity: 50,
  peoplePerCook: 100,
  peoplePerWashTech: 250,
  peoplePerShelterStaff: 250,
};

export interface LogisticsResult {
  people: number; days: number;
  water: { litersPerDay: number; litersTotal: number; trucks20kL: number };
  food: {
    kcalPerDay: number; mealsPerDay: number;
    cerealKg: number; pulsesKg: number; oilKg: number; saltKg: number;
    totalRationKg: number; // all staples × days
  };
  sanitation: { latrines: number; showers: number; waterTaps: number };
  personnel: {
    doctors: number; nurses: number; paramedics: number; psychologists: number;
    security: number; cooks: number; washTechs: number; shelterStaff: number;
    total: number;
  };
}

const perN = (people: number, per: number) => (per > 0 ? Math.ceil(people / per) : 0);

/** Compute all logistics + the staffing table for `people` over `days`. */
export function computeLogistics(people: number, days = 7, p: LogisticsParams = DEFAULT_LOGISTICS): LogisticsResult {
  const ppl = Math.max(0, Math.round(people));
  const d = Math.max(1, Math.round(days));
  const waterPerDay = ppl * p.waterLPerPersonDay;
  const cerealKg = ppl * p.cerealKgPerPersonDay * d;
  const pulsesKg = ppl * p.pulsesKgPerPersonDay * d;
  const oilKg = ppl * p.oilKgPerPersonDay * d;
  const saltKg = ppl * p.saltKgPerPersonDay * d;
  return {
    people: ppl, days: d,
    water: {
      litersPerDay: waterPerDay,
      litersTotal: waterPerDay * d,
      trucks20kL: Math.ceil((waterPerDay * d) / 20000), // 20 m³ water tankers
    },
    food: {
      kcalPerDay: ppl * p.kcalPerPersonDay,
      mealsPerDay: ppl * 3,
      cerealKg: Math.round(cerealKg),
      pulsesKg: Math.round(pulsesKg),
      oilKg: Math.round(oilKg),
      saltKg: Math.round(saltKg),
      totalRationKg: Math.round(cerealKg + pulsesKg + oilKg + saltKg),
    },
    sanitation: {
      latrines: perN(ppl, p.peoplePerLatrine),
      showers: perN(ppl, p.peoplePerShower),
      waterTaps: perN(ppl, p.peoplePerWaterTap),
    },
    personnel: (() => {
      const doctors = perN(ppl, p.peoplePerDoctor);
      const nurses = perN(ppl, p.peoplePerNurse);
      const paramedics = perN(ppl, p.peoplePerParamedic);
      const psychologists = perN(ppl, p.peoplePerPsychologist);
      const security = perN(ppl, p.peoplePerSecurity);
      const cooks = perN(ppl, p.peoplePerCook);
      const washTechs = perN(ppl, p.peoplePerWashTech);
      const shelterStaff = perN(ppl, p.peoplePerShelterStaff);
      return {
        doctors, nurses, paramedics, psychologists, security, cooks, washTechs, shelterStaff,
        total: doctors + nurses + paramedics + psychologists + security + cooks + washTechs + shelterStaff,
      };
    })(),
  };
}

// ── Incident-command organization (SCI / ICS, Venezuelan agencies) ────────────
export interface OrgNode { rol: string; agencia?: string; funcion: string; reporta_a?: string; }

/** Static SCI org table for a shelter/evacuation operation in La Guaira. */
export function orgTable(): OrgNode[] {
  return [
    { rol: 'Comandante de Incidente', agencia: 'Protección Civil (PCNGRD)', funcion: 'Autoridad única; fija objetivos y prioridades de la operación.' },
    { rol: 'Oficial de Información Pública', agencia: 'PCNGRD / Gobernación', funcion: 'Vocería, alertas a la población, coordinación con medios.', reporta_a: 'Comandante de Incidente' },
    { rol: 'Oficial de Seguridad', agencia: 'Bomberos / FANB', funcion: 'Seguridad operativa; evalúa riesgos para personal y refugiados.', reporta_a: 'Comandante de Incidente' },
    { rol: 'Oficial de Enlace', agencia: 'Gobernación La Guaira', funcion: 'Coordinación inter-agencial (Cruz Roja, ONG, INAC, Bolipuertos).', reporta_a: 'Comandante de Incidente' },
    { rol: 'Jefe Sección Operaciones', agencia: 'Bomberos / FANB', funcion: 'Búsqueda y rescate, evacuación, seguridad de refugios, salud en sitio.', reporta_a: 'Comandante de Incidente' },
    { rol: 'Coordinador de Refugios', agencia: 'PCNGRD / MinHábitat', funcion: 'Apertura, registro y gestión de cada refugio; reporta ocupación.', reporta_a: 'Jefe Sección Operaciones' },
    { rol: 'Coordinador de Salud', agencia: 'MPPS / Cruz Roja', funcion: 'Triage, atención médica, vigilancia epidemiológica, salud mental.', reporta_a: 'Jefe Sección Operaciones' },
    { rol: 'Coordinador de Seguridad Ciudadana', agencia: 'PNB / GNB', funcion: 'Orden público, control de acceso y protección en refugios.', reporta_a: 'Jefe Sección Operaciones' },
    { rol: 'Jefe Sección Planificación', agencia: 'PCNGRD', funcion: 'Situación, recursos, censo de damnificados, proyección de necesidades.', reporta_a: 'Comandante de Incidente' },
    { rol: 'Jefe Sección Logística', agencia: 'FANB / SUMINISTROS', funcion: 'Suministros, transporte, agua, alimentación, telecomunicaciones.', reporta_a: 'Comandante de Incidente' },
    { rol: 'Unidad de Suministros', agencia: 'SUMINISTROS / PMA', funcion: 'Adquisición, almacén y distribución de alimentos y NFI.', reporta_a: 'Jefe Sección Logística' },
    { rol: 'Unidad de Agua y Saneamiento (WASH)', agencia: 'HIDROCAPITAL / UNICEF', funcion: 'Agua potable, letrinas, duchas, manejo de residuos.', reporta_a: 'Jefe Sección Logística' },
    { rol: 'Unidad de Transporte', agencia: 'FANB / INTT', funcion: 'Flota de evacuación y traslado de insumos (ver módulo FLOTA).', reporta_a: 'Jefe Sección Logística' },
    { rol: 'Unidad de Alimentación', agencia: 'CLAP / PMA', funcion: 'Cocinas, raciones y comidas calientes en refugios.', reporta_a: 'Jefe Sección Logística' },
    { rol: 'Jefe Sección Administración/Finanzas', agencia: 'Gobernación', funcion: 'Costos, contratos, registro de donaciones y rendición de cuentas.', reporta_a: 'Comandante de Incidente' },
  ];
}

// ── Niñez y poblaciones vulnerables — aggregation ─────────────────────────────
// Pure aggregation over the shelter-side child/vulnerable tables. NEVER receives
// an individual minor record — only aggregated per-shelter rows. The officialOnly
// flag (default true) drops planning estimates so public surfaces show authorized
// data only. (See migration 0072_refugios_ninez_vulnerables.sql.)

/** Age bands that count toward the minor total (non-overlapping). */
export const MINOR_AGE_BANDS = ['menores_0_5', 'menores_6_15', 'menores_16_17'] as const;

export interface NinezSiteMeta { id: string; parroquia?: string | null; municipio?: string | null; status?: string | null; }
export interface CapabilityRow { site_id: string; capability_key: string; value: number; official: number; }
export interface PopulationRow { site_id: string; category_key: string; count: number; official: number; }
export interface NeedRow {
  site_id: string; need_key: string; status: string;
  qty_required?: number | null; qty_received?: number | null; official: number;
}

export interface NinezSummary {
  totals: { minors: number; sheltersWithChildPopulation: number; sheltersChildCapable: number };
  byRegion: { region: string; minors: number; shelters: number }[];
  needs: { need_key: string; requerido: number; parcial: number; cubierto: number; qty_required: number; qty_received: number }[];
  resources: { qty_required: number; qty_received: number; pct_cubierto: number };
  capabilities: { capability_key: string; sites: number }[];
}

/**
 * Aggregate child/vulnerable shelter data into the stats panel shape:
 * minors by region, # shelters with child population, top needs, resources
 * delivered vs required, and capability coverage. Deterministic; officialOnly
 * defaults to true (planning estimates excluded).
 */
export function summarizeNinez(
  sites: NinezSiteMeta[],
  capabilities: CapabilityRow[],
  populations: PopulationRow[],
  needs: NeedRow[],
  officialOnly = true,
): NinezSummary {
  const keep = (official: number) => (officialOnly ? official === 1 : true);
  const regionOf = new Map(sites.map((s) => [s.id, (s.parroquia || s.municipio || 'Sin región') as string]));
  const minorBands = new Set<string>(MINOR_AGE_BANDS);

  // — population → minors by region —
  const regionMinors = new Map<string, number>();
  const regionShelters = new Map<string, Set<string>>();
  const sheltersWithChildren = new Set<string>();
  for (const p of populations) {
    if (!keep(p.official) || !minorBands.has(p.category_key)) continue;
    const c = Math.max(0, Math.round(n0(p.count)));
    if (c <= 0) continue;
    const region = regionOf.get(p.site_id) || 'Sin región';
    regionMinors.set(region, (regionMinors.get(region) ?? 0) + c);
    if (!regionShelters.has(region)) regionShelters.set(region, new Set());
    regionShelters.get(region)!.add(p.site_id);
    sheltersWithChildren.add(p.site_id);
  }
  const byRegion = [...regionMinors.entries()]
    .map(([region, minors]) => ({ region, minors, shelters: regionShelters.get(region)?.size ?? 0 }))
    .sort((a, b) => b.minors - a.minors || a.region.localeCompare(b.region));
  const totalMinors = byRegion.reduce((a, r) => a + r.minors, 0);

  // — needs board —
  const needAgg = new Map<string, { requerido: number; parcial: number; cubierto: number; qty_required: number; qty_received: number }>();
  for (const nd of needs) {
    if (!keep(nd.official)) continue;
    const cur = needAgg.get(nd.need_key) ?? { requerido: 0, parcial: 0, cubierto: 0, qty_required: 0, qty_received: 0 };
    if (nd.status === 'requerido') cur.requerido += 1;
    else if (nd.status === 'parcial') cur.parcial += 1;
    else if (nd.status === 'cubierto') cur.cubierto += 1;
    cur.qty_required += Math.max(0, n0(nd.qty_required));
    cur.qty_received += Math.max(0, n0(nd.qty_received));
    needAgg.set(nd.need_key, cur);
  }
  const needsOut = [...needAgg.entries()]
    .map(([need_key, v]) => ({ need_key, ...v }))
    .sort((a, b) => b.requerido - a.requerido || b.parcial - a.parcial || a.need_key.localeCompare(b.need_key));
  const reqTotal = needsOut.reduce((a, n) => a + n.qty_required, 0);
  const recTotal = needsOut.reduce((a, n) => a + n.qty_received, 0);

  // — capability coverage (# of distinct sites offering each capability) —
  const capSites = new Map<string, Set<string>>();
  const childCapable = new Set<string>();
  for (const cap of capabilities) {
    if (!keep(cap.official) || n0(cap.value) <= 0) continue;
    if (!capSites.has(cap.capability_key)) capSites.set(cap.capability_key, new Set());
    capSites.get(cap.capability_key)!.add(cap.site_id);
    childCapable.add(cap.site_id);
  }
  const capabilities_ = [...capSites.entries()]
    .map(([capability_key, set]) => ({ capability_key, sites: set.size }))
    .sort((a, b) => b.sites - a.sites || a.capability_key.localeCompare(b.capability_key));

  return {
    totals: {
      minors: totalMinors,
      sheltersWithChildPopulation: sheltersWithChildren.size,
      sheltersChildCapable: childCapable.size,
    },
    byRegion,
    needs: needsOut,
    resources: {
      qty_required: reqTotal,
      qty_received: recTotal,
      pct_cubierto: reqTotal > 0 ? Math.round((recTotal / reqTotal) * 100) : 0,
    },
    capabilities: capabilities_,
  };
}
