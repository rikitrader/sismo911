import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { rateLimit, validLatLon } from '../lib/security';
import { audit } from '../lib/audit';
import { COMMODITY_IDS, COMMODITY_UNIT } from '../data/commodities';

// FEMA/NIMS-style logistics for centros de acopio: inventory, needs, shipments
// (with chain-of-custody), a needs↔surplus matching engine, and a command
// dashboard. Mounted at /api/acopio alongside acopio.ts.
//
// Gating (src/index.ts ADMIN_WRITE_PREFIXES '/api/acopio'): all writes here are
// operator-only; all GET reads are public.

export const logistica = new Hono<{ Bindings: Env }>();

const SHIP_STATUS = ['creado', 'despachado', 'en_transito', 'entregado', 'confirmado', 'cancelado'];
const NEED_STATUS = ['open', 'matched', 'fulfilled', 'cancelled'];
const CUSTODY_EVENTS = ['creado', 'cargado', 'despachado', 'en_transito', 'entregado', 'confirmado', 'incidencia'];
// Which custody event a shipment-status transition records.
const STATUS_EVENT: Record<string, string> = {
  creado: 'creado', despachado: 'despachado', en_transito: 'en_transito',
  entregado: 'entregado', confirmado: 'confirmado', cancelado: 'incidencia',
};

const str = (v: unknown, max: number) =>
  v == null ? null : String(v).trim().slice(0, max) || null;
const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
const qtyOf = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

export interface CenterGeo { id: string; lat: number; lon: number; nombre?: string; estado?: string; ciudad?: string; }
export interface InvRow { center_id: string; commodity: string; qty: number; }
export interface NeedRow { id: string; center_id: string; commodity: string; qty: number; priority: number; }
export interface MatchSuggestion {
  need_id: string; commodity: string; qty_needed: number; priority: number;
  dest_id: string; origin_id: string; qty_available: number; km: number | null;
}

// Great-circle distance in km. Returns null if either point lacks coords.
export function haversineKm(a?: { lat: number; lon: number } | null, b?: { lat: number; lon: number } | null): number | null {
  if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(a.lon) || !Number.isFinite(b.lat) || !Number.isFinite(b.lon)) return null;
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(s))) * 10) / 10;
}

// For every open need, find centers with surplus of that commodity and rank
// candidates by (priority asc, distance asc, qty desc). Pure → testable.
export function rankMatches(
  needs: NeedRow[],
  inventory: InvRow[],
  geo: Map<string, CenterGeo>,
  perNeed = 3
): MatchSuggestion[] {
  const byCommodity = new Map<string, InvRow[]>();
  for (const r of inventory) {
    if (r.qty <= 0) continue;
    (byCommodity.get(r.commodity) ?? byCommodity.set(r.commodity, []).get(r.commodity)!).push(r);
  }
  const out: MatchSuggestion[] = [];
  for (const need of needs) {
    const supply = (byCommodity.get(need.commodity) ?? []).filter((s) => s.center_id !== need.center_id);
    const dest = geo.get(need.center_id);
    const ranked = supply
      .map((s) => ({ s, km: haversineKm(dest, geo.get(s.center_id)) }))
      .sort((a, b) => {
        if (a.km == null && b.km == null) return b.s.qty - a.s.qty;
        if (a.km == null) return 1;
        if (b.km == null) return -1;
        return a.km - b.km || b.s.qty - a.s.qty;
      })
      .slice(0, perNeed);
    for (const { s, km } of ranked) {
      out.push({
        need_id: need.id, commodity: need.commodity, qty_needed: need.qty, priority: need.priority,
        dest_id: need.center_id, origin_id: s.center_id, qty_available: s.qty, km,
      });
    }
  }
  // Surface most urgent needs first.
  return out.sort((a, b) => a.priority - b.priority || (a.km ?? 1e9) - (b.km ?? 1e9));
}

