import type { Env } from '../types';

// Withdrawals domain helpers. No real licensed payout provider is integrated, so
// every rail is manual: requests are created pending_review and an operator
// advances them — we never fake a completion or promise instant settlement.

export const WITHDRAWAL_METHODS = ['usdc', 'stripe', 'pago_movil', 'bank', 'cash'] as const;
export type WithdrawalMethod = (typeof WITHDRAWAL_METHODS)[number];

export const WITHDRAWAL_STATUSES = [
  'draft', 'pending_review', 'processing', 'completed', 'failed', 'rejected', 'cancelled',
] as const;

// Statuses that "hold" money against the available balance (so it can't be
// double-withdrawn). draft/failed/rejected/cancelled release it.
export const HOLDING_STATUSES = ['pending_review', 'processing', 'completed'];

export const PER_TX_MAX_USD = 5000;     // single withdrawal ceiling
export const DAILY_MAX_USD = 5000;      // rolling 24h ceiling
export const MIN_WITHDRAWAL_USD = 1;

const last4 = (s: string) => (s || '').replace(/\s+/g, '').slice(-4);
const maskMiddle = (s: string) => (s && s.length > 10 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);

/** Available USD balance = settled x402 received minus money held by non-terminal withdrawals. */
export async function computeBalance(env: Env, userId: string) {
  const recv: any = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount_usd),0) AS usd FROM x402_payments WHERE payee_user_id = ? AND status = 'settled'`
  ).bind(userId).first();
  const held: any = await env.DB.prepare(
    `SELECT COALESCE(SUM(net_amount),0) AS usd FROM withdrawal_requests
      WHERE user_id = ? AND status IN ('pending_review','processing','completed')`
  ).bind(userId).first();
  const gross = Number(recv?.usd) || 0;
  const committed = Number(held?.usd) || 0;
  const available = Math.round((gross - committed) * 100) / 100;
  return { gross_received_usd: gross, committed_usd: committed, available_usd: Math.max(0, available) };
}

/** Sum of net amounts requested in the last 24h (for the daily limit). */
export async function withdrawnLast24h(env: Env, userId: string, now: number) {
  const row: any = await env.DB.prepare(
    `SELECT COALESCE(SUM(net_amount),0) AS usd FROM withdrawal_requests
      WHERE user_id = ? AND created_ms >= ? AND status NOT IN ('failed','rejected','cancelled','draft')`
  ).bind(userId, now - 86_400_000).first();
  return Number(row?.usd) || 0;
}

/** Build a masked destination summary + redacted detail blob. NEVER stores raw
 *  secrets — phone/cédula/account are masked to the last 4. */
export function maskDestination(type: WithdrawalMethod, raw: Record<string, unknown>): { summary: string; redacted: Record<string, unknown> } {
  const s = (k: string) => (raw[k] == null ? '' : String(raw[k]).trim());
  switch (type) {
    case 'pago_movil': {
      const red = { bank_name: s('bank_name'), bank_code: s('bank_code'), phone_last4: last4(s('phone')), id_last4: last4(s('id_number')), holder_name: s('holder_name') };
      return { summary: `Pago Móvil ${red.bank_name || ''} ****${red.phone_last4}`.trim(), redacted: red };
    }
    case 'bank': {
      const red = { bank_name: s('bank_name'), account_last4: last4(s('account_number')), holder_name: s('holder_name') };
      return { summary: `${red.bank_name || 'Banco'} ****${red.account_last4}`, redacted: red };
    }
    case 'usdc': {
      const addr = s('address');
      return { summary: `USDC ${maskMiddle(addr)}`, redacted: { address_masked: maskMiddle(addr) } };
    }
    case 'stripe':
      return { summary: 'Stripe (próximamente)', redacted: {} };
    case 'cash':
    default:
      return { summary: 'Asistencia manual', redacted: { note: s('note').slice(0, 120) } };
  }
}

/** Simple risk score 0-100. Manual rails + larger amounts score higher. */
export function riskScore(type: WithdrawalMethod, amountUsd: number): number {
  let r = 0;
  if (type === 'pago_movil' || type === 'bank' || type === 'cash') r += 40; // off-platform manual
  if (amountUsd >= 1000) r += 30;
  else if (amountUsd >= 250) r += 15;
  return Math.min(100, r);
}
