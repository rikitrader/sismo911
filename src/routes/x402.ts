import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { getUserFromRequest } from '../lib/auth';
import { audit } from '../lib/audit';
import { notify } from '../lib/notify';
import { sendEmail, paymentReceivedEmail } from '../lib/email';
import { burstLimit, subjectLimit } from '../lib/security';
import { authorize } from '../rbac/middleware';
import { LEGACY_OPS_PERM } from '../rbac/route-policy';
import {
  buildRequirements, paymentRequiredBody, encodePaymentRequired, encodeJsonB64,
  readPaymentPayload, verifyPayment, settlePayment, isX402Configured, isX402Live,
  x402Network, x402Asset, usdToAtomic, chainIdFromNetwork,
  extractAuthorization, validateAuthorization, authorizationHash, facilitatorReachable,
} from '../lib/x402';

// x402 payment-receiving routes (https://github.com/xpaysh/awesome-x402).
// Mounted at /api/x402. The discovery doc is served at /.well-known/x402.json
// from index.ts via `wellKnownX402`.
export const x402 = new Hono<{ Bindings: Env }>();

const slugOk = (s: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(s);

// Extract the EIP-712 signature from a payment payload (or a stored payload_json
// string). Used to prove an idempotent/replay re-request comes from the original
// payer before disclosing a receipt.
function sigOf(p: any): string {
  try {
    const o = typeof p === 'string' ? JSON.parse(p) : p;
    return String(o?.payload?.signature ?? o?.signature ?? '');
  } catch { return ''; }
}

// Shape a settled/known payment row into the payer-facing receipt (+ PAYMENT-RESPONSE
// header). Used for both fresh settlements and idempotent/replay re-requests.
function receipt(c: any, row: any, opts: { idempotent?: boolean } = {}) {
  if (row.status === 'settled') {
    c.header('PAYMENT-RESPONSE', encodeJsonB64({ transaction: row.tx_hash, network: row.network, payer: row.payer }));
  }
  return c.json({
    ok: row.status === 'settled',
    paid: row.status === 'settled',
    idempotent: Boolean(opts.idempotent),
    status: row.status,
    payment: {
      id: row.id, amount_usd: row.amount_usd, network: row.network, asset: row.asset,
      payTo: row.pay_to, payer: row.payer, tx: row.tx_hash,
    },
  }, row.status === 'settled' ? 200 : 402);
}

// GET /api/x402/me — the caller's receive configuration + lifetime totals.
x402.get('/me', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const row: any = await c.env.DB.prepare(
    `SELECT wallet_address, x402_enabled, x402_pay_to, x402_network, x402_asset, x402_enabled_ms FROM users WHERE id = ?`
  ).bind(me.id).first();
  const network = row?.x402_network || x402Network(c.env);
  const totals: any = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount_usd),0) AS usd
       FROM x402_payments WHERE payee_user_id = ? AND status = 'settled'`
  ).bind(me.id).first();
  const registered = Boolean(row?.x402_enabled);
  return c.json({
    ok: true,
    x402: {
      // "registered" = this wallet opted in as a receiver; "live" = the platform
      // can actually settle right now (Fix 2). Effective acceptance needs both.
      registered,
      live: registered && isX402Live(c.env),
      payTo: row?.x402_pay_to || row?.wallet_address || null,
      network,
      asset: row?.x402_asset || x402Asset(c.env, network),
      facilitatorConfigured: isX402Configured(c.env),
      enabledAt: row?.x402_enabled_ms || null,
    },
    received: { count: totals?.n ?? 0, usd: totals?.usd ?? 0 },
  });
});

// GET /api/x402/resources — the caller's priced resources.
x402.get('/resources', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const { results } = await c.env.DB.prepare(
    `SELECT id, slug, title, description, price_usd, price_version, mime_type, active, created_ms, updated_ms
       FROM x402_resources WHERE user_id = ? ORDER BY created_ms DESC`
  ).bind(me.id).all();
  return c.json({ ok: true, resources: results ?? [] });
});

// POST /api/x402/resources — create or update one of the caller's priced resources.
// Fix 5: prices are versioned, not silently overwritten — a price change bumps
// price_version and appends to x402_resource_prices, so historical receipts keep
// referencing the exact version/amount they were charged.
x402.post('/resources', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const b = await c.req.json().catch(() => null);
  const slug = (b?.slug || '').trim().toLowerCase();
  const title = (b?.title || '').trim();
  const price = Number(b?.price_usd);
  if (!slugOk(slug)) return c.json({ error: 'slug_invalid' }, 400);
  if (!title) return c.json({ error: 'title_required' }, 400);
  if (!(price >= 0) || !isFinite(price)) return c.json({ error: 'price_invalid' }, 400);
  const now = Date.now();
  const mime = (b?.mime_type || 'application/json').trim();
  const active = b?.active === false ? 0 : 1;

  // Atomic upsert (fixes the create-create race + the read-then-write price-version
  // desync): bump price_version ONLY when the price actually changes, evaluated
  // against the pre-update row inside a single statement. RETURNING gives us the
  // resolved id + version in one round-trip.
  const row: any = await c.env.DB.prepare(
    `INSERT INTO x402_resources (id, user_id, slug, title, description, price_usd, price_version, mime_type, active, created_ms, updated_ms)
     VALUES (?1,?2,?3,?4,?5,?6,1,?7,?8,?9,?9)
     ON CONFLICT(user_id, slug) DO UPDATE SET
       title=?4, description=?5,
       price_version = price_version + (price_usd <> ?6),
       price_usd=?6, mime_type=?7, active=?8, updated_ms=?9
     RETURNING id, price_version`
  ).bind(uid('res'), me.id, slug, title, b?.description ?? null, price, mime, active, now).first();
  const resId = row.id as string;
  const version = Number(row.price_version);
  // Append to the immutable price history (idempotent on (resource, version)).
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO x402_resource_prices (id, resource_id, version, price_usd, created_ms) VALUES (?,?,?,?,?)`
  ).bind(uid('rpx'), resId, version, price, now).run();

  await audit(c, 'x402.resource.upsert', { user_id: me.id, slug, price_version: version });
  const payUrl = new URL(`/api/x402/pay/${me.id}/${slug}`, c.req.url).toString();
  return c.json({ ok: true, resource: { slug, title, price_usd: price, price_version: version, active: Boolean(active) }, payUrl });
});