// Load center coordinates from the curated catalog (static asset) + approved
// citizen submissions. One ASSETS subrequest on a user-triggered GET — within budget.
async function loadCenterGeo(env: Env, req: Request): Promise<Map<string, CenterGeo>> {
  const geo = new Map<string, CenterGeo>();
  try {
    const res = await env.ASSETS.fetch(new Request(new URL('/acopio-data.json', req.url).toString()));
    if (res.ok) {
      const cat = (await res.json()) as any[];
      for (const d of cat) if (d?.id) geo.set(d.id, { id: d.id, lat: d.lat, lon: d.lon, nombre: d.nombre, estado: d.estado, ciudad: d.ciudad });
    }
  } catch { /* catalog optional — matching still works for DB centers */ }
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, nombre, estado, ciudad, lat, lon FROM acopio_submissions WHERE status='approved' AND lat IS NOT NULL`
    ).all();
    for (const r of results ?? []) geo.set((r as any).id, { id: (r as any).id, lat: (r as any).lat, lon: (r as any).lon, nombre: (r as any).nombre, estado: (r as any).estado, ciudad: (r as any).ciudad });
  } catch { /* ignore */ }
  return geo;
}

// ── Inventory ───────────────────────────────────────────────────────────────
logistica.get('/inventory', async (c) => {
  const center = c.req.query('center');
  const q = center
    ? c.env.DB.prepare(`SELECT center_id, commodity, qty, unit, updated_ms FROM acopio_inventory WHERE center_id = ? ORDER BY commodity`).bind(center)
    : c.env.DB.prepare(`SELECT center_id, commodity, qty, unit, updated_ms FROM acopio_inventory ORDER BY center_id, commodity`);
  const { results } = await q.all();
  return c.json({ inventory: results ?? [] });
});

logistica.post('/inventory', async (c) => {
  const b = await c.req.json().catch(() => null);
  const center_id = str(b?.center_id, 120);
  const commodity = str(b?.commodity, 40);
  const qty = qtyOf(b?.qty);
  if (!center_id || !commodity) return c.json({ error: 'center_id y commodity requeridos' }, 400);
  if (!COMMODITY_IDS.has(commodity)) return c.json({ error: 'commodity inválido' }, 400);
  if (qty == null) return c.json({ error: 'qty inválida' }, 400);
  const unit = str(b?.unit, 16) ?? COMMODITY_UNIT[commodity] ?? 'u';
  await c.env.DB.prepare(
    `INSERT INTO acopio_inventory (center_id, commodity, qty, unit, updated_ms) VALUES (?,?,?,?,?)
     ON CONFLICT(center_id, commodity) DO UPDATE SET qty=excluded.qty, unit=excluded.unit, updated_ms=excluded.updated_ms`
  ).bind(center_id, commodity, qty, unit, Date.now()).run();
  await audit(c, 'acopio.inventory.upsert', { center_id, commodity, qty });
  return c.json({ ok: true, center_id, commodity, qty, unit });
});

// ── Needs / requests ─────────────────────────────────────────────────────────
logistica.get('/needs', async (c) => {
  const status = c.req.query('status');
  const q = status && NEED_STATUS.includes(status)
    ? c.env.DB.prepare(`SELECT * FROM acopio_needs WHERE status = ? ORDER BY priority, created_ms DESC LIMIT 1000`).bind(status)
    : c.env.DB.prepare(`SELECT * FROM acopio_needs ORDER BY priority, created_ms DESC LIMIT 1000`);
  const { results } = await q.all();
  return c.json({ needs: results ?? [] });
});

logistica.post('/needs', async (c) => {
  const b = await c.req.json().catch(() => null);
  const center_id = str(b?.center_id, 120);
  const commodity = str(b?.commodity, 40);
  const qty = qtyOf(b?.qty);
  if (!center_id || !commodity) return c.json({ error: 'center_id y commodity requeridos' }, 400);
  if (!COMMODITY_IDS.has(commodity)) return c.json({ error: 'commodity inválido' }, 400);
  if (qty == null) return c.json({ error: 'qty inválida' }, 400);
  let priority = Number(b?.priority);
  if (![1, 2, 3].includes(priority)) priority = 2;
  const now = Date.now();
  const id = uid('nee');
  await c.env.DB.prepare(
    `INSERT INTO acopio_needs (id, center_id, commodity, qty, priority, status, note, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(id, center_id, commodity, qty, priority, 'open', str(b?.note, 400), now, now).run();
  await audit(c, 'acopio.need.create', { id, center_id, commodity, qty, priority });
  return c.json({ ok: true, id, status: 'open' }, 201);
});

