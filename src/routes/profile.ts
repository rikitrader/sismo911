import { Hono } from 'hono';
import type { Env } from '../types';
import { getUserFromRequest } from '../lib/auth';
import { audit } from '../lib/audit';
import { uid } from '../lib/db';
import { x402Network, x402Asset } from '../lib/x402';

// Profile Command Center API. Every endpoint self-authenticates and is scoped to
// the caller's own user id — never returns secrets (no private keys, no raw
// wallet locator, no password hashes). Mounted at /api/profile.

export const profile = new Hono<{ Bindings: Env }>();

const LANGS = ['es', 'en', 'pt'];
const str = (v: unknown, max: number) =>
  v == null ? null : String(v).trim().slice(0, max) || null;

function parseSettings(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw) return {};
  try { const o = JSON.parse(raw); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}

// ── GET /api/profile/me — full profile + wallet + x402 config + settings ──────
profile.get('/me', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const u: any = await c.env.DB.prepare(
    `SELECT id, email, name, role, rank, unit, phone, country, city, language,
            wallet_address, wallet_chain, wallet_created_ms,
            x402_enabled, x402_pay_to, x402_network, x402_asset, x402_enabled_ms,
            settings_json, created_ms, last_login_ms
       FROM users WHERE id = ?`
  ).bind(me.id).first();
  if (!u) return c.json({ error: 'not_found' }, 404);

  const totals: any = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount_usd),0) AS usd
       FROM x402_payments WHERE payee_user_id = ? AND status = 'settled'`
  ).bind(me.id).first();
  const network = u.x402_network || x402Network(c.env);

  // Profile completion: count the filled optional fields.
  const fields = [u.name, u.phone, u.country, u.city, u.language, u.wallet_address];
  const completion = Math.round((fields.filter(Boolean).length / fields.length) * 100);

  return c.json({
    ok: true,
    profile: {
      id: u.id, email: u.email, name: u.name, role: u.role,
      rank: u.rank ?? null, unit: u.unit ?? null,
      phone: u.phone ?? null, country: u.country ?? null, city: u.city ?? null,
      language: u.language ?? 'es',
      created_ms: u.created_ms ?? null, last_login_ms: u.last_login_ms ?? null,
      completion,
    },
    wallet: {
      address: u.wallet_address ?? null,
      chain: u.wallet_chain ?? 'base',
      created_ms: u.wallet_created_ms ?? null,
      has_wallet: Boolean(u.wallet_address),
      custody: 'crossmint', // keys held by Crossmint, never stored in SISMO911
    },
    x402: {
      registered: Boolean(u.x402_enabled),
      payTo: u.x402_pay_to || u.wallet_address || null,
      network,
      asset: u.x402_asset || x402Asset(c.env, network),
      enabledAt: u.x402_enabled_ms || null,
    },
    received: { count: totals?.n ?? 0, usd: totals?.usd ?? 0 },
    settings: parseSettings(u.settings_json),
  });
});

// ── PATCH /api/profile/me — edit name/phone/country/city/language ─────────────
// email + role are NOT editable here (identity/authorization), and never echoed
// back from a write that didn't change them. Validates every field.
profile.patch('/me', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b !== 'object') return c.json({ error: 'bad_body' }, 400);

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (b.name !== undefined) {
    const name = str(b.name, 120);
    if (!name) return c.json({ error: 'name_required' }, 400);
    sets.push('name = ?'); vals.push(name);
  }
  if (b.phone !== undefined) {
    const phone = str(b.phone, 40);
    if (phone && !/^[+()\d\s-]{6,40}$/.test(phone)) return c.json({ error: 'phone_invalid' }, 400);
    sets.push('phone = ?'); vals.push(phone);
  }
  if (b.country !== undefined) { sets.push('country = ?'); vals.push(str(b.country, 60)); }
  if (b.city !== undefined) { sets.push('city = ?'); vals.push(str(b.city, 80)); }
  if (b.language !== undefined) {
    const lang = str(b.language, 8);
    if (lang && !LANGS.includes(lang)) return c.json({ error: 'language_invalid' }, 400);
    sets.push('language = ?'); vals.push(lang ?? 'es');
  }
  if (!sets.length) return c.json({ error: 'nothing_to_update' }, 400);
  vals.push(me.id);
  await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  await audit(c, 'profile.update', { fields: sets.map((s) => s.split(' ')[0]) });

  const u: any = await c.env.DB.prepare(
    `SELECT name, phone, country, city, language FROM users WHERE id = ?`
  ).bind(me.id).first();
  return c.json({ ok: true, profile: u });
});

// Whitelisted boolean toggle keys (payment + visibility + security). Anything not
// here is ignored — settings_json can never carry arbitrary/dangerous keys.
const SETTING_KEYS = new Set([
  // payment
  'receive_payments', 'public_profile', 'email_receipts', 'require_note', 'auto_qr', 'accounting_sync',
  // visibility
  'hide_balance', 'show_wallet_card', 'show_payout_card', 'show_payout_methods', 'require_withdraw_confirm',
  // security
  'sec_payment_emails', 'sec_public_page', 'sec_hide_email', 'sec_require_login', 'sec_receipt_notifs', 'sec_audit_visibility',
]);

// ── PATCH /api/profile/payment-settings — merge boolean toggles into settings_json ─
profile.patch('/payment-settings', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b !== 'object') return c.json({ error: 'bad_body' }, 400);

  const row: any = await c.env.DB.prepare(`SELECT settings_json FROM users WHERE id = ?`).bind(me.id).first();
  const current = parseSettings(row?.settings_json);
  let changed = 0;
  for (const [k, v] of Object.entries(b)) {
    if (!SETTING_KEYS.has(k)) continue;           // ignore unknown keys
    if (typeof v !== 'boolean') return c.json({ error: `setting_${k}_must_be_boolean` }, 400);
    current[k] = v; changed++;
  }
  if (!changed) return c.json({ error: 'no_valid_settings' }, 400);
  await c.env.DB.prepare(`UPDATE users SET settings_json = ? WHERE id = ?`)
    .bind(JSON.stringify(current), me.id).run();
  await audit(c, 'profile.settings.update', { keys: Object.keys(b).filter((k) => SETTING_KEYS.has(k)) });
  return c.json({ ok: true, settings: current });
});

// ── GET /api/profile/payments/summary — KPI + chart data from the x402 ledger ──
profile.get('/payments/summary', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const id = me.id;
  const now = Date.now();
  const monthStart = (() => { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); })();

  const [byStatus, settled, thisMonth, lastPay, activeLinks, monthly, topLinks] = await Promise.all([
    c.env.DB.prepare(`SELECT status, COUNT(*) AS n, COALESCE(SUM(amount_usd),0) AS usd FROM x402_payments WHERE payee_user_id = ? GROUP BY status`).bind(id).all(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_usd),0) AS usd FROM x402_payments WHERE payee_user_id = ? AND status = 'settled'`).bind(id).first<any>(),
    c.env.DB.prepare(`SELECT COALESCE(SUM(amount_usd),0) AS usd FROM x402_payments WHERE payee_user_id = ? AND status = 'settled' AND COALESCE(settled_ms, created_ms) >= ?`).bind(id, monthStart).first<any>(),
    c.env.DB.prepare(`SELECT MAX(COALESCE(settled_ms, created_ms)) AS ms FROM x402_payments WHERE payee_user_id = ? AND status = 'settled'`).bind(id).first<any>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM x402_resources WHERE user_id = ? AND active = 1`).bind(id).first<any>(),
    c.env.DB.prepare(`SELECT strftime('%Y-%m', COALESCE(settled_ms, created_ms)/1000, 'unixepoch') AS ym, COUNT(*) AS n, COALESCE(SUM(amount_usd),0) AS usd FROM x402_payments WHERE payee_user_id = ? AND status = 'settled' GROUP BY ym ORDER BY ym DESC LIMIT 12`).bind(id).all(),
    c.env.DB.prepare(`SELECT r.title AS title, COUNT(*) AS n, COALESCE(SUM(p.amount_usd),0) AS usd FROM x402_payments p JOIN x402_resources r ON r.id = p.resource_id WHERE p.payee_user_id = ? AND p.status = 'settled' GROUP BY p.resource_id ORDER BY usd DESC LIMIT 5`).bind(id).all(),
  ]);

  const by_status: Record<string, { n: number; usd: number }> = {};
  let failed = 0;
  for (const r of (byStatus.results ?? []) as any[]) {
    by_status[r.status] = { n: Number(r.n) || 0, usd: Number(r.usd) || 0 };
    if (r.status === 'failed') failed = Number(r.n) || 0;
  }
  const count = Number(settled?.n) || 0;
  const total = Number(settled?.usd) || 0;

  return c.json({
    ok: true,
    summary: {
      total_received_usd: total,
      count,
      this_month_usd: Number(thisMonth?.usd) || 0,
      avg_usd: count ? Math.round((total / count) * 100) / 100 : 0,
      failed_count: failed,
      active_links: Number(activeLinks?.n) || 0,
      pending_invoices: 0, // invoices land in W3/W4
      last_payment_ms: lastPay?.ms ?? null,
    },
    by_status,
    by_provider: { x402: { n: count, usd: total } }, // only x402 settles today
    monthly: ((monthly.results ?? []) as any[]).reverse().map((r) => ({ ym: r.ym, n: Number(r.n) || 0, usd: Number(r.usd) || 0 })),
    top_links: ((topLinks.results ?? []) as any[]).map((r) => ({ title: r.title, n: Number(r.n) || 0, usd: Number(r.usd) || 0 })),
  });
});

// ── Payment links (map onto x402_resources) ───────────────────────────────────
// A "payment link" is an x402 resource enriched with a provider kind + currency.
// Only kind='x402' settles on-chain today; stripe/donation/invoice are recorded
// but flagged not-live (the UI labels them clearly — no fake settlement).
const LINK_KINDS = ['x402', 'stripe', 'donation', 'invoice'];
const slugify = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
const slugOk = (s: string) => /^[a-z0-9][a-z0-9-]{0,47}$/.test(s);

function payUrlFor(reqUrl: string, userId: string, slug: string, kind: string): string | null {
  if (kind !== 'x402') return null; // only x402 has a live pay endpoint
  return new URL(`/api/x402/pay/${userId}/${slug}`, reqUrl).toString();
}

// GET /api/profile/payment-links — caller's links + per-link paid count + revenue.
profile.get('/payment-links', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const includeArchived = c.req.query('archived') === '1';
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.slug, r.title, r.description, r.price_usd, r.currency, r.kind, r.active,
            r.archived_ms, r.created_ms, r.updated_ms,
            COUNT(p.id) AS paid_count, COALESCE(SUM(p.amount_usd),0) AS revenue_usd
       FROM x402_resources r
       LEFT JOIN x402_payments p ON p.resource_id = r.id AND p.status = 'settled'
      WHERE r.user_id = ? ${includeArchived ? '' : 'AND r.archived_ms IS NULL'}
      GROUP BY r.id ORDER BY r.created_ms DESC`
  ).bind(me.id).all();
  const links = ((results ?? []) as any[]).map((r) => ({
    id: r.id, slug: r.slug, title: r.title, description: r.description ?? null,
    price_usd: Number(r.price_usd) || 0, currency: r.currency || 'USDC', kind: r.kind || 'x402',
    active: Boolean(r.active), archived: Boolean(r.archived_ms),
    created_ms: r.created_ms, updated_ms: r.updated_ms,
    paid_count: Number(r.paid_count) || 0, revenue_usd: Number(r.revenue_usd) || 0,
    payUrl: payUrlFor(c.req.url, me.id, r.slug, r.kind || 'x402'),
    live: (r.kind || 'x402') === 'x402',
  }));
  return c.json({ ok: true, links });
});

