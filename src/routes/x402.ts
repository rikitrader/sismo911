import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { getUserFromRequest } from '../lib/auth';
import { audit } from '../lib/audit';
import { rateLimit } from '../lib/security';
import {
  buildRequirements, paymentRequiredBody, encodePaymentRequired, encodeJsonB64,
  readPaymentPayload, verifyPayment, settlePayment, isX402Configured,
  x402Network, x402Asset, usdToAtomic,
} from '../lib/x402';

// x402 payment-receiving routes (https://github.com/xpaysh/awesome-x402).
// Mounted at /api/x402. The discovery doc is served at /.well-known/x402.json
// from index.ts via `wellKnownX402`.
export const x402 = new Hono<{ Bindings: Env }>();

const slugOk = (s: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(s);

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
  return c.json({
    ok: true,
    x402: {
      enabled: Boolean(row?.x402_enabled),
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
    `SELECT id, slug, title, description, price_usd, mime_type, active, created_ms, updated_ms
       FROM x402_resources WHERE user_id = ? ORDER BY created_ms DESC`
  ).bind(me.id).all();
  return c.json({ ok: true, resources: results ?? [] });
});

// POST /api/x402/resources — create or update one of the caller's priced resources.
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
  await c.env.DB.prepare(
    `INSERT INTO x402_resources (id, user_id, slug, title, description, price_usd, mime_type, active, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id, slug) DO UPDATE SET
       title=excluded.title, description=excluded.description, price_usd=excluded.price_usd,
       mime_type=excluded.mime_type, active=excluded.active, updated_ms=excluded.updated_ms`
  ).bind(uid('res'), me.id, slug, title, b?.description ?? null, price, mime, active, now, now).run();
  await audit(c, 'x402.resource.upsert', { user_id: me.id, slug });
  const payUrl = new URL(`/api/x402/pay/${me.id}/${slug}`, c.req.url).toString();
  return c.json({ ok: true, resource: { slug, title, price_usd: price, active: Boolean(active) }, payUrl });
});

// GET /api/x402/payments — the caller's received-payments ledger.
x402.get('/payments', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const { results } = await c.env.DB.prepare(
    `SELECT id, resource_url, description, amount, amount_usd, network, asset, pay_to, payer,
            status, tx_hash, invalid_reason, created_ms, settled_ms
       FROM x402_payments WHERE payee_user_id = ? ORDER BY created_ms DESC LIMIT 200`
  ).bind(me.id).all();
  return c.json({ ok: true, payments: results ?? [] });
});

// ALL /api/x402/pay/:userId/:slug — the receive flow (public; payer needs no account).
//   • no payment header  → 402 + PAYMENT-REQUIRED (signed authorization requested)
//   • with header        → facilitator verify → settle → 200 + PAYMENT-RESPONSE
x402.all('/pay/:userId/:slug', async (c) => {
  const limited = await rateLimit(c.env, c, 'x402_pay', 30, 60);
  if (limited) return limited;
  const { userId, slug } = c.req.param();

  const res: any = await c.env.DB.prepare(
    `SELECT r.id AS resource_id, r.title, r.description, r.price_usd, r.mime_type, r.active,
            u.id AS payee_user_id, u.x402_enabled, u.x402_pay_to, u.wallet_address, u.x402_network, u.x402_asset
       FROM x402_resources r JOIN users u ON u.id = r.user_id
      WHERE r.user_id = ? AND r.slug = ?`
  ).bind(userId, slug).first();

  if (!res || !res.active) return c.json({ error: 'resource_not_found' }, 404);
  const payTo = res.x402_pay_to || res.wallet_address;
  if (!res.x402_enabled || !payTo) return c.json({ error: 'recipient_not_receiving' }, 503);

  const network = res.x402_network || x402Network(c.env);
  const asset = res.x402_asset || x402Asset(c.env, network);
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

  if (!isX402Configured(c.env)) return c.json({ error: 'facilitator_not_configured' }, 503);

  // Record the attempt, then verify + settle via the facilitator.
  const id = uid('x4p');
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO x402_payments
       (id, payee_user_id, resource_id, resource_url, description, scheme, network, asset, amount, amount_usd,
        pay_to, status, facilitator, payload_json, ip, created_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, res.payee_user_id, res.resource_id, resourceUrl, res.description || res.title, 'exact',
         network, asset, amount, Number(res.price_usd), payTo, 'required',
         c.env.X402_FACILITATOR_URL || null, JSON.stringify(payload),
         c.req.header('cf-connecting-ip') || null, now).run();

  const v = await verifyPayment(c.env, payload, requirements);
  if (!v.isValid) {
    await c.env.DB.prepare(`UPDATE x402_payments SET status='failed', invalid_reason=?, payer=? WHERE id=?`)
      .bind(v.invalidReason || 'invalid_payment', v.payer ?? null, id).run();
    const body = paymentRequiredBody({ requirements: [requirements], resourceUrl, description: res.description || res.title, mimeType: res.mime_type, error: v.invalidReason || 'invalid_payment' });
    c.header('PAYMENT-REQUIRED', encodePaymentRequired(body));
    return c.json(body, 402);
  }
  await c.env.DB.prepare(`UPDATE x402_payments SET status='verified', payer=?, verified_ms=? WHERE id=?`)
    .bind(v.payer ?? null, Date.now(), id).run();

  const s = await settlePayment(c.env, payload, requirements);
  if (!s.success) {
    await c.env.DB.prepare(`UPDATE x402_payments SET status='failed', invalid_reason=? WHERE id=?`)
      .bind(s.errorReason || 'settlement_failed', id).run();
    return c.json({ error: 'settlement_failed', reason: s.errorReason }, 402);
  }
  await c.env.DB.prepare(`UPDATE x402_payments SET status='settled', tx_hash=?, settled_ms=? WHERE id=?`)
    .bind(s.transactionHash ?? null, Date.now(), id).run();

  // Settlement receipt for the payer.
  c.header('PAYMENT-RESPONSE', encodeJsonB64({ transaction: s.transactionHash, network, payer: v.payer }));
  return c.json({
    ok: true, paid: true,
    resource: { title: res.title, description: res.description, mimeType: res.mime_type },
    payment: { id, amount_usd: Number(res.price_usd), network, asset, payTo, payer: v.payer, tx: s.transactionHash },
  });
});

// The platform-level discovery doc. Served at /.well-known/x402.json (root).
export function wellKnownX402(env: Env) {
  const network = x402Network(env);
  return {
    x402Version: 2,
    name: 'SISMO911',
    description: 'x402 payment receiving for SISMO911 accounts. Each user wallet can accept USDC over HTTP.',
    network,
    asset: x402Asset(env, network),
    facilitator: env.X402_FACILITATOR_URL || null,
    // Per-user paid resources live at this template; discover a user's resources
    // via GET /api/x402/resources (authenticated as that user).
    payTemplate: '/api/x402/pay/{userId}/{slug}',
  };
}