// GET /api/x402/payments — the caller's received-payments ledger.
x402.get('/payments', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const { results } = await c.env.DB.prepare(
    `SELECT id, resource_url, description, amount, amount_usd, network, chain_id, asset, pay_to, payer,
            status, tx_hash, authorization_hash, invalid_reason, created_ms, verified_ms, settled_ms
       FROM x402_payments WHERE payee_user_id = ? ORDER BY created_ms DESC LIMIT 200`
  ).bind(me.id).all();
  return c.json({ ok: true, payments: results ?? [] });
});

// GET /api/x402/health — operator-only operational health (Fix 8 / milestone #2).
// Validates config and probes facilitator connectivity. Never leaks the facilitator URL.
x402.get('/health', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!(await authorize(c.env, me, LEGACY_OPS_PERM))) return c.json({ error: me ? 'forbidden' : 'unauthorized' }, me ? 403 : 401);
  const configured = isX402Configured(c.env);
  const live = isX402Live(c.env);
  const reachable = configured ? await facilitatorReachable(c.env) : null;
  const network = x402Network(c.env);
  return c.json({
    ok: true,
    status: live ? (reachable ? 'live' : 'degraded') : 'disabled',
    facilitatorConfigured: configured,   // boolean only — URL never exposed
    facilitatorReachable: reachable,
    paymentsEnabledFlag: /^(1|true|yes|on)$/i.test(String(c.env.X402_PAYMENTS_ENABLED ?? '').trim()),
    live,
    network,
    chainId: chainIdFromNetwork(network),
    asset: x402Asset(c.env, network),
  });
});