// POST /api/profile/payment-links — create a link (auto-slug from title if absent).
profile.post('/payment-links', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b !== 'object') return c.json({ error: 'bad_body' }, 400);
  const title = str(b.title, 120);
  if (!title) return c.json({ error: 'title_required' }, 400);
  let slug = b.slug ? slugify(String(b.slug)) : slugify(title);
  if (!slugOk(slug)) return c.json({ error: 'slug_invalid' }, 400);
  const price = Number(b.price_usd ?? b.amount);
  if (!(price >= 0) || !isFinite(price)) return c.json({ error: 'price_invalid' }, 400);
  const kind = LINK_KINDS.includes(b.kind) ? b.kind : 'x402';
  const currency = str(b.currency, 8) || (kind === 'x402' ? 'USDC' : 'USD');
  const active = b.active === false ? 0 : 1;
  const now = Date.now();

  // Unique (user, slug). On collision, append a short suffix rather than failing.
  const exists: any = await c.env.DB.prepare(`SELECT 1 FROM x402_resources WHERE user_id=? AND slug=?`).bind(me.id, slug).first();
  if (exists) slug = `${slug}-${Math.abs(now % 9000) + 1000}`.slice(0, 48);
  const id = uid('res');
  await c.env.DB.prepare(
    `INSERT INTO x402_resources (id,user_id,slug,title,description,price_usd,price_version,mime_type,kind,currency,active,created_ms,updated_ms)
     VALUES (?,?,?,?,?,?,1,'application/json',?,?,?,?,?)`
  ).bind(id, me.id, slug, title, str(b.description, 500), price, kind, currency, active, now, now).run();
  await audit(c, 'profile.link.create', { id, slug, kind });
  return c.json({ ok: true, link: { id, slug, title, price_usd: price, currency, kind, active: Boolean(active), payUrl: payUrlFor(c.req.url, me.id, slug, kind), live: kind === 'x402' } }, 201);
});

