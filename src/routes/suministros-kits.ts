import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';

// SUMINISTROS — Kits / BOM. Table: sum_kits + sum_kit_lineas. A kit is a bundle
// of products+quantities. Cost (Σ component cost) and "buildable" (min over
// components of floor(on_hand/qty)) are derived on read. Assembling consumes the
// components FEFO through the existing atomic movement ledger (sum_transacciones).
// Mounted at /api/suministros/kits. Reads gated suministros:read; writes manage.

export const sumKits = new Hono<{ Bindings: Env }>();

const str = (v: unknown, max: number) => (v == null ? null : String(v).trim().slice(0, max) || null);
const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
const round2 = (n: number) => Math.round(n * 100) / 100;

// Effective unit cost: manual override → preferred supplier → MIN supplier → 0.
const COSTO = `COALESCE(NULLIF(p.costo_unit,0),
  (SELECT precio FROM sum_producto_proveedor WHERE producto_id=p.id AND preferido=1 LIMIT 1),
  (SELECT MIN(precio) FROM sum_producto_proveedor WHERE producto_id=p.id), 0)`;
const ON_HAND = `(SELECT COALESCE(SUM(e.cantidad),0) FROM sum_existencias e
  JOIN sum_items i ON i.id=e.item_id WHERE i.producto_id=p.id)`;

