import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { x402Network, x402Asset, isX402Live } from '../lib/x402';
import {
  ensureInvoicePayLink, resolveInvoicePayee, invoiceSettlement, payUrlFor,
  type FacturaRow, type LinkError,
} from '../lib/suministros-pago';

// SUMINISTROS — Facturas de compra con líneas (invoice + GL ledger).
// Tables: sum_facturas, sum_factura_lineas.
// Mounted at /api/suministros/facturas. Writes gated centrally; GET public.

export const sumFacturas = new Hono<{ Bindings: Env }>();

const ESTADOS = ['borrador', 'emitida', 'pagada', 'anulada'];
const MONEDAS = ['USD', 'VES'];

// Valid estado transitions via PATCH. An operator MAY mark an emitida invoice
// 'pagada' manually (e.g. paid off-chain / by bank transfer); when they do we
// sync the linked x402 invoice resource to 'pagada' too (see PATCH handler).
const TRANSITIONS: Record<string, string[]> = {
  borrador: ['emitida', 'anulada'],
  emitida:  ['pagada', 'anulada'],
  anulada:  [],
};

// HTTP status + message for a pay-link error reason.
const LINK_ERRORS: Record<LinkError, { status: 409; msg: string }> = {
  no_payee:                { status: 409, msg: 'el proveedor (o la factura) no tiene un payee_user_id con wallet x402' },
  recipient_not_receiving: { status: 409, msg: 'el payee no tiene x402 activado ni una wallet de cobro' },
  payments_unavailable:    { status: 409, msg: 'los pagos x402 no están habilitados en este entorno' },
  invalid_amount:          { status: 409, msg: 'el monto_total de la factura no es válido para cobro' },
};

const FAC_COLS =
  `id, codigo, proveedor_id, estado, moneda, monto_total, vencimiento_ms,
   payee_user_id, x402_resource_id, x402_slug`;

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

  // Optional per-invoice payee override (else falls back to the proveedor's).
  const payeeId = str(b?.payee_user_id, 40);
  if (payeeId) {
    const u = await c.env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(payeeId).first();
    if (!u) return c.json({ error: 'payee_user_id no encontrado' }, 404);
  }

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
        fecha_ms, vencimiento_ms, referencia, nota, payee_user_id, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, codigo, proveedorId,
    str(b?.orden_id, 40) ?? null,
    cuentaId, 'borrador', moneda, montoTotal,
    num(b?.fecha_ms) ?? now,
    num(b?.vencimiento_ms) ?? null,
    str(b?.referencia, 200) ?? null,
    str(b?.nota, 1000) ?? null,
    payeeId ?? null,
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

// POST /:id/generar-enlace-pago → mint (or refresh) the x402 invoice pay-link
// for this factura. Resolves the payee (factura→proveedor), validates x402
// receive config, upserts the x402 resource, stamps it back on the factura.
// Registered before /:id so the static segment wins.
sumFacturas.post('/:id/generar-enlace-pago', async (c) => {
  const id  = c.req.param('id');
  const fac = await c.env.DB.prepare(`SELECT ${FAC_COLS} FROM sum_facturas WHERE id = ?`).bind(id).first<FacturaRow>();
  if (!fac) return c.json({ error: 'no encontrado' }, 404);
  if (fac.estado === 'anulada') return c.json({ error: 'factura anulada no se puede cobrar' }, 409);

  const r = await ensureInvoicePayLink(c.env, fac);
  if (!r.ok) {
    const e = LINK_ERRORS[r.reason];
    return c.json({ error: r.reason, detail: e.msg }, e.status);
  }
  return c.json({
    ok: true,
    payUrl: r.data.payUrl,
    resourceId: r.data.resourceId,
    slug: r.data.slug,
    amount_usd: r.data.amount_usd,
  });
});

// POST /:id/pagar → return x402 PAYMENT REQUIREMENTS for this invoice (Option A).
// Does NOT flip estado — payment settles on-chain via the x402 pay endpoint, or
// an operator marks it 'pagada' manually via PATCH. Auto-generates the pay-link
// if one doesn't exist yet. Registered before /:id.
sumFacturas.post('/:id/pagar', async (c) => {
  const id  = c.req.param('id');
  const fac = await c.env.DB.prepare(`SELECT ${FAC_COLS} FROM sum_facturas WHERE id = ?`).bind(id).first<FacturaRow>();
  if (!fac) return c.json({ error: 'no encontrado' }, 404);
  if (fac.estado === 'anulada') return c.json({ error: 'factura anulada no se puede cobrar' }, 409);

  // Ensure (or refresh) the pay-link. A failure here means we cannot offer payment.
  const link = await ensureInvoicePayLink(c.env, fac);
  if (!link.ok) {
    const e = LINK_ERRORS[link.reason];
    return c.json({ error: link.reason, detail: e.msg }, e.status);
  }
  const { resourceId, slug, payUrl, amount_usd, payee } = link.data;
  const payTo = payee.x402_pay_to || payee.wallet_address;
  const network = payee.x402_network || x402Network(c.env);
  const asset = payee.x402_asset || x402Asset(c.env, network);

  const settlement = await invoiceSettlement(c.env, resourceId);
  const status = settlement ? 'settled' : (fac.estado === 'pagada' ? 'already_paid' : 'payment_required');

  return c.json({
    status,
    payment: {
      resourceId, slug, payUrl, amount_usd,
      payee_name: payee.name ?? null,
      payee_wallet: payTo,
      x402_network: network,
      x402_asset: asset,
    },
    receipt: settlement
      ? { tx_hash: settlement.tx_hash, payer: settlement.payer, settled_ms: settlement.settled_ms }
      : null,
  });
});

