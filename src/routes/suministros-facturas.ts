import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';

// SUMINISTROS — Facturas de compra con líneas (invoice + GL ledger).
// Tables: sum_facturas, sum_factura_lineas.
// Mounted at /api/suministros/facturas. Writes gated centrally; GET public.

export const sumFacturas = new Hono<{ Bindings: Env }>();

const ESTADOS = ['borrador', 'emitida', 'pagada', 'anulada'];
const MONEDAS = ['USD', 'VES'];

// Valid estado transitions via PATCH (pagada only via POST /:id/pagar).
const TRANSITIONS: Record<string, string[]> = {
  borrador: ['emitida', 'anulada'],
  emitida:  ['anulada'],
  anulada:  [],
};

const str = (v: unknown, max: number) =>
  v == null ? null : String(v).trim().slice(0, max) || null;
const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
const qty = (v: unknown) => (v == null || v === '' ? 1 : Math.max(0, Number(v)));

const facCode = () =>
  'FAC-' + crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();

// GET / → list with JOINs; ?estado= ?proveedor_id= ?limit=
sumFacturas.get('/', async (c) => {
  const estado      = c.req.query('estado');
  const proveedorId = c.req.query('proveedor_id');
  let limit = Number(c.req.query('limit'));
  if (!Number.isFinite(limit) || limit <= 0) limit = 200;
  limit = Math.min(limit, 1000);

  const where: string[] = [];
  const vals: unknown[] = [];
  if (estado && ESTADOS.includes(estado)) { where.push('f.estado = ?'); vals.push(estado); }
  if (proveedorId) { where.push('f.proveedor_id = ?'); vals.push(proveedorId); }

  const sql = `
    SELECT f.*,
           prv.nombre AS proveedor_nombre,
           cta.nombre AS cuenta_nombre,
           (SELECT COUNT(*) FROM sum_factura_lineas fl WHERE fl.factura_id = f.id) AS n_lineas
    FROM sum_facturas f
    LEFT JOIN sum_proveedores prv ON prv.id = f.proveedor_id
    LEFT JOIN sum_cuentas cta ON cta.id = f.cuenta_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY f.created_ms DESC LIMIT ?`;
  vals.push(limit);
  const { results } = await c.env.DB.prepare(sql).bind(...vals).all();
  return c.json({ results: results ?? [] });
});

// POST / → create factura (borrador) + líneas; compute monto_total from lines.
sumFacturas.post('/', async (c) => {
  const b = await c.req.json().catch(() => null);

  const proveedorId = str(b?.proveedor_id, 40);
  if (!proveedorId) return c.json({ error: 'proveedor_id requerido' }, 400);
  const prov = await c.env.DB.prepare(`SELECT id FROM sum_proveedores WHERE id = ?`).bind(proveedorId).first();
  if (!prov) return c.json({ error: 'proveedor no encontrado' }, 404);

  const cuentaId = str(b?.cuenta_id, 40) ?? null;
  if (cuentaId) {
    const cta = await c.env.DB.prepare(`SELECT id FROM sum_cuentas WHERE id = ?`).bind(cuentaId).first();
    if (!cta) return c.json({ error: 'cuenta no encontrada' }, 404);
  }

  const moneda = str(b?.moneda, 3) ?? 'USD';
  if (!MONEDAS.includes(moneda)) return c.json({ error: 'moneda inválida' }, 400);

  const lineasRaw: any[] = Array.isArray(b?.lineas) ? b.lineas : [];
  const lineas = lineasRaw.map((l: any) => ({
    id:          uid('facl'),
    descripcion: str(l?.descripcion, 400) ?? '',
    producto_id: str(l?.producto_id, 40) ?? null,
    cantidad:    qty(l?.cantidad),
    precio_unit: num(l?.precio_unit) ?? 0,
  }));

  const montoExplicito = num(b?.monto_total);
  const montoTotal = montoExplicito != null
    ? montoExplicito
    : lineas.reduce((s, l) => s + l.cantidad * l.precio_unit, 0);

  const id     = uid('fac');
  const codigo = facCode();
  const now    = Date.now();

  const insertFac = c.env.DB.prepare(
    `INSERT INTO sum_facturas
       (id, codigo, proveedor_id, orden_id, cuenta_id, estado, moneda, monto_total,
        fecha_ms, vencimiento_ms, referencia, nota, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, codigo, proveedorId,
    str(b?.orden_id, 40) ?? null,
    cuentaId, 'borrador', moneda, montoTotal,
    num(b?.fecha_ms) ?? now,
    num(b?.vencimiento_ms) ?? null,
    str(b?.referencia, 200) ?? null,
    str(b?.nota, 1000) ?? null,
    now, now
  );

  const insertLineas = lineas.map(l =>
    c.env.DB.prepare(
      `INSERT INTO sum_factura_lineas
         (id, factura_id, descripcion, producto_id, cantidad, precio_unit, created_ms)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(l.id, id, l.descripcion, l.producto_id, l.cantidad, l.precio_unit, now)
  );

  await c.env.DB.batch([insertFac, ...insertLineas]);
  const factura = await c.env.DB.prepare(`SELECT * FROM sum_facturas WHERE id = ?`).bind(id).first();
  return c.json({ factura }, 201);
});

