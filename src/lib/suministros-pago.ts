import type { Env } from '../types';
import { uid } from './db';
import { isX402Live, x402Network, x402Asset } from './x402';

// SUMINISTROS ↔ x402 bridge. A supplier invoice (sum_facturas) is paid by
// minting an x402 payment link against a SISMO911 user's receive wallet
// (x402_resources kind='invoice'), reusing the exact production x402 stack
// (verify+settle on Base). No new payment infrastructure.
//
// payee resolution: factura.payee_user_id ?? proveedor.payee_user_id → users row.

export interface FacturaRow {
  id: string;
  codigo: string;
  proveedor_id: string;
  estado: string;
  moneda: string;
  monto_total: number;
  vencimiento_ms: number | null;
  payee_user_id: string | null;
  x402_resource_id: string | null;
  x402_slug: string | null;
}

export interface PayeeUser {
  id: string;
  name: string | null;
  x402_enabled: number;
  x402_pay_to: string | null;
  wallet_address: string | null;
  x402_network: string | null;
  x402_asset: string | null;
}

/** lower(codigo) → public pay-path slug (matches the x402 slug grammar). */
export function invoiceSlug(codigo: string): string {
  return String(codigo).trim().toLowerCase();
}

/** The public x402 pay URL for an invoice link. */
export function payUrlFor(payeeUserId: string, slug: string): string {
  return `/api/x402/pay/${payeeUserId}/${slug}`;
}

/** Resolve the user whose wallet receives payment for this invoice.
 *  Order: the invoice's own payee_user_id, else the proveedor's. */
export async function resolveInvoicePayee(env: Env, fac: FacturaRow): Promise<PayeeUser | null> {
  let payeeId = fac.payee_user_id;
  if (!payeeId) {
    const prov: any = await env.DB.prepare(
      `SELECT payee_user_id FROM sum_proveedores WHERE id = ?`
    ).bind(fac.proveedor_id).first();
    payeeId = prov?.payee_user_id ?? null;
  }
  if (!payeeId) return null;
  const u = await env.DB.prepare(
    `SELECT id, name, x402_enabled, x402_pay_to, wallet_address, x402_network, x402_asset
       FROM users WHERE id = ?`
  ).bind(payeeId).first<PayeeUser>();
  return u ?? null;
}

export type LinkError = 'no_payee' | 'recipient_not_receiving' | 'payments_unavailable' | 'invalid_amount';

export interface PayLinkResult {
  resourceId: string;
  slug: string;
  payUrl: string;
  amount_usd: number;
  payee: PayeeUser;
  proveedorNombre: string | null;
}

/**
 * Idempotently UPSERT the x402_resources invoice row for a factura and stamp the
 * resource id + slug back onto the factura. Returns the pay-link, or a typed
 * error reason when payment can't be offered (no payee, payee not receiving, or
 * the platform x402 gate is off). Mirrors the canonical resource upsert
 * (price-version bump + immutable price history) so receipts stay pinned.
 */
export async function ensureInvoicePayLink(
  env: Env,
  fac: FacturaRow,
): Promise<{ ok: true; data: PayLinkResult } | { ok: false; reason: LinkError }> {
  if (!isX402Live(env)) return { ok: false, reason: 'payments_unavailable' };

  const payee = await resolveInvoicePayee(env, fac);
  if (!payee) return { ok: false, reason: 'no_payee' };
  const payTo = payee.x402_pay_to || payee.wallet_address;
  if (!payee.x402_enabled || !payTo) return { ok: false, reason: 'recipient_not_receiving' };

  const price = Number(fac.monto_total);
  if (!(price >= 0) || !isFinite(price)) return { ok: false, reason: 'invalid_amount' };

  const prov: any = await env.DB.prepare(
    `SELECT nombre FROM sum_proveedores WHERE id = ?`
  ).bind(fac.proveedor_id).first();
  const proveedorNombre: string | null = prov?.nombre ?? null;

  const slug = invoiceSlug(fac.codigo);
  const title = `Factura ${fac.codigo}`;
  const description = proveedorNombre ? `Factura ${fac.codigo} — ${proveedorNombre}` : `Factura ${fac.codigo}`;
  const now = Date.now();

  // Atomic upsert keyed on (user_id, slug). `excluded.*` references the would-be
  // inserted values, so each param is bound exactly once (portable across D1 +
  // better-sqlite3). Bump price_version ONLY when the amount changes; keep an
  // already-'pagada' invoice marked paid.
  const row: any = await env.DB.prepare(
    `INSERT INTO x402_resources
       (id, user_id, slug, title, description, price_usd, mime_type, active, kind,
        client_name, invoice_status, due_ms, created_ms, updated_ms)
     VALUES (?, ?, ?, ?, ?, ?, 'application/json', 1, 'invoice', ?, 'pendiente', ?, ?, ?)
     ON CONFLICT(user_id, slug) DO UPDATE SET
       title = excluded.title,
       description = excluded.description,
       price_version = price_version + (price_usd <> excluded.price_usd),
       price_usd = excluded.price_usd,
       active = 1, kind = 'invoice',
       client_name = excluded.client_name,
       due_ms = excluded.due_ms,
       invoice_status = CASE WHEN invoice_status = 'pagada' THEN 'pagada' ELSE 'pendiente' END,
       updated_ms = excluded.updated_ms
     RETURNING id, price_version`
  ).bind(uid('res'), payee.id, slug, title, description, price, proveedorNombre, fac.vencimiento_ms ?? null, now, now).first();

  const resourceId = row.id as string;
  const version = Number(row.price_version);
  // Append to the immutable price history (idempotent on (resource, version)).
  await env.DB.prepare(
    `INSERT OR IGNORE INTO x402_resource_prices (id, resource_id, version, price_usd, created_ms) VALUES (?,?,?,?,?)`
  ).bind(uid('rpx'), resourceId, version, price, now).run();

  // Stamp the link back on the factura.
  await env.DB.prepare(
    `UPDATE sum_facturas SET x402_resource_id = ?, x402_slug = ?, updated_ms = ? WHERE id = ?`
  ).bind(resourceId, slug, now, fac.id).run();

  return {
    ok: true,
    data: { resourceId, slug, payUrl: payUrlFor(payee.id, slug), amount_usd: price, payee, proveedorNombre },
  };
}

/** Latest settled x402 payment against an invoice's resource, or null. */
export async function invoiceSettlement(env: Env, resourceId: string | null): Promise<
  { tx_hash: string | null; payer: string | null; settled_ms: number | null; amount_usd: number | null; network: string | null } | null
> {
  if (!resourceId) return null;
  const row: any = await env.DB.prepare(
    `SELECT tx_hash, payer, settled_ms, amount_usd, network
       FROM x402_payments
      WHERE resource_id = ? AND status = 'settled'
      ORDER BY settled_ms DESC LIMIT 1`
  ).bind(resourceId).first();
  return row ?? null;
}