logistica.patch('/needs/:id', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => null);
  const sets: string[] = [], vals: any[] = [];
  if (b?.status != null) {
    if (!NEED_STATUS.includes(b.status)) return c.json({ error: 'status inválido' }, 400);
    sets.push('status = ?'); vals.push(b.status);
  }
  if (b?.qty != null) {
    const qty = qtyOf(b.qty);
    if (qty == null) return c.json({ error: 'qty inválida' }, 400);
    sets.push('qty = ?'); vals.push(qty);
  }
  if (!sets.length) return c.json({ error: 'nada que actualizar' }, 400);
  sets.push('updated_ms = ?'); vals.push(Date.now());
  vals.push(id);
  const r = await c.env.DB.prepare(`UPDATE acopio_needs SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  if (!r.meta.changes) return c.json({ error: 'no encontrado' }, 404);
  await audit(c, 'acopio.need.update', { id, status: b?.status });
  return c.json({ ok: true, id });
});

// ── Shipments + chain of custody ─────────────────────────────────────────────
logistica.get('/shipments', async (c) => {
  const status = c.req.query('status');
  const q = status && SHIP_STATUS.includes(status)
    ? c.env.DB.prepare(`SELECT * FROM acopio_shipments WHERE status = ? ORDER BY updated_ms DESC LIMIT 500`).bind(status)
    : c.env.DB.prepare(`SELECT * FROM acopio_shipments ORDER BY updated_ms DESC LIMIT 500`);
  const { results: ships } = await q.all();
  const list = ships ?? [];
  const items: Record<string, any[]> = {};
  const custody: Record<string, any[]> = {};
  for (const s of list) {
    const sid = (s as any).id;
    const [it, cu] = await Promise.all([
      c.env.DB.prepare(`SELECT commodity, qty, unit FROM acopio_shipment_items WHERE shipment_id = ?`).bind(sid).all(),
      c.env.DB.prepare(`SELECT event, actor, lat, lon, note, at_ms FROM acopio_custody WHERE shipment_id = ? ORDER BY at_ms`).bind(sid).all(),
    ]);
    items[sid] = it.results ?? [];
    custody[sid] = cu.results ?? [];
  }
  return c.json({ shipments: list, items, custody });
});

logistica.post('/shipments', async (c) => {
  const b = await c.req.json().catch(() => null);
  const origin_id = str(b?.origin_id, 120);
  const dest_id = str(b?.dest_id, 120);
  if (!origin_id || !dest_id) return c.json({ error: 'origin_id y dest_id requeridos' }, 400);
  if (origin_id === dest_id) return c.json({ error: 'origen y destino deben diferir' }, 400);
  const rawItems = Array.isArray(b?.items) ? b.items : [];
  const items = rawItems
    .map((it: any) => ({ commodity: str(it?.commodity, 40), qty: qtyOf(it?.qty), unit: str(it?.unit, 16) }))
    .filter((it: any) => it.commodity && COMMODITY_IDS.has(it.commodity) && it.qty != null && it.qty > 0)
    .slice(0, 20);
  if (!items.length) return c.json({ error: 'manifiesto vacío o inválido' }, 400);
  const now = Date.now();
  const id = uid('shp');
  const eta = num(b?.eta_ms);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO acopio_shipments (id, origin_id, dest_id, status, vehicle, driver, eta_ms, note, created_by, created_ms, updated_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(id, origin_id, dest_id, 'creado', str(b?.vehicle, 80), str(b?.driver, 120), eta, str(b?.note, 400), str(b?.created_by, 120), now, now),
    ...items.map((it: any) =>
      c.env.DB.prepare(`INSERT INTO acopio_shipment_items (shipment_id, commodity, qty, unit) VALUES (?,?,?,?)`)
        .bind(id, it.commodity, it.qty, it.unit ?? COMMODITY_UNIT[it.commodity] ?? 'u')
    ),
    c.env.DB.prepare(`INSERT INTO acopio_custody (id, shipment_id, event, actor, lat, lon, note, at_ms) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(uid('cus'), id, 'creado', str(b?.created_by, 120), null, null, 'Envío creado', now),
  ]);
  await audit(c, 'acopio.shipment.create', { id, origin_id, dest_id, items: items.length });
  return c.json({ ok: true, id, status: 'creado' }, 201);
});