// Fetch components for one or many kits with live cost + on-hand per product.
async function componentsByKit(env: Env, kitIds: string[]) {
  const map = new Map<string, any[]>();
  if (!kitIds.length) return map;
  const ph = kitIds.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT kl.kit_id, kl.id AS linea_id, kl.producto_id, kl.cantidad,
        p.nombre AS producto_nombre, p.codigo, p.unidad,
        ${COSTO} AS costo_unit, ${ON_HAND} AS on_hand
     FROM sum_kit_lineas kl JOIN sum_productos p ON p.id = kl.producto_id
     WHERE kl.kit_id IN (${ph})`
  ).bind(...kitIds).all<any>();
  for (const r of results ?? []) {
    if (!map.has(r.kit_id)) map.set(r.kit_id, []);
    map.get(r.kit_id)!.push(r);
  }
  return map;
}

function rollup(comps: any[]) {
  let costo = 0;
  let buildable = comps.length ? Infinity : 0;
  for (const c of comps) {
    const qtyPer = Number(c.cantidad) || 0;
    costo += qtyPer * (Number(c.costo_unit) || 0);
    if (qtyPer > 0) buildable = Math.min(buildable, Math.floor((Number(c.on_hand) || 0) / qtyPer));
    else buildable = 0;
  }
  if (!Number.isFinite(buildable)) buildable = 0;
  return { costo_total: round2(costo), buildable };
}

// GET / → kits with component count, unit cost, and buildable count.
sumKits.get('/', async (c) => {
  const { results: kits } = await c.env.DB.prepare(
    `SELECT k.*, cat.nombre AS categoria_nombre, cat.color AS categoria_color
     FROM sum_kits k LEFT JOIN sum_categorias cat ON cat.id = k.categoria_id
     ORDER BY k.nombre`
  ).all<any>();
  const ids = (kits ?? []).map((k) => k.id);
  const comps = await componentsByKit(c.env, ids);
  const rows = (kits ?? []).map((k) => {
    const cs = comps.get(k.id) ?? [];
    return { ...k, n_componentes: cs.length, ...rollup(cs) };
  });
  return c.json({ results: rows });
});

// GET /:id → kit + its component lines (with cost + on-hand each).
sumKits.get('/:id', async (c) => {
  const id = c.req.param('id');
  const kit = await c.env.DB.prepare(
    `SELECT k.*, cat.nombre AS categoria_nombre FROM sum_kits k
     LEFT JOIN sum_categorias cat ON cat.id = k.categoria_id WHERE k.id = ?`
  ).bind(id).first<any>();
  if (!kit) return c.json({ error: 'no encontrado' }, 404);
  const comps = (await componentsByKit(c.env, [id])).get(id) ?? [];
  return c.json({ ...kit, ...rollup(comps), componentes: comps });
});

// POST / → create kit + component lines. Body: {nombre, codigo?, categoria_id?,
// descripcion?, lineas:[{producto_id, cantidad}]}.
sumKits.post('/', async (c) => {
  const b = await c.req.json().catch(() => null);
  const nombre = str(b?.nombre, 200);
  if (!nombre) return c.json({ error: 'nombre requerido' }, 400);
  const lineas = Array.isArray(b?.lineas) ? b.lineas : [];
  let codigo = str(b?.codigo, 40) ?? `KIT-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
  const dup = await c.env.DB.prepare(`SELECT id FROM sum_kits WHERE codigo = ?`).bind(codigo).first();
  if (dup) return c.json({ error: 'código ya existe' }, 409);

  const id = uid('kit');
  const now = Date.now();
  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO sum_kits (id, codigo, nombre, categoria_id, descripcion, activo, created_ms, updated_ms)
       VALUES (?,?,?,?,?,?,?,?)`
    ).bind(id, codigo, nombre, str(b?.categoria_id, 40), str(b?.descripcion, 1000),
           b?.activo === undefined ? 1 : (b.activo ? 1 : 0), now, now),
  ];
  for (const ln of lineas) {
    const pid = str(ln?.producto_id, 40); const qty = num(ln?.cantidad);
    if (!pid || !qty || qty <= 0) continue;
    stmts.push(c.env.DB.prepare(
      `INSERT INTO sum_kit_lineas (id, kit_id, producto_id, cantidad, created_ms) VALUES (?,?,?,?,?)`
    ).bind(uid('kl'), id, pid, qty, now));
  }
  await c.env.DB.batch(stmts);
  const kit = await c.env.DB.prepare(`SELECT * FROM sum_kits WHERE id = ?`).bind(id).first();
  return c.json(kit, 201);
});

// PATCH /:id → update kit fields and (if `lineas` present) replace its BOM.
sumKits.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => null);
  const exists = await c.env.DB.prepare(`SELECT id FROM sum_kits WHERE id = ?`).bind(id).first();
  if (!exists) return c.json({ error: 'no encontrado' }, 404);
  const now = Date.now();
  const sets: string[] = []; const vals: unknown[] = [];
  if (b?.nombre != null) { const n = str(b.nombre, 200); if (!n) return c.json({ error: 'nombre inválido' }, 400); sets.push('nombre=?'); vals.push(n); }
  if (b?.codigo !== undefined) {
    const cod = str(b.codigo, 40); if (!cod) return c.json({ error: 'código inválido' }, 400);
    const dup = await c.env.DB.prepare(`SELECT id FROM sum_kits WHERE codigo=? AND id<>?`).bind(cod, id).first();
    if (dup) return c.json({ error: 'código ya existe' }, 409);
    sets.push('codigo=?'); vals.push(cod);
  }
  if (b?.categoria_id !== undefined) { sets.push('categoria_id=?'); vals.push(str(b.categoria_id, 40)); }
  if (b?.descripcion !== undefined) { sets.push('descripcion=?'); vals.push(str(b.descripcion, 1000)); }
  if (b?.activo !== undefined) { sets.push('activo=?'); vals.push(b.activo ? 1 : 0); }
  const stmts = [];
  if (sets.length) {
    sets.push('updated_ms=?'); vals.push(now); vals.push(id);
    stmts.push(c.env.DB.prepare(`UPDATE sum_kits SET ${sets.join(', ')} WHERE id = ?`).bind(...vals));
  }
  if (Array.isArray(b?.lineas)) {
    stmts.push(c.env.DB.prepare(`DELETE FROM sum_kit_lineas WHERE kit_id = ?`).bind(id));
    for (const ln of b.lineas) {
      const pid = str(ln?.producto_id, 40); const qty = num(ln?.cantidad);
      if (!pid || !qty || qty <= 0) continue;
      stmts.push(c.env.DB.prepare(
        `INSERT INTO sum_kit_lineas (id, kit_id, producto_id, cantidad, created_ms) VALUES (?,?,?,?,?)`
      ).bind(uid('kl'), id, pid, qty, now));
    }
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  const kit = await c.env.DB.prepare(`SELECT * FROM sum_kits WHERE id = ?`).bind(id).first();
  return c.json(kit);
});

sumKits.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM sum_kit_lineas WHERE kit_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM sum_kits WHERE id = ?`).bind(id),
  ]);
  return c.json({ ok: true, id });
});

