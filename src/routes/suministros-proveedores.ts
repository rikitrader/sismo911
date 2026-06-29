import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';

// SUMINISTROS — Proveedores y donantes. Tables: sum_proveedores, sum_producto_proveedor.
// Mounted at /api/suministros/proveedores. Writes gated centrally; GET public.

export const sumProveedores = new Hono<{ Bindings: Env }>();

const TIPOS   = ['proveedor', 'donante', 'fabricante', 'distribuidor'];
const MONEDAS = ['USD', 'VES'];

const str = (v: unknown, max: number) =>
  v == null ? null : String(v).trim().slice(0, max) || null;
const num = (v: unknown) => (v == null || v === '' ? null : Number(v));

// GET / → list; ?tipo= ?activo= ?q= (matches nombre/rif); ?limit default 300.
sumProveedores.get('/', async (c) => {
  const tipo   = c.req.query('tipo');
  const activo = c.req.query('activo');
  const q      = c.req.query('q');
  let limit = Number(c.req.query('limit'));
  if (!Number.isFinite(limit) || limit <= 0) limit = 300;
  limit = Math.min(limit, 1000);

  const where: string[] = [];
  const vals: unknown[] = [];
  if (tipo && TIPOS.includes(tipo)) { where.push('prv.tipo = ?'); vals.push(tipo); }
  if (activo === '0' || activo === '1') { where.push('prv.activo = ?'); vals.push(Number(activo)); }
  if (q) { where.push('(prv.nombre LIKE ? OR prv.rif LIKE ?)'); vals.push(`%${q}%`, `%${q}%`); }

  // LEFT JOIN users surfaces the payee's name + x402 receive status so the UI can
  // show, per supplier, whether a real payment link can be generated for it.
  const sql = `
    SELECT prv.*,
           u.name         AS payee_name,
           u.x402_enabled AS payee_x402_enabled,
           COALESCE(u.x402_pay_to, u.wallet_address) AS payee_wallet
    FROM sum_proveedores prv
    LEFT JOIN users u ON u.id = prv.payee_user_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY prv.nombre LIMIT ?`;
  vals.push(limit);
  const { results } = await c.env.DB.prepare(sql).bind(...vals).all();
  return c.json({ results: results ?? [] });
});

/** Validate an optional payee_user_id points at a real user. Returns
 *  { ok:true, value } (value may be null when not provided/cleared) or
 *  { ok:false }. */
async function resolvePayee(c: any, raw: unknown): Promise<{ ok: boolean; value?: string | null }> {
  if (raw === undefined) return { ok: true, value: undefined };
  const id = str(raw, 40);
  if (!id) return { ok: true, value: null };
  const u = await c.env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(id).first();
  return u ? { ok: true, value: id } : { ok: false };
}

// POST / → create (nombre required; tipo validated against enum).
sumProveedores.post('/', async (c) => {
  const b = await c.req.json().catch(() => null);
  const nombre = str(b?.nombre, 200);
  if (!nombre) return c.json({ error: 'nombre requerido' }, 400);
  const tipo = str(b?.tipo, 40) ?? 'proveedor';
  if (!TIPOS.includes(tipo)) return c.json({ error: 'tipo inválido' }, 400);

  const payee = await resolvePayee(c, b?.payee_user_id);
  if (!payee.ok) return c.json({ error: 'payee_user_id no encontrado' }, 404);

  const id = uid('prv');
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO sum_proveedores
       (id, nombre, tipo, rif, contacto, telefono, email, direccion, estado_region, activo, notas, payee_user_id, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, nombre, tipo, str(b?.rif, 20), str(b?.contacto, 160), str(b?.telefono, 40),
    str(b?.email, 160), str(b?.direccion, 400), str(b?.estado_region, 80),
    b?.activo === undefined ? 1 : (b.activo ? 1 : 0),
    str(b?.notas, 1000), payee.value ?? null, now, now
  ).run();

  const row = await c.env.DB.prepare(`SELECT * FROM sum_proveedores WHERE id = ?`).bind(id).first();
  return c.json(row, 201);
});

