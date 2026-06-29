import { Hono } from 'hono';
import type { Env } from '../types';
import { isX402Live } from '../lib/x402';

// SUMINISTROS — Pagos ledger. The finance view over supplier invoices and their
// x402 payment links / on-chain settlements. Read-only. Mounted at
// /api/suministros/pagos; GET is gated suministros:read by the central policy.

export const sumPagos = new Hono<{ Bindings: Env }>();

const num = (v: unknown) => (v == null || v === '' ? 0 : Number(v) || 0);

// GET / → invoice payment ledger + summary.
//   ?estado= (borrador|emitida|pagada|anulada)  ?proveedor_id=  ?limit (default 200)
sumPagos.get('/', async (c) => {
  const estado      = c.req.query('estado');
  const proveedorId = c.req.query('proveedor_id');
  let limit = Number(c.req.query('limit'));
  if (!Number.isFinite(limit) || limit <= 0) limit = 200;
  limit = Math.min(limit, 1000);

  const where: string[] = [];
  const vals: unknown[] = [];
  if (estado && ['borrador', 'emitida', 'pagada', 'anulada'].includes(estado)) { where.push('f.estado = ?'); vals.push(estado); }
  if (proveedorId) { where.push('f.proveedor_id = ?'); vals.push(proveedorId); }

  // One row per invoice with its resolved payee + x402 link + settled totals.
  const ledgerSql = `
    SELECT f.id, f.codigo, f.estado, f.moneda, f.monto_total, f.fecha_ms, f.vencimiento_ms,
           f.pagada_ms, f.x402_resource_id, f.x402_slug,
           prv.nombre AS proveedor_nombre,
           COALESCE(f.payee_user_id, prv.payee_user_id) AS payee_user_id,
           u.name         AS payee_name,
           u.x402_enabled AS payee_x402_enabled,
           COALESCE(u.x402_pay_to, u.wallet_address) AS payee_wallet,
           (SELECT COUNT(*) FROM x402_payments xp
             WHERE xp.resource_id = f.x402_resource_id AND xp.status = 'settled') AS settled_count,
           (SELECT COALESCE(SUM(xp.amount_usd), 0) FROM x402_payments xp
             WHERE xp.resource_id = f.x402_resource_id AND xp.status = 'settled') AS settled_usd,
           (SELECT xp.tx_hash FROM x402_payments xp
             WHERE xp.resource_id = f.x402_resource_id AND xp.status = 'settled'
             ORDER BY xp.settled_ms DESC LIMIT 1) AS last_tx_hash,
           (SELECT xp.settled_ms FROM x402_payments xp
             WHERE xp.resource_id = f.x402_resource_id AND xp.status = 'settled'
             ORDER BY xp.settled_ms DESC LIMIT 1) AS last_settled_ms
    FROM sum_facturas f
    LEFT JOIN sum_proveedores prv ON prv.id = f.proveedor_id
    LEFT JOIN users u ON u.id = COALESCE(f.payee_user_id, prv.payee_user_id)
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY f.created_ms DESC LIMIT ?`;

  // Summary aggregates (counts + USD totals over USD-denominated invoices).
  const summarySql = `
    SELECT
      COUNT(*) AS facturas_total,
      SUM(CASE WHEN estado IN ('borrador','emitida') THEN 1 ELSE 0 END) AS pendientes,
      SUM(CASE WHEN estado = 'pagada' THEN 1 ELSE 0 END) AS pagadas,
      COALESCE(SUM(CASE WHEN estado IN ('borrador','emitida') AND moneda = 'USD' THEN monto_total ELSE 0 END), 0) AS monto_pendiente_usd,
      COALESCE(SUM(CASE WHEN estado = 'pagada' AND moneda = 'USD' THEN monto_total ELSE 0 END), 0) AS monto_pagado_usd
    FROM sum_facturas`;

  // Recent on-chain settlements tied to invoices.
  const settlementsSql = `
    SELECT f.id AS factura_id, f.codigo, xp.amount_usd, xp.tx_hash, xp.payer,
           xp.network, xp.settled_ms
    FROM x402_payments xp
    JOIN sum_facturas f ON f.x402_resource_id = xp.resource_id
    WHERE xp.status = 'settled'
    ORDER BY xp.settled_ms DESC LIMIT 100`;

  const [ledger, summary, settlements] = await Promise.all([
    c.env.DB.prepare(ledgerSql).bind(...vals, limit).all(),
    c.env.DB.prepare(summarySql).first<any>(),
    c.env.DB.prepare(settlementsSql).all(),
  ]);

  return c.json({
    x402_live: isX402Live(c.env),
    summary: {
      facturas_total: num(summary?.facturas_total),
      pendientes: num(summary?.pendientes),
      pagadas: num(summary?.pagadas),
      monto_pendiente_usd: num(summary?.monto_pendiente_usd),
      monto_pagado_usd: num(summary?.monto_pagado_usd),
      settlements: settlements.results ?? [],
    },
    facturas: ledger.results ?? [],
  });
});