// PATCH /api/profile/payment-links/:id — update title/price/description/active/kind.
profile.patch('/payment-links/:id', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const id = c.req.param('id');
  const owns: any = await c.env.DB.prepare(`SELECT id FROM x402_resources WHERE id=? AND user_id=?`).bind(id, me.id).first();
  if (!owns) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b !== 'object') return c.json({ error: 'bad_body' }, 400);
  const sets: string[] = []; const vals: unknown[] = [];
  if (b.title !== undefined) { const t = str(b.title, 120); if (!t) return c.json({ error: 'title_required' }, 400); sets.push('title=?'); vals.push(t); }
  if (b.description !== undefined) { sets.push('description=?'); vals.push(str(b.description, 500)); }
  if (b.price_usd !== undefined) { const p = Number(b.price_usd); if (!(p >= 0) || !isFinite(p)) return c.json({ error: 'price_invalid' }, 400); sets.push('price_usd=?'); vals.push(p); }
  if (b.currency !== undefined) { sets.push('currency=?'); vals.push(str(b.currency, 8) || 'USD'); }
  if (b.kind !== undefined) { if (!LINK_KINDS.includes(b.kind)) return c.json({ error: 'kind_invalid' }, 400); sets.push('kind=?'); vals.push(b.kind); }
  if (b.active !== undefined) { if (typeof b.active !== 'boolean') return c.json({ error: 'active_must_be_boolean' }, 400); sets.push('active=?'); vals.push(b.active ? 1 : 0); }
  if (!sets.length) return c.json({ error: 'nothing_to_update' }, 400);
  sets.push('updated_ms=?'); vals.push(Date.now()); vals.push(id);
  await c.env.DB.prepare(`UPDATE x402_resources SET ${sets.join(', ')} WHERE id=?`).bind(...vals).run();
  await audit(c, 'profile.link.update', { id, fields: sets.map((s) => s.split('=')[0]) });
  return c.json({ ok: true });
});

// DELETE /api/profile/payment-links/:id — SOFT archive (preserve payment history FK).
profile.delete('/payment-links/:id', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const id = c.req.param('id');
  const owns: any = await c.env.DB.prepare(`SELECT id FROM x402_resources WHERE id=? AND user_id=?`).bind(id, me.id).first();
  if (!owns) return c.json({ error: 'not_found' }, 404);
  await c.env.DB.prepare(`UPDATE x402_resources SET active=0, archived_ms=?, updated_ms=? WHERE id=?`)
    .bind(Date.now(), Date.now(), id).run();
  await audit(c, 'profile.link.archive', { id });
  return c.json({ ok: true, archived: true });
});