// GET /producto/:productoId → suppliers offering a product, preferido DESC, precio ASC.
// Registered before /:id so the static segment wins.
sumProveedores.get('/producto/:productoId', async (c) => {
  const productoId = c.req.param('productoId');
  const { results } = await c.env.DB.prepare(
    `SELECT pp.*, prv.nombre AS proveedor_nombre, prv.tipo AS proveedor_tipo
     FROM sum_producto_proveedor pp
     JOIN sum_proveedores prv ON prv.id = pp.proveedor_id
     WHERE pp.producto_id = ?
     ORDER BY pp.preferido DESC, pp.precio ASC`
  ).bind(productoId).all();
  return c.json({ results: results ?? [] });
});

// PATCH /precios/:linkId → update a price link.
// Registered before /:id so /precios/... is not consumed by the id param.
sumProveedores.patch('/precios/:linkId', async (c) => {
  const linkId = c.req.param('linkId');
  const b = await c.req.json().catch(() => null);
  const sets: string[] = [];
  const vals: unknown[] = [];

  if (b?.codigo_proveedor !== undefined) { sets.push('codigo_proveedor = ?'); vals.push(str(b.codigo_proveedor, 80)); }
  if (b?.precio !== undefined) { sets.push('precio = ?'); vals.push(num(b.precio)); }
  if (b?.moneda != null) {
    if (!MONEDAS.includes(b.moneda)) return c.json({ error: 'moneda inválida' }, 400);
    sets.push('moneda = ?'); vals.push(b.moneda);
  }
  if (b?.lead_time_dias !== undefined) {
    const d = num(b.lead_time_dias);
    sets.push('lead_time_dias = ?'); vals.push(d != null ? Math.round(d) : null);
  }
  if (b?.minimo_pedido !== undefined) { sets.push('minimo_pedido = ?'); vals.push(num(b.minimo_pedido)); }
  if (b?.preferido !== undefined) { sets.push('preferido = ?'); vals.push(b.preferido ? 1 : 0); }

  if (!sets.length) return c.json({ error: 'nada que actualizar' }, 400);
  sets.push('updated_ms = ?'); vals.push(Date.now());
  vals.push(linkId);
  const r = await c.env.DB.prepare(`UPDATE sum_producto_proveedor SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  if (!r.meta.changes) return c.json({ error: 'no encontrado' }, 404);
  const row = await c.env.DB.prepare(`SELECT * FROM sum_producto_proveedor WHERE id = ?`).bind(linkId).first();
  return c.json(row);
});

// DELETE /precios/:linkId → remove a price link.
sumProveedores.delete('/precios/:linkId', async (c) => {
  const linkId = c.req.param('linkId');
  const r = await c.env.DB.prepare(`DELETE FROM sum_producto_proveedor WHERE id = ?`).bind(linkId).run();
  if (!r.meta.changes) return c.json({ error: 'no encontrado' }, 404);
  return c.json({ ok: true, id: linkId });
});

// GET /:id → one proveedor (+ payee_name / payee_x402_enabled / payee_wallet) or 404.
sumProveedores.get('/:id', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT prv.*,
            u.name         AS payee_name,
            u.x402_enabled AS payee_x402_enabled,
            COALESCE(u.x402_pay_to, u.wallet_address) AS payee_wallet
     FROM sum_proveedores prv
     LEFT JOIN users u ON u.id = prv.payee_user_id
     WHERE prv.id = ?`
  ).bind(c.req.param('id')).first();
  if (!row) return c.json({ error: 'no encontrado' }, 404);
  return c.json(row);
});

