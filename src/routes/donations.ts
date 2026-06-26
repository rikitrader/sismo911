import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { getUserFromRequest } from '../lib/auth';
import { rateLimit, isAllowedOrigin } from '../lib/security';
import { audit } from '../lib/audit';
import {
  isCrossmintConfigured, crossmintClientConfig, createDonationOrder,
  getOrder, orderToStatus, verifyWebhook,
} from '../lib/crossmint';

export const donations = new Hono<{ Bindings: Env }>();

const CATEGORIES = ['rescate', 'salud', 'refugio', 'familia', 'reconstruccion', 'alimentos', 'otro'];
const emailOk = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.trim().slice(0, n) : '');

function slugify(s: string): string {
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'campana';
}

// Public shape of a campaign (recomputes progress fields are added by callers).
const CAMPAIGN_COLS =
  `id, slug, title, summary, story, image_url, category, location, goal_usd, raised_usd,
   donors_count, currency, beneficiary, organizer_name, status, featured, allocation, fund_use,
   created_ms, updated_ms`;

// Validate + normalize a money-flow allocation: array of {label, pct}, ≤8 items,
// each pct 0–100. Returns a compact JSON string, or null if absent/invalid.
export function normalizeAllocation(input: unknown): string | null {
  if (!Array.isArray(input)) return null;
  const out: { label: string; pct: number }[] = [];
  for (const it of input.slice(0, 8)) {
    const label = clip((it as any)?.label, 40);
    const pct = Math.round(Number((it as any)?.pct));
    if (!label || !Number.isFinite(pct) || pct < 0 || pct > 100) continue;
    out.push({ label, pct });
  }
  return out.length ? JSON.stringify(out) : null;
}

// ---------------------------------------------------------------------------
// Zone visibility — the whole /donar zone is hidden from the public until an
// admin reveals it. Backed by a single KV flag; admins always see/manage it.
// ---------------------------------------------------------------------------

const ZONE_KEY = 'zone:donar:public';
// Hidden by default ("for now") — only "1" means publicly visible.
async function donarPublic(env: Env): Promise<boolean> {
  return (await env.CACHE.get(ZONE_KEY).catch(() => null)) === '1';
}

// GET /api/donations/zone — visibility state + whether the caller can manage it.
// Public-safe: anyone may read it (the widgets gate themselves on the result).
donations.get('/donations/zone', async (c) => {
  const me = await getUserFromRequest(c.env, c).catch(() => null);
  const isPublic = await donarPublic(c.env);
  return c.json(
    { public: isPublic, canManage: me?.role === 'admin' },
    200, { 'Cache-Control': 'no-store' }
  );
});

// POST /api/donations/zone { public: boolean } — admin-only reveal/hide toggle.
donations.post('/donations/zone', async (c) => {
  const me = await getUserFromRequest(c.env, c).catch(() => null);
  if (me?.role !== 'admin') return c.json({ error: 'forbidden' }, 403);
  const b = await c.req.json().catch(() => ({}));
  const next = !!b?.public;
  await c.env.CACHE.put(ZONE_KEY, next ? '1' : '0');
  await audit(c, 'donar.zone.toggle', { public: next });
  return c.json({ ok: true, public: next });
});

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