// POST /:id/pagar → emitida → pagada; sets pagada_ms. Registered before /:id.
sumFacturas.post('/:id/pagar', async (c) => {
  const id  = c.req.param('id');
  const fac = await c.env.DB.prepare(`SELECT estado FROM sum_facturas WHERE id = ?`).bind(id).first();
  if (!fac) return c.json({ error: 'no encontrado' }, 404);
  if (String(fac.estado) !== 'emitida') return c.json({ error: 'solo facturas emitidas pueden pagarse' }, 409);
  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE sum_facturas SET estado = 'pagada', pagada_ms = ?, updated_ms = ? WHERE id = ?`
  ).bind(now, now, id).run();
  const row = await c.env.DB.prepare(`SELECT * FROM sum_facturas WHERE id = ?`).bind(id).first();
  return c.json(row);
});

// GET /:id → factura + lineas (lineas LEFT JOIN sum_productos for producto_nombre/codigo).
sumFacturas.get('/:id', async (c) => {
  const id      = c.req.param('id');
  const factura = await c.env.DB.prepare(`SELECT * FROM sum_facturas WHERE id = ?`).bind(id).first();
  if (!factura) return c.json({ error: 'no encontrado' }, 404);
  const { results: lineas } = await c.env.DB.prepare(
    `SELECT fl.*, p.nombre AS producto_nombre, p.codigo AS producto_codigo
     FROM sum_factura_lineas fl
     LEFT JOIN sum_productos p ON p.id = fl.producto_id
     WHERE fl.factura_id = ?
     ORDER BY fl.rowid`
  ).bind(id).all();
  return c.json({ factura, lineas: lineas ?? [] });
});

// PATCH /:id → estado transitions (see TRANSITIONS); cuenta_id/referencia/vencimiento_ms/nota.
sumFacturas.patch('/:id', async (c) => {
  const id  = c.req.param('id');
  const fac = await c.env.DB.prepare(`SELECT estado FROM sum_facturas WHERE id = ?`).bind(id).first();
  if (!fac) return c.json({ error: 'no encontrado' }, 404);
  const currentEstado = String(fac.estado);
  if (currentEstado === 'pagada') return c.json({ error: 'factura pagada no editable' }, 409);

  const b = await c.req.json().catch(() => null);
  const sets: string[] = [];
  const vals: unknown[] = [];

  if (b?.estado != null) {
    if (!ESTADOS.includes(b.estado)) return c.json({ error: 'estado inválido' }, 400);
    if (!(TRANSITIONS[currentEstado] ?? []).includes(b.estado)) {
      return c.json({ error: `transición ${currentEstado}→${b.estado} no permitida` }, 409);
    }
    sets.push('estado = ?'); vals.push(b.estado);
  }
  if (b?.cuenta_id !== undefined) {
    const cid = str(b.cuenta_id, 40);
    if (cid) {
      const cta = await c.env.DB.prepare(`SELECT id FROM sum_cuentas WHERE id = ?`).bind(cid).first();
      if (!cta) return c.json({ error: 'cuenta no encontrada' }, 404);
    }
    sets.push('cuenta_id = ?'); vals.push(cid);
  }
  if (b?.referencia !== undefined)     { sets.push('referencia = ?');     vals.push(str(b.referencia, 200)); }
  if (b?.vencimiento_ms !== undefined) { sets.push('vencimiento_ms = ?'); vals.push(num(b.vencimiento_ms)); }
  if (b?.nota !== undefined)           { sets.push('nota = ?');           vals.push(str(b.nota, 1000)); }

  if (!sets.length) return c.json({ error: 'nada que actualizar' }, 400);
  sets.push('updated_ms = ?'); vals.push(Date.now());
  vals.push(id);
  await c.env.DB.prepare(`UPDATE sum_facturas SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  const row = await c.env.DB.prepare(`SELECT * FROM sum_facturas WHERE id = ?`).bind(id).first();
  return c.json(row);
});

// DELETE /:id → only when estado ≠ 'pagada'; deletes líneas then factura.
sumFacturas.delete('/:id', async (c) => {
  const id  = c.req.param('id');
  const fac = await c.env.DB.prepare(`SELECT estado FROM sum_facturas WHERE id = ?`).bind(id).first();
  if (!fac) return c.json({ error: 'no encontrado' }, 404);
  if (String(fac.estado) === 'pagada') return c.json({ error: 'factura pagada no eliminable' }, 409);
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM sum_factura_lineas WHERE factura_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM sum_facturas WHERE id = ?`).bind(id),
  ]);
  return c.json({ ok: true, id });
});