// PATCH /:id → update mutable fields; bump updated_ms.
sumProveedores.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => null);
  const sets: string[] = [];
  const vals: unknown[] = [];

  if (b?.nombre != null) {
    const nombre = str(b.nombre, 200);
    if (!nombre) return c.json({ error: 'nombre inválido' }, 400);
    sets.push('nombre = ?'); vals.push(nombre);
  }
  if (b?.tipo != null) {
    if (!TIPOS.includes(b.tipo)) return c.json({ error: 'tipo inválido' }, 400);
    sets.push('tipo = ?'); vals.push(b.tipo);
  }
  if (b?.rif !== undefined) { sets.push('rif = ?'); vals.push(str(b.rif, 20)); }
  if (b?.contacto !== undefined) { sets.push('contacto = ?'); vals.push(str(b.contacto, 160)); }
  if (b?.telefono !== undefined) { sets.push('telefono = ?'); vals.push(str(b.telefono, 40)); }
  if (b?.email !== undefined) { sets.push('email = ?'); vals.push(str(b.email, 160)); }
  if (b?.direccion !== undefined) { sets.push('direccion = ?'); vals.push(str(b.direccion, 400)); }
  if (b?.estado_region !== undefined) { sets.push('estado_region = ?'); vals.push(str(b.estado_region, 80)); }
  if (b?.activo !== undefined) { sets.push('activo = ?'); vals.push(b.activo ? 1 : 0); }
  if (b?.notas !== undefined) { sets.push('notas = ?'); vals.push(str(b.notas, 1000)); }
  if (b?.payee_user_id !== undefined) {
    const payee = await resolvePayee(c, b.payee_user_id);
    if (!payee.ok) return c.json({ error: 'payee_user_id no encontrado' }, 404);
    sets.push('payee_user_id = ?'); vals.push(payee.value ?? null);
  }

  if (!sets.length) return c.json({ error: 'nada que actualizar' }, 400);
  sets.push('updated_ms = ?'); vals.push(Date.now());
  vals.push(id);
  const r = await c.env.DB.prepare(`UPDATE sum_proveedores SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  if (!r.meta.changes) return c.json({ error: 'no encontrado' }, 404);
  const row = await c.env.DB.prepare(`SELECT * FROM sum_proveedores WHERE id = ?`).bind(id).first();
  return c.json(row);
});

// DELETE /:id → remove proveedor and its sum_producto_proveedor links.
sumProveedores.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const exists = await c.env.DB.prepare(`SELECT id FROM sum_proveedores WHERE id = ?`).bind(id).first();
  if (!exists) return c.json({ error: 'no encontrado' }, 404);
  await c.env.DB.prepare(`DELETE FROM sum_producto_proveedor WHERE proveedor_id = ?`).bind(id).run();
  await c.env.DB.prepare(`DELETE FROM sum_proveedores WHERE id = ?`).bind(id).run();
  return c.json({ ok: true, id });
});

// GET /:id/precios → price links for this supplier, JOINed with sum_productos.
sumProveedores.get('/:id/precios', async (c) => {
  const id = c.req.param('id');
  const exists = await c.env.DB.prepare(`SELECT id FROM sum_proveedores WHERE id = ?`).bind(id).first();
  if (!exists) return c.json({ error: 'no encontrado' }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT pp.*, p.nombre AS producto_nombre, p.codigo, p.unidad
     FROM sum_producto_proveedor pp
     JOIN sum_productos p ON p.id = pp.producto_id
     WHERE pp.proveedor_id = ?
     ORDER BY p.nombre`
  ).bind(id).all();
  return c.json({ results: results ?? [] });
});

// POST /:id/precios → add a product-supplier price link.
sumProveedores.post('/:id/precios', async (c) => {
  const proveedorId = c.req.param('id');
  const exists = await c.env.DB.prepare(`SELECT id FROM sum_proveedores WHERE id = ?`).bind(proveedorId).first();
  if (!exists) return c.json({ error: 'no encontrado' }, 404);

  const b = await c.req.json().catch(() => null);
  const productoId = str(b?.producto_id, 40);
  if (!productoId) return c.json({ error: 'producto_id requerido' }, 400);

  const producto = await c.env.DB.prepare(`SELECT id FROM sum_productos WHERE id = ?`).bind(productoId).first();
  if (!producto) return c.json({ error: 'producto no encontrado' }, 404);

  const moneda = str(b?.moneda, 3) ?? 'USD';
  if (!MONEDAS.includes(moneda)) return c.json({ error: 'moneda inválida' }, 400);

  const ltd = num(b?.lead_time_dias);
  const id = uid('pp');
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO sum_producto_proveedor
       (id, producto_id, proveedor_id, codigo_proveedor, precio, moneda, lead_time_dias, minimo_pedido, preferido, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, productoId, proveedorId,
    str(b?.codigo_proveedor, 80), num(b?.precio), moneda,
    ltd != null ? Math.round(ltd) : null,
    num(b?.minimo_pedido),
    b?.preferido ? 1 : 0,
    now, now
  ).run();

  const row = await c.env.DB.prepare(`SELECT * FROM sum_producto_proveedor WHERE id = ?`).bind(id).first();
  return c.json(row, 201);
});