// GET /:id → factura + lineas + pago block (payee_*, x402 link, live settlement).
sumFacturas.get('/:id', async (c) => {
  const id      = c.req.param('id');
  const factura: any = await c.env.DB.prepare(
    `SELECT f.*,
            prv.nombre     AS proveedor_nombre,
            COALESCE(f.payee_user_id, prv.payee_user_id) AS resolved_payee_user_id,
            u.name         AS payee_name,
            u.x402_enabled AS payee_x402_enabled,
            COALESCE(u.x402_pay_to, u.wallet_address) AS payee_wallet
     FROM sum_facturas f
     LEFT JOIN sum_proveedores prv ON prv.id = f.proveedor_id
     LEFT JOIN users u ON u.id = COALESCE(f.payee_user_id, prv.payee_user_id)
     WHERE f.id = ?`
  ).bind(id).first();
  if (!factura) return c.json({ error: 'no encontrado' }, 404);
  const { results: lineas } = await c.env.DB.prepare(
    `SELECT fl.*, p.nombre AS producto_nombre, p.codigo AS producto_codigo
     FROM sum_factura_lineas fl
     LEFT JOIN sum_productos p ON p.id = fl.producto_id
     WHERE fl.factura_id = ?
     ORDER BY fl.rowid`
  ).bind(id).all();

  const settlement = await invoiceSettlement(c.env, factura.x402_resource_id);
  const pago = {
    x402_resource_id: factura.x402_resource_id ?? null,
    x402_slug: factura.x402_slug ?? null,
    payUrl: (factura.resolved_payee_user_id && factura.x402_slug)
      ? payUrlFor(factura.resolved_payee_user_id, factura.x402_slug) : null,
    x402_live: isX402Live(c.env),
    payee: {
      user_id: factura.resolved_payee_user_id ?? null,
      name: factura.payee_name ?? null,
      x402_enabled: factura.payee_x402_enabled ?? null,
      wallet: factura.payee_wallet ?? null,
    },
    settlement: settlement
      ? { tx_hash: settlement.tx_hash, payer: settlement.payer, settled_ms: settlement.settled_ms, amount_usd: settlement.amount_usd }
      : null,
  };
  return c.json({ factura, lineas: lineas ?? [], pago });
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
  const now = Date.now();
  let markingPaid = false;

  if (b?.estado != null) {
    if (!ESTADOS.includes(b.estado)) return c.json({ error: 'estado inválido' }, 400);
    if (!(TRANSITIONS[currentEstado] ?? []).includes(b.estado)) {
      return c.json({ error: `transición ${currentEstado}→${b.estado} no permitida` }, 409);
    }
    sets.push('estado = ?'); vals.push(b.estado);
    // Operator marks an invoice paid manually (off-chain / bank transfer). Stamp
    // pagada_ms and sync the linked x402 resource below.
    if (b.estado === 'pagada') { markingPaid = true; sets.push('pagada_ms = ?'); vals.push(now); }
  }
  if (b?.cuenta_id !== undefined) {
    const cid = str(b.cuenta_id, 40);
    if (cid) {
      const cta = await c.env.DB.prepare(`SELECT id FROM sum_cuentas WHERE id = ?`).bind(cid).first();
      if (!cta) return c.json({ error: 'cuenta no encontrada' }, 404);
    }
    sets.push('cuenta_id = ?'); vals.push(cid);
  }
  if (b?.payee_user_id !== undefined) {
    const pid = str(b.payee_user_id, 40);
    if (pid) {
      const u = await c.env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(pid).first();
      if (!u) return c.json({ error: 'payee_user_id no encontrado' }, 404);
    }
    sets.push('payee_user_id = ?'); vals.push(pid);
  }
  if (b?.referencia !== undefined)     { sets.push('referencia = ?');     vals.push(str(b.referencia, 200)); }
  if (b?.vencimiento_ms !== undefined) { sets.push('vencimiento_ms = ?'); vals.push(num(b.vencimiento_ms)); }
  if (b?.nota !== undefined)           { sets.push('nota = ?');           vals.push(str(b.nota, 1000)); }

  if (!sets.length) return c.json({ error: 'nada que actualizar' }, 400);
  sets.push('updated_ms = ?'); vals.push(now);
  vals.push(id);
  await c.env.DB.prepare(`UPDATE sum_facturas SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();

  // Keep the linked x402 invoice resource in sync when marked paid manually.
  if (markingPaid) {
    const resId = await c.env.DB.prepare(`SELECT x402_resource_id FROM sum_facturas WHERE id = ?`).bind(id).first<{ x402_resource_id: string | null }>();
    if (resId?.x402_resource_id) {
      await c.env.DB.prepare(
        `UPDATE x402_resources SET invoice_status = 'pagada', paid_ms = ?, updated_ms = ? WHERE id = ?`
      ).bind(now, now, resId.x402_resource_id).run();
    }
  }

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