// GET /api/campaigns — list (default: active). Filters: ?category, ?q, ?featured=1, ?status (operator only).
donations.get('/campaigns', async (c) => {
  // Zone hidden → no campaigns leak to the public; admins still see them.
  if (!(await donarPublic(c.env))) {
    const me = await getUserFromRequest(c.env, c).catch(() => null);
    if (me?.role !== 'admin') return c.json({ campaigns: [] }, 200, { 'Cache-Control': 'no-store' });
  }
  const url = new URL(c.req.url);
  const category = url.searchParams.get('category');
  const q = clip(url.searchParams.get('q'), 60);
  const featured = url.searchParams.get('featured') === '1';
  let status = url.searchParams.get('status') || 'active';
  // Only operators/admins may browse non-active campaigns.
  if (status !== 'active') {
    const me = await getUserFromRequest(c.env, c).catch(() => null);
    if (!(me && (me.role === 'operator' || me.role === 'admin'))) status = 'active';
  }
  const where: string[] = ['status = ?'];
  const binds: any[] = [status];
  if (category && CATEGORIES.includes(category)) { where.push('category = ?'); binds.push(category); }
  if (featured) where.push('featured = 1');
  if (q) { where.push('(title LIKE ? OR summary LIKE ? OR location LIKE ?)'); const like = `%${q}%`; binds.push(like, like, like); }
  const { results } = await c.env.DB.prepare(
    `SELECT ${CAMPAIGN_COLS} FROM campaigns WHERE ${where.join(' AND ')}
     ORDER BY featured DESC, created_ms DESC LIMIT 100`
  ).bind(...binds).all();
  return c.json({ campaigns: results ?? [] }, 200, { 'Cache-Control': 'no-store' });
});

