import { Hono } from 'hono';
import type { Env } from '../types';
import { getUserFromRequest } from '../lib/auth';
import { audit } from '../lib/audit';
import { uid } from '../lib/db';
import { notify } from '../lib/notify';
import {
  isStripeConfigured, isStripeLive,
  createCheckoutSession, createConnectAccount, createAccountLink, retrieveAccount,
  verifyStripeWebhook, StripeError,
} from '../lib/stripe';

// Stripe card rail: Checkout (receiving) + Connect (payouts onboarding).
//
// Gated everywhere on isStripeLive (secret key present AND STRIPE_PAYMENTS_ENABLED).
// When not live, /checkout + /connect return 503 and the UI shows "no disponible"
// — exactly like x402. Honest by construction: a Stripe receipt is only ever
// recorded 'paid' by the signature-verified webhook, never optimistically.

export const stripe = new Hono<{ Bindings: Env }>();

const str = (v: unknown, max: number) => (v == null ? '' : String(v)).slice(0, max).trim();

async function resolvePayee(env: Env, id: string) {
  return env.DB.prepare(
    `SELECT id, username, name, settings_json FROM users WHERE username = ? OR id = ? LIMIT 1`
  ).bind(id.toLowerCase(), id).first<any>();
}

// ── GET /api/stripe/status — public booleans the client uses to toggle UI ──────
stripe.get('/status', (c) => {
  return c.json({ ok: true, configured: isStripeConfigured(c.env), live: isStripeLive(c.env) });
});