// Advance a shipment's status and append a chain-of-custody event.
logistica.patch('/shipments/:id', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => null);
  const status = str(b?.status, 20);
  if (!status || !SHIP_STATUS.includes(status)) return c.json({ error: 'status inválido' }, 400);
  const lat = num(b?.lat), lon = num(b?.lon);
  if ((lat != null || lon != null) && !validLatLon(lat, lon)) return c.json({ error: 'bad_lat_lon' }, 400);
  const now = Date.now();
  const r = await c.env.DB.prepare(`UPDATE acopio_shipments SET status = ?, updated_ms = ? WHERE id = ?`)
    .bind(status, now, id).run();
  if (!r.meta.changes) return c.json({ error: 'no encontrado' }, 404);
  const event = STATUS_EVENT[status] ?? status;
  await c.env.DB.prepare(
    `INSERT INTO acopio_custody (id, shipment_id, event, actor, lat, lon, note, at_ms) VALUES (?,?,?,?,?,?,?,?)`
  ).bind(uid('cus'), id, CUSTODY_EVENTS.includes(event) ? event : 'incidencia', str(b?.actor, 120), lat, lon, str(b?.note, 400), now).run();
  await audit(c, 'acopio.shipment.advance', { id, status });
  return c.json({ ok: true, id, status });
});

// ── Matching engine: open needs ↔ surplus inventory, ranked by distance ───────
logistica.get('/match', async (c) => {
  const limited = await rateLimit(c.env, c, 'acopio_match', 60, 60);
  if (limited) return limited;
  const [needsRes, invRes] = await Promise.all([
    c.env.DB.prepare(`SELECT id, center_id, commodity, qty, priority FROM acopio_needs WHERE status='open' ORDER BY priority LIMIT 500`).all(),
    c.env.DB.prepare(`SELECT center_id, commodity, qty FROM acopio_inventory WHERE qty > 0`).all(),
  ]);
  const geo = await loadCenterGeo(c.env, c.req.raw);
  const suggestions = rankMatches(
    (needsRes.results ?? []) as unknown as NeedRow[],
    (invRes.results ?? []) as unknown as InvRow[],
    geo
  );
  // Attach human labels for the UI.
  const enriched = suggestions.map((s) => ({
    ...s,
    dest_name: geo.get(s.dest_id)?.nombre ?? s.dest_id,
    origin_name: geo.get(s.origin_id)?.nombre ?? s.origin_id,
  }));
  return c.json({ matches: enriched, count: enriched.length });
});

// ── Command dashboard: aggregated logistics snapshot ──────────────────────────
logistica.get('/dashboard', async (c) => {
  const [inv, needs, ships, custody] = await Promise.all([
    c.env.DB.prepare(`SELECT commodity, SUM(qty) AS total, COUNT(DISTINCT center_id) AS centers FROM acopio_inventory GROUP BY commodity`).all(),
    c.env.DB.prepare(`SELECT status, priority, COUNT(*) AS n FROM acopio_needs GROUP BY status, priority`).all(),
    c.env.DB.prepare(`SELECT status, COUNT(*) AS n FROM acopio_shipments GROUP BY status`).all(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM acopio_custody`).first(),
  ]);
  const needRows = (needs.results ?? []) as any[];
  const open_needs = needRows.filter((r) => r.status === 'open').reduce((a, r) => a + r.n, 0);
  const critical_open = needRows.filter((r) => r.status === 'open' && r.priority === 1).reduce((a, r) => a + r.n, 0);
  const shipRows = (ships.results ?? []) as any[];
  const in_transit = shipRows.filter((r) => ['despachado', 'en_transito'].includes(r.status)).reduce((a, r) => a + r.n, 0);
  const delivered = shipRows.filter((r) => ['entregado', 'confirmado'].includes(r.status)).reduce((a, r) => a + r.n, 0);
  return c.json({
    commodities: inv.results ?? [],
    needs: { by: needRows, open: open_needs, critical: critical_open },
    shipments: { by: shipRows, in_transit, delivered, total: shipRows.reduce((a, r) => a + r.n, 0) },
    custody_events: (custody as any)?.n ?? 0,
    generated_ms: Date.now(),
  });
});