// GET /api/campaigns/:slug — detail + recent public donations (ledger).
donations.get('/campaigns/:slug', async (c) => {
  // Zone hidden → behave as if the campaign doesn't exist (admins exempt).
  if (!(await donarPublic(c.env))) {
    const me = await getUserFromRequest(c.env, c).catch(() => null);
    if (me?.role !== 'admin') return c.json({ error: 'not_found' }, 404);
  }
  const slug = c.req.param('slug');
  const camp: any = await c.env.DB.prepare(`SELECT ${CAMPAIGN_COLS} FROM campaigns WHERE slug = ?`).bind(slug).first();
  if (!camp) return c.json({ error: 'not_found' }, 404);
  // Authoritative progress, recomputed from paid donations (counters are a cache).
  const agg: any = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(amount_usd),0) AS raised, COUNT(*) AS donors
       FROM donations WHERE campaign_id = ? AND status = 'paid'`
  ).bind(camp.id).first();
  camp.raised_usd = Number(agg?.raised ?? 0);
  camp.donors_count = Number(agg?.donors ?? 0);
  const { results: ledger } = await c.env.DB.prepare(
    `SELECT amount_usd, currency, anonymous, donor_name, message, paid_ms
       FROM donations WHERE campaign_id = ? AND status = 'paid'
       ORDER BY paid_ms DESC LIMIT 50`
  ).bind(camp.id).all();
  const publicLedger = (ledger ?? []).map((d: any) => ({
    amount_usd: d.amount_usd,
    currency: d.currency,
    name: d.anonymous ? 'Anónimo' : (d.donor_name || 'Anónimo'),
    message: d.message || null,
    paid_ms: d.paid_ms,
  }));
  return c.json({ campaign: camp, donations: publicLedger }, 200, { 'Cache-Control': 'no-store' });
});

// GET /api/donations/config — browser-safe Crossmint config for the donate widget.
donations.get('/donations/config', (c) => c.json(crossmintClientConfig(c.env), 200, { 'Cache-Control': 'no-store' }));

// ---------------------------------------------------------------------------
// Anonymous donate — NO signup, NO login required.
// ---------------------------------------------------------------------------

// POST /api/campaigns/:slug/donate  { amount, email, name?, message?, anonymous? }
donations.post('/campaigns/:slug/donate', async (c) => {
  const limited = await rateLimit(c.env, c, 'donate', 12, 300);
  if (limited) return limited;

  // Zone hidden → donations are not open to the public yet.
  if (!(await donarPublic(c.env))) {
    const me = await getUserFromRequest(c.env, c).catch(() => null);
    if (me?.role !== 'admin') return c.json({ error: 'zone_hidden' }, 404);
  }

  const slug = c.req.param('slug');
  const camp: any = await c.env.DB.prepare(`SELECT id, slug, title, status FROM campaigns WHERE slug = ?`).bind(slug).first();
  if (!camp) return c.json({ error: 'campaign_not_found' }, 404);
  if (camp.status !== 'active') return c.json({ error: 'campaign_not_active' }, 409);

  const b = await c.req.json().catch(() => null);
  const amount = Number(b?.amount);
  if (!Number.isFinite(amount) || amount < 1 || amount > 50000) return c.json({ error: 'amount_invalid', hint: 'Entre 1 y 50000 USD' }, 400);
  const email = (b?.email || '').trim().toLowerCase();
  if (!emailOk(email)) return c.json({ error: 'email_invalid' }, 400);
  const anonymous = b?.anonymous ? 1 : 0;
  const donorName = anonymous ? null : (clip(b?.name, 80) || null);
  const message = clip(b?.message, 280) || null;

  if (!isCrossmintConfigured(c.env)) {
    // Honest gated state — the campaign is real, the payment rail isn't wired yet.
    return c.json({ error: 'payments_not_configured', configured: false }, 503);
  }

  const id = uid('don');
  const now = Date.now();
  const amt = Math.round(amount * 100) / 100;
  await c.env.DB.prepare(
    `INSERT INTO donations (id, campaign_id, amount_usd, currency, donor_name, donor_email, message, anonymous, status, provider, ip, created_ms)
     VALUES (?,?,?,?,?,?,?,?, 'pending', 'crossmint', ?, ?)`
  ).bind(id, camp.id, amt, 'USD', donorName, email, message, anonymous,
         c.req.header('cf-connecting-ip') || null, now).run();

  const order = await createDonationOrder(c.env, {
    amountUsd: amt, email, campaignSlug: camp.slug, campaignTitle: camp.title, donationId: id,
  });
  if (!order.ok) {
    await c.env.DB.prepare(`UPDATE donations SET status = 'failed' WHERE id = ?`).bind(id).run();
    return c.json({ error: 'order_failed', detail: order.error }, order.status === 503 ? 503 : 502);
  }
  // Persist the order id so the webhook / reconcile can find this donation.
  await c.env.DB.prepare(`UPDATE donations SET order_id = ? WHERE id = ?`).bind(order.order.orderId, id).run();

  const cfg = crossmintClientConfig(c.env);
  return c.json({
    ok: true,
    donationId: id,
    orderId: order.order.orderId,
    clientSecret: order.order.clientSecret,
    clientKey: cfg.clientKey,
    env: cfg.env,
    chain: cfg.chain,
  });
});

// GET /api/donations/:id/status — poll a single donation; reconciles from
// Crossmint if still pending (covers a missed webhook). Id is unguessable.
donations.get('/donations/:id/status', async (c) => {
  const id = c.req.param('id');
  const d: any = await c.env.DB.prepare(
    `SELECT id, campaign_id, amount_usd, status, order_id FROM donations WHERE id = ?`
  ).bind(id).first();
  if (!d) return c.json({ error: 'not_found' }, 404);
  if (d.status === 'pending' && d.order_id && isCrossmintConfigured(c.env)) {
    const order = await getOrder(c.env, d.order_id).catch(() => null);
    if (order) {
      const mapped = orderToStatus(order);
      if (mapped.status !== 'pending') {
        await applyPaid(c.env, d.id, d.campaign_id, d.amount_usd, mapped);
        d.status = mapped.status;
      }
    }
  }
  return c.json({ status: d.status });
});

// ---------------------------------------------------------------------------
// Crossmint webhook (Svix-signed) — flips donations pending → paid.
// ---------------------------------------------------------------------------

donations.post('/donations/webhook', async (c) => {
  const raw = await c.req.text();
  const secret = c.env.CROSSMINT_WEBHOOK_SECRET || '';
  const ok = await verifyWebhook(secret, {
    id: c.req.header('svix-id') ?? null,
    timestamp: c.req.header('svix-timestamp') ?? null,
    signature: c.req.header('svix-signature') ?? null,
  }, raw).catch(() => false);
  if (!ok) return c.json({ error: 'bad_signature' }, 401);

  let body: any = null;
  try { body = JSON.parse(raw); } catch { return c.json({ error: 'bad_body' }, 400); }
  const order = body?.data?.order ?? body?.data ?? body;
  const orderId = order?.orderId || order?.id;
  const donationId = order?.metadata?.donation_id;
  if (!orderId && !donationId) return c.json({ ok: true, skipped: 'no_order' });

  // Resolve canonical order from Crossmint when possible (don't trust the body alone).
  let resolved = order;
  if (orderId && isCrossmintConfigured(c.env)) {
    const fresh = await getOrder(c.env, orderId).catch(() => null);
    if (fresh) resolved = fresh;
  }
  const mapped = orderToStatus(resolved);

  const d: any = donationId
    ? await c.env.DB.prepare(`SELECT id, campaign_id, amount_usd, status FROM donations WHERE id = ?`).bind(donationId).first()
    : await c.env.DB.prepare(`SELECT id, campaign_id, amount_usd, status FROM donations WHERE order_id = ?`).bind(orderId).first();
  if (!d) return c.json({ ok: true, skipped: 'no_donation' });

  if (mapped.status === 'paid') {
    await applyPaid(c.env, d.id, d.campaign_id, d.amount_usd, mapped);
  } else if (mapped.status === 'failed' && d.status !== 'paid') {
    await c.env.DB.prepare(`UPDATE donations SET status = 'failed' WHERE id = ? AND status != 'paid'`).bind(d.id).run();
  }
  return c.json({ ok: true });
});

// Idempotently mark a donation paid and bump the campaign counters exactly once.
async function applyPaid(
  env: Env, donationId: string, campaignId: string, amountUsd: number,
  info: { txId?: string; wallet?: string }
): Promise<void> {
  const upd = await env.DB.prepare(
    `UPDATE donations SET status = 'paid', paid_ms = ?, tx_id = COALESCE(?, tx_id), wallet_address = COALESCE(?, wallet_address)
     WHERE id = ? AND status != 'paid'`
  ).bind(Date.now(), info.txId ?? null, info.wallet ?? null, donationId).run();
  if ((upd.meta?.changes ?? 0) > 0) {
    await env.DB.prepare(
      `UPDATE campaigns SET raised_usd = raised_usd + ?, donors_count = donors_count + 1, updated_ms = ? WHERE id = ?`
    ).bind(amountUsd, Date.now(), campaignId).run();
  }
}

// ---------------------------------------------------------------------------
// Campaign management (logged-in users create; owner/operator edit).
// ---------------------------------------------------------------------------

// GET /api/campaigns/mine — the caller's own campaigns (any status).
donations.get('/campaigns-mine', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const { results } = await c.env.DB.prepare(
    `SELECT ${CAMPAIGN_COLS} FROM campaigns WHERE organizer_user_id = ? ORDER BY created_ms DESC LIMIT 100`
  ).bind(me.id).all();
  return c.json({ campaigns: results ?? [] });
});

// POST /api/campaigns — create (requires login; goes live as 'active').
donations.post('/campaigns', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized', hint: 'Inicia sesión para crear una campaña' }, 401);
  // Same-site guard (defense-in-depth vs CSRF) for this state-changing call.
  const originHdr = c.req.header('origin') || c.req.header('referer');
  if (originHdr && !isAllowedOrigin(c.env, originHdr.split('/').slice(0, 3).join('/'))) {
    return c.json({ error: 'bad_origin' }, 403);
  }
  const limited = await rateLimit(c.env, c, 'campaign_create', 5, 3600);
  if (limited) return limited;

  const b = await c.req.json().catch(() => null);
  const title = clip(b?.title, 120);
  if (title.length < 4) return c.json({ error: 'title_required' }, 400);
  const goal = Number(b?.goal_usd);
  if (!Number.isFinite(goal) || goal < 0 || goal > 10_000_000) return c.json({ error: 'goal_invalid' }, 400);
  const category = CATEGORIES.includes(b?.category) ? b.category : 'otro';
  const image = clip(b?.image_url, 400);
  if (image && !/^(https:\/\/|\/)/.test(image)) return c.json({ error: 'image_url_invalid' }, 400);

  // Unique slug.
  let slug = slugify(title);
  const exists = await c.env.DB.prepare(`SELECT 1 FROM campaigns WHERE slug = ?`).bind(slug).first();
  if (exists) slug = `${slug}-${crypto.randomUUID().slice(0, 4)}`;

  const allocation = normalizeAllocation(b?.allocation);
  const fundUse = clip(b?.fund_use, 1200) || null;

  const id = uid('cmp');
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO campaigns
       (id, slug, title, summary, story, image_url, category, location, goal_usd, raised_usd, donors_count,
        currency, beneficiary, organizer_user_id, organizer_name, contact_email, status, featured, allocation, fund_use, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?, 0, 0, 'USD', ?,?,?,?, 'active', 0, ?,?, ?, ?)`
  ).bind(
    id, slug, title, clip(b?.summary, 200) || null, clip(b?.story, 5000) || null,
    image || null, category, clip(b?.location, 80) || null, Math.round(goal * 100) / 100,
    clip(b?.beneficiary, 120) || null, me.id, me.name, me.email, allocation, fundUse, now, now
  ).run();
  await audit(c, 'campaign.create', { id, slug });
  return c.json({ ok: true, id, slug }, 201);
});