// ── POST /api/stripe/checkout/:user/:slug — create a hosted Checkout Session ───
// Public (a payer has no session). For a kind='stripe' active payment link.
stripe.post('/checkout/:user/:slug', async (c) => {
  if (!isStripeLive(c.env)) return c.json({ error: 'payments_unavailable' }, 503);
  const userParam = c.req.param('user'); const slug = c.req.param('slug');
  if (!userParam || userParam.length > 64 || !slug || slug.length > 64) return c.json({ error: 'not_found' }, 404);
  const u = await resolvePayee(c.env, userParam);
  if (!u) return c.json({ error: 'not_found' }, 404);
  const r: any = await c.env.DB.prepare(
    `SELECT id, slug, title, description, price_usd, kind, active
       FROM x402_resources WHERE user_id = ? AND slug = ? AND archived_ms IS NULL LIMIT 1`
  ).bind(u.id, slug).first();
  if (!r || !r.active || (r.kind || '') !== 'stripe') return c.json({ error: 'not_found' }, 404);

  // Fixed price from the link; open-amount stripe links accept a payer amount.
  const body = await c.req.json().catch(() => ({} as any));
  const linkPrice = Number(r.price_usd) || 0;
  const amountUsd = linkPrice > 0 ? linkPrice : Number(body?.amount_usd) || 0;
  if (!(amountUsd >= 0.5) || !isFinite(amountUsd)) return c.json({ error: 'amount_invalid' }, 400);

  const id = uid('stp');
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO stripe_payments (id,payee_user_id,resource_id,amount_usd,currency,status,description,created_ms)
     VALUES (?,?,?,?,?,'pending',?,?)`
  ).bind(id, u.id, r.id, amountUsd, 'USD', str(r.title, 250), now).run();

  const origin = new URL(c.req.url).origin;
  try {
    const session = await createCheckoutSession(c.env, {
      amountUsd,
      productName: str(r.title, 250) || 'Pago',
      description: str(r.description, 500),
      successUrl: `${origin}/pagar/${u.id}/${r.slug}?status=paid`,
      cancelUrl: `${origin}/pagar/${u.id}/${r.slug}?status=cancel`,
      clientReferenceId: id,
      customerEmail: str(body?.email, 200) || undefined,
      metadata: { stripe_payment_id: id, payee_user_id: u.id, resource_id: r.id },
    });
    await c.env.DB.prepare(`UPDATE stripe_payments SET session_id=? WHERE id=?`).bind(session.id, id).run();
    await audit(c, 'stripe.checkout.create', { id, resource_id: r.id, amount_usd: amountUsd });
    return c.json({ ok: true, url: session.url, session_id: session.id });
  } catch (e: any) {
    await c.env.DB.prepare(`UPDATE stripe_payments SET status='failed' WHERE id=?`).bind(id).run();
    const status = e instanceof StripeError ? 502 : 500;
    return c.json({ error: 'checkout_failed', detail: String(e?.message || e).slice(0, 200) }, status);
  }
});

// ── POST /api/stripe/webhook — signature-verified event handler ────────────────
// Public; self-gated on the Stripe signature secret. Idempotent (unique
// session_id; account upsert). Always 200 on a handled/ignored event so Stripe
// stops retrying; 400 only on a bad/absent signature.
stripe.post('/webhook', async (c) => {
  const secret = (c.env.STRIPE_WEBHOOK_SECRET || '').trim();
  const raw = await c.req.text();
  const sig = c.req.header('stripe-signature');
  const event = await verifyStripeWebhook(secret, raw, sig);
  if (!event) return c.json({ error: 'bad_signature' }, 400);

  const now = Date.now();
  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data?.object || {};
      const ref = s.client_reference_id || s.metadata?.stripe_payment_id || null;
      const sessionId = s.id || null;
      const paid = s.payment_status === 'paid' || s.status === 'complete';
      const row: any = ref
        ? await c.env.DB.prepare(`SELECT id, payee_user_id, status, amount_usd FROM stripe_payments WHERE id=?`).bind(ref).first()
        : sessionId
          ? await c.env.DB.prepare(`SELECT id, payee_user_id, status, amount_usd FROM stripe_payments WHERE session_id=?`).bind(sessionId).first()
          : null;
      if (row && row.status !== 'paid' && paid) {
        await c.env.DB.prepare(
          `UPDATE stripe_payments SET status='paid', session_id=COALESCE(session_id,?), payment_intent=?, payer_email=?, paid_ms=? WHERE id=?`
        ).bind(sessionId, s.payment_intent || null, s.customer_details?.email || s.customer_email || null, now, row.id).run();
        await notify(c.env, row.payee_user_id, {
          type: 'payment_received',
          title: 'Pago recibido (tarjeta)',
          body: `Recibiste un pago de $${(Number(row.amount_usd) || 0).toFixed(2)} con tarjeta vía Stripe.`,
          link: '#pagos',
          email: true,
        });
      }
    } else if (event.type === 'account.updated') {
      const a = event.data?.object || {};
      if (a.id) {
        await c.env.DB.prepare(
          `UPDATE stripe_accounts
              SET charges_enabled=?, payouts_enabled=?, details_submitted=?,
                  status=?, updated_ms=?
            WHERE account_id=?`
        ).bind(
          a.charges_enabled ? 1 : 0, a.payouts_enabled ? 1 : 0, a.details_submitted ? 1 : 0,
          a.payouts_enabled ? 'active' : (a.requirements?.disabled_reason ? 'restricted' : 'pending'),
          now, a.id,
        ).run();
      }
    } else if (event.type === 'charge.refunded' || event.type === 'payment_intent.payment_failed') {
      const o = event.data?.object || {};
      const pi = o.payment_intent || (event.type === 'charge.refunded' ? o.payment_intent : o.id);
      const newStatus = event.type === 'charge.refunded' ? 'refunded' : 'failed';
      if (pi) {
        await c.env.DB.prepare(`UPDATE stripe_payments SET status=? WHERE payment_intent=? AND status!='refunded'`).bind(newStatus, pi).run();
      }
    }
  } catch (e: any) {
    // Never 500 a verified webhook (Stripe would hammer-retry). Log + 200.
    console.error('[stripe.webhook] handler error', String(e?.message || e));
  }
  return c.json({ ok: true, received: true });
});

// ── POST /api/stripe/connect/onboard — create/reuse Express account + link ─────
stripe.post('/connect/onboard', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  if (!isStripeLive(c.env)) return c.json({ error: 'payments_unavailable' }, 503);

  const now = Date.now();
  let acct: any = await c.env.DB.prepare(`SELECT account_id FROM stripe_accounts WHERE user_id=?`).bind(me.id).first();
  let accountId = acct?.account_id as string | undefined;
  try {
    if (!accountId) {
      const created = await createConnectAccount(c.env, { email: (me as any).email, country: str(c.env.STRIPE_CONNECT_COUNTRY, 2) || undefined });
      accountId = created.id;
      await c.env.DB.prepare(
        `INSERT INTO stripe_accounts (user_id,account_id,charges_enabled,payouts_enabled,details_submitted,status,country,created_ms,updated_ms)
         VALUES (?,?,0,0,0,'pending',?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET account_id=excluded.account_id, updated_ms=excluded.updated_ms`
      ).bind(me.id, accountId, created.country || null, now, now).run();
    }
    const origin = new URL(c.req.url).origin;
    const link = await createAccountLink(c.env, {
      account: accountId!,
      refreshUrl: `${origin}/cuenta?stripe_connect=refresh`,
      returnUrl: `${origin}/cuenta?stripe_connect=return`,
    });
    await audit(c, 'stripe.connect.onboard', { account_id: accountId });
    return c.json({ ok: true, url: link.url });
  } catch (e: any) {
    const status = e instanceof StripeError ? 502 : 500;
    return c.json({ error: 'onboard_failed', detail: String(e?.message || e).slice(0, 200) }, status);
  }
});

// ── GET /api/stripe/connect/status — my connected-account state (live-refreshed) ─
stripe.get('/connect/status', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const row: any = await c.env.DB.prepare(
    `SELECT account_id, charges_enabled, payouts_enabled, details_submitted, status FROM stripe_accounts WHERE user_id=?`
  ).bind(me.id).first();
  if (!row) return c.json({ ok: true, connected: false, live: isStripeLive(c.env) });

  // Best-effort live refresh so the UI reflects onboarding completion immediately.
  if (isStripeLive(c.env)) {
    try {
      const a = await retrieveAccount(c.env, row.account_id);
      await c.env.DB.prepare(
        `UPDATE stripe_accounts SET charges_enabled=?, payouts_enabled=?, details_submitted=?, status=?, updated_ms=? WHERE user_id=?`
      ).bind(a.charges_enabled ? 1 : 0, a.payouts_enabled ? 1 : 0, a.details_submitted ? 1 : 0,
        a.payouts_enabled ? 'active' : (a.requirements?.disabled_reason ? 'restricted' : 'pending'), Date.now(), me.id).run();
      row.charges_enabled = a.charges_enabled ? 1 : 0;
      row.payouts_enabled = a.payouts_enabled ? 1 : 0;
      row.details_submitted = a.details_submitted ? 1 : 0;
      row.status = a.payouts_enabled ? 'active' : (a.requirements?.disabled_reason ? 'restricted' : 'pending');
    } catch { /* keep the stored snapshot on a transient Stripe error */ }
  }
  return c.json({
    ok: true, connected: true, live: isStripeLive(c.env),
    account: {
      charges_enabled: Boolean(row.charges_enabled),
      payouts_enabled: Boolean(row.payouts_enabled),
      details_submitted: Boolean(row.details_submitted),
      status: row.status,
    },
  });
});