// GET /api/x402/admin/reconcile — operator reconciliation across ALL users
// (milestone #4 data layer): status counts + recent rows with tx hashes.
x402.get('/admin/reconcile', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!(await authorize(c.env, me, LEGACY_OPS_PERM))) return c.json({ error: me ? 'forbidden' : 'unauthorized' }, me ? 403 : 401);
  const counts = await c.env.DB.prepare(
    `SELECT status, COUNT(*) AS n, COALESCE(SUM(amount_usd),0) AS usd FROM x402_payments GROUP BY status`
  ).all();
  const recent = await c.env.DB.prepare(
    `SELECT id, payee_user_id, status, amount_usd, network, chain_id, asset, pay_to, payer, tx_hash,
            authorization_hash, invalid_reason, created_ms, verified_ms, settled_ms
       FROM x402_payments ORDER BY created_ms DESC LIMIT 100`
  ).all();
  return c.json({ ok: true, counts: counts.results ?? [], recent: recent.results ?? [] });
});

// ALL /api/x402/pay/:userId/:slug — the receive flow (public; payer needs no account).
//   • payments not live  → 503 (Fix 1/2: never advertise a 402 we can't settle)
//   • no payment header  → 402 + PAYMENT-REQUIRED (signed authorization requested)
//   • with header        → validate → verify → settle → 200 + PAYMENT-RESPONSE
x402.all('/pay/:userId/:slug', async (c) => {
  // Fix 7: per-IP burst on the pay endpoint.
  const ipLimited = await burstLimit(c.env, c, 'x402_pay_ip', 30, 60);
  if (ipLimited) return ipLimited;
  const { userId, slug } = c.req.param();

  const res: any = await c.env.DB.prepare(
    `SELECT r.id AS resource_id, r.title, r.description, r.price_usd, r.price_version, r.mime_type, r.active,
            u.id AS payee_user_id, u.x402_enabled, u.x402_pay_to, u.wallet_address, u.x402_network, u.x402_asset
       FROM x402_resources r JOIN users u ON u.id = r.user_id
      WHERE r.user_id = ? AND r.slug = ?`
  ).bind(userId, slug).first();

  if (!res || !res.active) return c.json({ error: 'resource_not_found' }, 404);
  const payTo = res.x402_pay_to || res.wallet_address;
  if (!res.x402_enabled || !payTo) return c.json({ error: 'recipient_not_receiving' }, 503);

  // Fix 1/2: do not advertise payment capability we cannot settle.
  if (!isX402Live(c.env)) return c.json({ error: 'payments_unavailable' }, 503);

  const network = res.x402_network || x402Network(c.env);
  const asset = res.x402_asset || x402Asset(c.env, network);
  const chainId = chainIdFromNetwork(network);
  const amount = usdToAtomic(Number(res.price_usd));
  const requirements = buildRequirements(c.env, { payTo, amount, network, asset });
  const resourceUrl = c.req.url;

  const payload = readPaymentPayload((n) => c.req.header(n));

  // No payment yet → advertise requirements (don't write a ledger row for probes).
  if (!payload) {
    const body = paymentRequiredBody({
      requirements: [requirements], resourceUrl,
      description: res.description || res.title, mimeType: res.mime_type,
    });
    c.header('PAYMENT-REQUIRED', encodePaymentRequired(body));
    return c.json(body, 402);
  }

  // ── Settlement attempt ──
  // Fix 7 (#6): throttle the per-resource settlement path BEFORE the heavier
  // validate + DB lookups, so invalid/replay probes are bounded per resource.
  if (await subjectLimit(c.env, 'x402_pay_res', `${userId}:${slug}`, 60, 60)) return c.json({ error: 'rate_limited' }, 429);

  // Fix 6: validate the authorization ourselves before trusting the facilitator.
  const auth = extractAuthorization(payload);
  const incomingSig = sigOf(payload);
  const nowSec = Math.floor(Date.now() / 1000);
  const valid = validateAuthorization(auth, requirements, nowSec);
  if (!valid.ok) return c.json({ error: 'invalid_authorization', reason: valid.reason }, 402);
  const authHash = await authorizationHash(auth!, network, asset);

  if (auth!.from && await subjectLimit(c.env, 'x402_pay_wallet', auth!.from, 30, 60)) return c.json({ error: 'rate_limited' }, 429);
  if (await subjectLimit(c.env, 'x402_pay_auth', authHash, 5, 300)) return c.json({ error: 'rate_limited' }, 429);

  const idem = c.req.header('idempotency-key')?.trim() || null;

  // Find any existing row for this exact authorization (replay) or idempotency key.
  const existing: any = await c.env.DB.prepare(
    `SELECT * FROM x402_payments
      WHERE authorization_hash = ?1
         OR (idempotency_key IS NOT NULL AND idempotency_key = ?2 AND payee_user_id = ?3)
      LIMIT 1`
  ).bind(authHash, idem, res.payee_user_id).first();

  let id: string;
  if (existing) {
    if (existing.status === 'settled') {
      // Idempotent replay. Disclose the receipt ONLY to the original payer —
      // proven by the incoming signature matching the stored one (#2). An
      // unsigned probe of a known on-chain authorization gets no data.
      if (incomingSig && incomingSig === sigOf(existing.payload_json)) return receipt(c, existing, { idempotent: true });
      return c.json({ error: 'authorization_already_used' }, 409);
    }
    // Non-settled prior (failed transiently, or in-flight): the on-chain nonce is
    // NOT consumed, so re-attempt on the SAME row instead of bricking it (#1).
    id = existing.id;
    await c.env.DB.prepare(
      `UPDATE x402_payments SET status='required', invalid_reason=NULL,
              idempotency_key=COALESCE(idempotency_key, ?) WHERE id=?`
    ).bind(idem, id).run();
  } else {
    // Record a fresh attempt (Fix 4 ledger). The unique indexes on
    // authorization_hash + (payee, idempotency_key) close the concurrent race.
    id = uid('x4p');
    const now = Date.now();
    try {
      await c.env.DB.prepare(
        `INSERT INTO x402_payments
           (id, payee_user_id, resource_id, resource_url, description, scheme, network, chain_id, asset, amount, amount_usd,
            pay_to, payer, status, facilitator, payload_json, ip, authorization_hash, idempotency_key, resource_price_version, created_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(id, res.payee_user_id, res.resource_id, resourceUrl, res.description || res.title, 'exact',
             network, chainId, asset, amount, Number(res.price_usd), payTo, auth!.from ?? null, 'required',
             c.env.X402_FACILITATOR_URL || null, JSON.stringify(payload),
             c.req.header('cf-connecting-ip') || null, authHash, idem, res.price_version, now).run();
    } catch {
      // Lost the race to a concurrent settlement of the same authorization/key.
      const raced: any = await c.env.DB.prepare(
        `SELECT * FROM x402_payments WHERE authorization_hash = ?1
            OR (idempotency_key IS NOT NULL AND idempotency_key = ?2 AND payee_user_id = ?3) LIMIT 1`
      ).bind(authHash, idem, res.payee_user_id).first();
      if (raced?.status === 'settled' && incomingSig && incomingSig === sigOf(raced.payload_json)) {
        return receipt(c, raced, { idempotent: true });
      }
      return c.json({ error: 'payment_in_progress' }, 409);
    }
  }

  const v = await verifyPayment(c.env, payload, requirements);
  if (!v.isValid) {
    await c.env.DB.prepare(`UPDATE x402_payments SET status='failed', invalid_reason=?, payer=?, facilitator_response=? WHERE id=?`)
      .bind(v.invalidReason || 'invalid_payment', v.payer ?? auth!.from ?? null, JSON.stringify({ verify: v.raw }), id).run();
    const body = paymentRequiredBody({ requirements: [requirements], resourceUrl, description: res.description || res.title, mimeType: res.mime_type, error: v.invalidReason || 'invalid_payment' });
    c.header('PAYMENT-REQUIRED', encodePaymentRequired(body));
    return c.json(body, 402);
  }
  await c.env.DB.prepare(`UPDATE x402_payments SET status='verified', payer=?, verified_ms=? WHERE id=?`)
    .bind(v.payer ?? auth!.from ?? null, Date.now(), id).run();

  const s = await settlePayment(c.env, payload, requirements);
  const facResp = JSON.stringify({ verify: v.raw, settle: s.raw });
  if (!s.success) {
    await c.env.DB.prepare(`UPDATE x402_payments SET status='failed', invalid_reason=?, facilitator_response=? WHERE id=?`)
      .bind(s.errorReason || 'settlement_failed', facResp, id).run();
    return c.json({ error: 'settlement_failed', reason: s.errorReason }, 402);
  }
  await c.env.DB.prepare(`UPDATE x402_payments SET status='settled', tx_hash=?, settled_ms=?, facilitator_response=? WHERE id=?`)
    .bind(s.transactionHash ?? null, Date.now(), facResp, id).run();

  // Notify the PAYEE that they received a payment — controlled by their settings:
  // sec_receipt_notifs (in-app bell notification, default ON) and sec_payment_emails
  // (email receipt, default OFF / opt-in). Best-effort and non-blocking: a failure
  // here never affects the payer's 200.
  try {
    const payee: any = await c.env.DB.prepare(
      `SELECT name, email, settings_json FROM users WHERE id = ?`
    ).bind(res.payee_user_id).first();
    let ps: Record<string, unknown> = {};
    try { ps = JSON.parse(payee?.settings_json || '{}') || {}; } catch {}
    const amountUsd = Number(res.price_usd) || 0;
    if (ps.sec_receipt_notifs !== false) {
      await notify(c.env, res.payee_user_id, {
        type: 'payment_received',
        title: 'Pago recibido',
        body: `Recibiste $${amountUsd.toFixed(2)} USDC${res.title ? ` por "${res.title}"` : ''}.`,
        link: '#pagos',
      });
    }
    if (ps.sec_payment_emails === true && payee?.email) {
      await sendEmail(c.env, payee.email, paymentReceivedEmail({
        name: payee.name || undefined, amountUsd, description: res.title || res.description || undefined,
        txHash: s.transactionHash || undefined, network, manageUrl: new URL('/cuenta', c.req.url).toString(),
      })).catch(() => {});
    }
  } catch {}

  // Settlement receipt for the payer.
  c.header('PAYMENT-RESPONSE', encodeJsonB64({ transaction: s.transactionHash, network, payer: v.payer }));
  return c.json({
    ok: true, paid: true,
    resource: { title: res.title, description: res.description, mimeType: res.mime_type },
    payment: { id, amount_usd: Number(res.price_usd), network, asset, payTo, payer: v.payer, tx: s.transactionHash, priceVersion: res.price_version },
  });
});

// The platform-level discovery doc. Served at /.well-known/x402.json (root).
// Fix 1: returns null when payments are not LIVE — index.ts then 503s instead of
// advertising a protocol that cannot settle.
export function wellKnownX402(env: Env) {
  if (!isX402Live(env)) return null;
  const network = x402Network(env);
  return {
    x402Version: 2,
    name: 'SISMO911',
    description: 'x402 payment receiving for SISMO911 accounts. Each user wallet can accept USDC over HTTP.',
    network,
    chainId: chainIdFromNetwork(network),
    asset: x402Asset(env, network),
    // Fix 8: the facilitator URL is intentionally NOT advertised — it can be a
    // private/authenticated endpoint, and clients don't need it (the resource
    // server settles server-side). Payers get PaymentRequirements from the 402.
    // Per-user paid resources live at this template; discover a user's resources
    // via GET /api/x402/resources (authenticated as that user).
    payTemplate: '/api/x402/pay/{userId}/{slug}',
  };
}