// PATCH /api/campaigns/:slug — owner edits content; operator/admin can also
// moderate (status incl. rejected/closed, featured).
donations.patch('/campaigns/:slug', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const slug = c.req.param('slug');
  const camp: any = await c.env.DB.prepare(`SELECT id, organizer_user_id FROM campaigns WHERE slug = ?`).bind(slug).first();
  if (!camp) return c.json({ error: 'not_found' }, 404);
  const isOperator = me.role === 'operator' || me.role === 'admin';
  const isOwner = camp.organizer_user_id && camp.organizer_user_id === me.id;
  if (!isOperator && !isOwner) return c.json({ error: 'forbidden' }, 403);

  const b = await c.req.json().catch(() => ({}));
  const sets: string[] = [];
  const binds: any[] = [];
  const setStr = (col: string, val: string | null) => { sets.push(`${col} = ?`); binds.push(val); };
  if (typeof b.title === 'string') setStr('title', clip(b.title, 120));
  if (typeof b.summary === 'string') setStr('summary', clip(b.summary, 200));
  if (typeof b.story === 'string') setStr('story', clip(b.story, 5000));
  if (typeof b.image_url === 'string') {
    const img = clip(b.image_url, 400);
    if (img && !/^(https:\/\/|\/)/.test(img)) return c.json({ error: 'image_url_invalid' }, 400);
    setStr('image_url', img || null);
  }
  if (typeof b.location === 'string') setStr('location', clip(b.location, 80) || null);
  if (typeof b.fund_use === 'string') setStr('fund_use', clip(b.fund_use, 1200) || null);
  if ('allocation' in b) setStr('allocation', normalizeAllocation(b.allocation));
  if (b.category && CATEGORIES.includes(b.category)) setStr('category', b.category);
  if (b.goal_usd != null) {
    const g = Number(b.goal_usd);
    if (!Number.isFinite(g) || g < 0 || g > 10_000_000) return c.json({ error: 'goal_invalid' }, 400);
    setStr('goal_usd', String(Math.round(g * 100) / 100));
  }
  // Status: owner limited to active|paused|closed; operator can also reject/pending_review.
  if (typeof b.status === 'string') {
    const ownerStatuses = ['active', 'paused', 'closed'];
    const opStatuses = [...ownerStatuses, 'rejected', 'pending_review'];
    const allowed = isOperator ? opStatuses : ownerStatuses;
    if (!allowed.includes(b.status)) return c.json({ error: 'status_invalid' }, 400);
    setStr('status', b.status);
  }
  // Featured is operator/admin only.
  if (b.featured != null) {
    if (!isOperator) return c.json({ error: 'forbidden_featured' }, 403);
    sets.push('featured = ?'); binds.push(b.featured ? 1 : 0);
  }
  if (!sets.length) return c.json({ error: 'no_fields' }, 400);
  sets.push('updated_ms = ?'); binds.push(Date.now());
  binds.push(camp.id);
  await c.env.DB.prepare(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  await audit(c, 'campaign.update', { id: camp.id, fields: Object.keys(b) });
  return c.json({ ok: true });
});