// POST /:id/ensamblar → assemble N kits at a location by consuming components
// FEFO. Atomic: one despacho transaction whose lines remove each consumed item.
sumKits.post('/:id/ensamblar', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => null);
  const ubicacion = str(b?.ubicacion_id, 40);
  const cantidad = num(b?.cantidad);
  if (!ubicacion) return c.json({ error: 'ubicacion_id requerido' }, 400);
  if (!cantidad || cantidad <= 0) return c.json({ error: 'cantidad inválida' }, 400);

  const kit = await c.env.DB.prepare(`SELECT * FROM sum_kits WHERE id = ?`).bind(id).first<any>();
  if (!kit) return c.json({ error: 'kit no encontrado' }, 404);
  const comps = (await componentsByKit(c.env, [id])).get(id) ?? [];
  if (!comps.length) return c.json({ error: 'el kit no tiene componentes' }, 400);

  const now = Date.now();
  const txId = uid('tx');
  const code = `TX-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO sum_transacciones (id, codigo, tipo, ubicacion_id, referencia, motivo, actor, created_ms)
       VALUES (?,?,?,?,?,?,?,?)`
    ).bind(txId, code, 'despacho', ubicacion, `Ensamblaje ${kit.codigo} x${cantidad}`,
           `Ensamblaje de kit`, str(b?.actor, 120), now),
  ];

  // For each component, consume (cantidad × per-kit qty) FEFO from this location.
  for (const comp of comps) {
    const need = cantidad * (Number(comp.cantidad) || 0);
    if (need <= 0) continue;
    const { results: items } = await c.env.DB.prepare(
      `SELECT e.item_id, e.cantidad FROM sum_existencias e
       JOIN sum_items i ON i.id = e.item_id
       WHERE e.ubicacion_id = ? AND i.producto_id = ? AND e.cantidad > 0
       ORDER BY (i.caducidad_ms IS NULL), i.caducidad_ms`
    ).bind(ubicacion, comp.producto_id).all<{ item_id: string; cantidad: number }>();
    const available = (items ?? []).reduce((s, r) => s + r.cantidad, 0);
    if (available < need) {
      return c.json({
        error: `existencia insuficiente de ${comp.producto_nombre} en esta ubicación (necesita ${need}, disponible ${available})`,
      }, 409);
    }
    let remaining = need;
    for (const it of items ?? []) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, it.cantidad);
      remaining -= take;
      stmts.push(c.env.DB.prepare(
        `INSERT INTO sum_transaccion_lineas (id, transaccion_id, item_id, cantidad, created_ms) VALUES (?,?,?,?,?)`
      ).bind(uid('txl'), txId, it.item_id, -take, now));
      stmts.push(c.env.DB.prepare(
        `INSERT INTO sum_existencias (ubicacion_id, item_id, cantidad, updated_ms) VALUES (?,?,?,?)
         ON CONFLICT(ubicacion_id, item_id)
           DO UPDATE SET cantidad = sum_existencias.cantidad + excluded.cantidad, updated_ms = excluded.updated_ms`
      ).bind(ubicacion, it.item_id, -take, now));
    }
  }

  await c.env.DB.batch(stmts);
  return c.json({ ok: true, kit_id: id, codigo: kit.codigo, ensamblados: cantidad, transaccion: code }, 201);
});
