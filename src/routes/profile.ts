import { Hono } from 'hono';
import type { Env } from '../types';
import { getUserFromRequest, verifyPassword } from '../lib/auth';
import { audit } from '../lib/audit';
import { uid } from '../lib/db';
import { markStepUpConfirmed, enforceStepUp } from '../lib/stepup';
import { x402Network, x402Asset } from '../lib/x402';
import { scanFile } from '../security/file-scan';
import { notify } from '../lib/notify';
import {
  WITHDRAWAL_METHODS, type WithdrawalMethod, computeBalance, withdrawnLast24h,
  maskDestination, riskScore, PER_TX_MAX_USD, DAILY_MAX_USD, MIN_WITHDRAWAL_USD,
} from '../lib/withdrawals';

// Profile Command Center API. Every endpoint self-authenticates and is scoped to
// the caller's own user id — never returns secrets (no private keys, no raw
// wallet locator, no password hashes). Mounted at /api/profile.

export const profile = new Hono<{ Bindings: Env }>();

const LANGS = ['es', 'en', 'pt'];
// Handles that must never be taken as a vanity username (collide with routes/brand).
const RESERVED_HANDLES = new Set([
  'admin', 'administrador', 'api', 'app', 'sismo911', 'sismo', 'soporte', 'support',
  'cuenta', 'login', 'logout', 'registro', 'register', 'u', 'me', 'profile', 'perfil',
  'pagos', 'pay', 'wallet', 'console', 'operaciones', 'null', 'undefined', 'root', 'sistema',
]);
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
    `SELECT id, email, name, role, rank, unit, phone, country, city, language, username,
            wallet_address, wallet_chain, wallet_created_ms,
            x402_enabled, x402_pay_to, x402_network, x402_asset, x402_enabled_ms,
            settings_json, created_ms, last_login_ms, avatar_r2
       FROM users WHERE id = ?`
  ).bind(me.id).first();
  if (!u) return c.json({ error: 'not_found' }, 404);

  const totals: any = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount_usd),0) AS usd
       FROM x402_payments WHERE payee_user_id = ? AND status = 'settled'`
  ).bind(me.id).first();
  const network = u.x402_network || x402Network(c.env);

  // Profile completion: count the filled optional fields.
  const fields = [u.name, u.phone, u.country, u.city, u.language, u.wallet_address, u.avatar_r2];
  const completion = Math.round((fields.filter(Boolean).length / fields.length) * 100);

  return c.json({
    ok: true,
    profile: {
      id: u.id, email: u.email, name: u.name, role: u.role,
      username: u.username ?? null,
      rank: u.rank ?? null, unit: u.unit ?? null,
      phone: u.phone ?? null, country: u.country ?? null, city: u.city ?? null,
      language: u.language ?? 'es',
      created_ms: u.created_ms ?? null, last_login_ms: u.last_login_ms ?? null,
      completion,
      has_avatar: Boolean(u.avatar_r2),
      avatar_url: u.avatar_r2 ? `/api/u/${encodeURIComponent(u.id)}/avatar` : null,
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
  if (b.username !== undefined) {
    const raw = str(b.username, 30);
    if (raw) {
      const un = raw.toLowerCase();
      if (!/^[a-z0-9](?:[a-z0-9_-]{1,28}[a-z0-9])$/.test(un))
        return c.json({ error: 'username_invalid', detail: '3–30 caracteres: letras, números, guion o guion bajo; empieza y termina en letra/número' }, 400);
      if (RESERVED_HANDLES.has(un)) return c.json({ error: 'username_reserved' }, 409);
      const taken: any = await c.env.DB.prepare(`SELECT id FROM users WHERE username = ? AND id != ?`).bind(un, me.id).first();
      if (taken) return c.json({ error: 'username_taken' }, 409);
      sets.push('username = ?'); vals.push(un);
    } else {
      sets.push('username = ?'); vals.push(null); // clear the handle
    }
  }
  if (!sets.length) return c.json({ error: 'nothing_to_update' }, 400);
  vals.push(me.id);
  try {
    await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  } catch (e: any) {
    // Unique-index race on username → surface as taken rather than a 500.
    if (String(e?.message || '').includes('UNIQUE')) return c.json({ error: 'username_taken' }, 409);
    throw e;
  }
  await audit(c, 'profile.update', { fields: sets.map((s) => s.split(' ')[0]) });

  const u: any = await c.env.DB.prepare(
    `SELECT name, phone, country, city, language, username FROM users WHERE id = ?`
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
  // Changing security/privacy settings is itself sensitive — a hijacked session
  // must not be able to silently disable sec_require_login. (Enabling it the first
  // time is allowed because the gate reads the CURRENT, not-yet-set, value.)
  const stepUp = await enforceStepUp(c, me.id); if (stepUp) return stepUp;
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

// ── POST /api/profile/confirm — step-up re-authentication ─────────────────────
// Verifies the caller's password and records a short-lived confirmation (KV) so
// sensitive actions can proceed when the user has enabled sec_require_login.
profile.post('/confirm', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const b = await c.req.json().catch(() => null);
  const password = b && typeof b.password === 'string' ? b.password : '';
  if (!password) return c.json({ error: 'password_required' }, 400);
  const row: any = await c.env.DB.prepare(`SELECT pw_hash, pw_salt FROM users WHERE id = ?`).bind(me.id).first();
  if (!row?.pw_hash || !row?.pw_salt) return c.json({ error: 'no_password_set' }, 400);
  if (!(await verifyPassword(password, row.pw_hash, row.pw_salt))) {
    await audit(c, 'profile.stepup.fail', {});
    return c.json({ error: 'invalid_password' }, 401);
  }
  await markStepUpConfirmed(c.env, me.id);
  await audit(c, 'profile.stepup.ok', {});
  return c.json({ ok: true });
});

// ── Avatar upload rules ───────────────────────────────────────────────────────
// Accepts a profile photo and stores it under a per-user KV key (PHOTOS), with the
// key recorded in users.avatar_r2. Served publicly (image bytes only, no PII) via
// GET /api/u/:id/avatar. Hard rules, enforced by scanFile (src/security/file-scan):
//   • type: jpeg / png / webp ONLY — magic-byte sniffed, declared MIME must agree
//   • no SVG (script-bearing), no executables, no polyglots
//   • size: ≤ 2 MB (pre-checked on Content-Length, re-checked on bytes)
// Idempotent key (avatar:{userId}) → re-upload overwrites; old bytes are replaced.
const AVATAR_MAX_BYTES = 2_000_000;

// ── POST /api/profile/avatar — upload/replace the caller's profile photo ───────
// Accepts multipart/form-data (field "file" or "avatar") OR JSON { dataUrl }.
profile.post('/avatar', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);

  // Reject oversized uploads before reading the body when the client declares it.
  const declaredLen = Number(c.req.header('content-length') || 0);
  if (declaredLen && declaredLen > AVATAR_MAX_BYTES + 100_000)
    return c.json({ error: 'too_large', detail: `max ${AVATAR_MAX_BYTES} bytes` }, 413);

  let bytes: Uint8Array | null = null;
  let declaredMime: string | null = null;
  let filename: string | null = null;

  const ctype = (c.req.header('content-type') || '').toLowerCase();
  if (ctype.includes('multipart/form-data')) {
    const form = await c.req.formData().catch(() => null);
    const file = (form?.get('file') || form?.get('avatar')) as unknown;
    if (file && typeof file !== 'string' && typeof (file as File).arrayBuffer === 'function') {
      bytes = new Uint8Array(await (file as File).arrayBuffer());
      declaredMime = (file as File).type || null;
      filename = (file as File).name || null;
    }
  } else {
    const b = await c.req.json().catch(() => null);
    const dataUrl = b && typeof b.dataUrl === 'string' ? b.dataUrl : null;
    if (dataUrl) {
      const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (m) {
        declaredMime = m[1];
        try {
          const bin = atob(m[2]);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          bytes = arr;
        } catch { bytes = null; }
      }
    }
  }

  if (!bytes || !bytes.length) return c.json({ error: 'no_image', detail: 'envía un archivo de imagen' }, 400);

  // Magic-byte + size + type validation (jpeg/png/webp, ≤2MB, no svg/executable).
  const scan = await scanFile(bytes, { maxSize: AVATAR_MAX_BYTES, declaredMime, filename, allowSvg: false });
  if (!scan.ok) return c.json({ error: 'invalid_image', reason: scan.reason }, 400);

  const contentType = `image/${scan.detectedType}`;
  const key = `avatar:${me.id}`;
  await c.env.PHOTOS.put(key, bytes, { metadata: { contentType } });
  await c.env.DB.prepare(`UPDATE users SET avatar_r2 = ? WHERE id = ?`).bind(key, me.id).run();
  await audit(c, 'profile.avatar.upload', { type: scan.detectedType, size: scan.size });

  // Cache-bust the public avatar URL so the new image shows immediately.
  return c.json({ ok: true, avatar_url: `/api/u/${encodeURIComponent(me.id)}/avatar?v=${Date.now()}` });
});

// ── DELETE /api/profile/avatar — remove the caller's profile photo ─────────────
profile.delete('/avatar', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  await c.env.PHOTOS.delete(`avatar:${me.id}`).catch(() => {});
  await c.env.DB.prepare(`UPDATE users SET avatar_r2 = NULL WHERE id = ?`).bind(me.id).run();
  await audit(c, 'profile.avatar.delete', {});
  return c.json({ ok: true });
});

// ── Notifications (in-app bell) ───────────────────────────────────────────────
// Self-scoped to the caller. Rows are produced by real events via src/lib/notify.

// GET /api/profile/notifications?limit=&before= — newest-first list + unread count.
profile.get('/notifications', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const limit = Math.min(50, Math.max(1, Number(c.req.query('limit')) || 20));
  const before = Number(c.req.query('before')) || 0;

  const { results } = await c.env.DB.prepare(
    `SELECT id, type, title, body, link, read_ms, created_ms
       FROM notifications
      WHERE user_id = ? ${before ? 'AND created_ms < ?' : ''}
      ORDER BY created_ms DESC LIMIT ?`
  ).bind(...(before ? [me.id, before, limit] : [me.id, limit])).all();

  const unreadRow: any = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_ms IS NULL`
  ).bind(me.id).first();

  const notifications = ((results ?? []) as any[]).map((r) => ({
    id: r.id, type: r.type, title: r.title, body: r.body ?? null,
    link: r.link ?? null, read: r.read_ms != null, created_ms: r.created_ms,
  }));
  return c.json({ ok: true, notifications, unread: Number(unreadRow?.n) || 0 });
});

// GET /api/profile/notifications/count — lightweight unread badge count.
profile.get('/notifications/count', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const row: any = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_ms IS NULL`
  ).bind(me.id).first();
  return c.json({ ok: true, unread: Number(row?.n) || 0 });
});

// POST /api/profile/notifications/read — mark one ({id}) or all ({all:true}) read.
profile.post('/notifications/read', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const b = await c.req.json().catch(() => ({}));
  const now = Date.now();
  if (b && b.all === true) {
    await c.env.DB.prepare(
      `UPDATE notifications SET read_ms = ? WHERE user_id = ? AND read_ms IS NULL`
    ).bind(now, me.id).run();
  } else if (b && typeof b.id === 'string') {
    await c.env.DB.prepare(
      `UPDATE notifications SET read_ms = ? WHERE id = ? AND user_id = ? AND read_ms IS NULL`
    ).bind(now, b.id, me.id).run();
  } else {
    return c.json({ error: 'bad_body', detail: 'envía {id} o {all:true}' }, 400);
  }
  const row: any = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_ms IS NULL`
  ).bind(me.id).first();
  return c.json({ ok: true, unread: Number(row?.n) || 0 });
});

// ── POST /api/profile/plan-interest — register interest in the Pro plan ─────────
// Honest waitlist: records the interest (audit) and drops a confirmation
// notification. No fake billing — there is no charge and no fake price.
profile.post('/plan-interest', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  await audit(c, 'profile.plan.interest', { plan: 'pro' });
  await notify(c.env, me.id, {
    type: 'plan_interest',
    title: 'Te avisaremos sobre el plan Pro',
    body: 'Gracias por tu interés. Te notificaremos aquí cuando el plan Pro esté disponible.',
    link: null,
  });
  return c.json({ ok: true });
});

// ── GET /api/profile/payments/export.csv — download the caller's payment ledger ─
// Real CSV (not a stub). Self-scoped: only the caller's received payments.
profile.get('/payments/export.csv', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const { results } = await c.env.DB.prepare(
    `SELECT p.created_ms, p.settled_ms, p.status, p.amount_usd, p.asset, p.network,
            p.payer, p.tx_hash, r.title AS resource_title, r.slug
       FROM x402_payments p
       LEFT JOIN x402_resources r ON r.id = p.resource_id
      WHERE p.payee_user_id = ?
      ORDER BY p.created_ms DESC LIMIT 5000`
  ).bind(me.id).all();

  // CSV-escape: wrap in quotes, double internal quotes; guard against formula injection.
  const cell = (v: unknown) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const iso = (ms: unknown) => {
    const n = Number(ms);
    return n ? new Date(n).toISOString() : '';
  };
  const header = ['fecha_creado', 'fecha_liquidado', 'estado', 'monto_usd', 'activo', 'red', 'pagador', 'tx_hash', 'enlace', 'slug'];
  const rows = ((results ?? []) as any[]).map((r) => [
    iso(r.created_ms), iso(r.settled_ms), r.status, r.amount_usd, r.asset, r.network,
    r.payer, r.tx_hash, r.resource_title, r.slug,
  ].map(cell).join(','));
  const csv = [header.map(cell).join(','), ...rows].join('\r\n') + '\r\n';

  const fname = `sismo911-pagos-${new Date().toISOString().slice(0, 10)}.csv`;
  return new Response('﻿' + csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fname}"`,
      'Cache-Control': 'no-store',
    },
  });
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
  const stepUp = await enforceStepUp(c, me.id); if (stepUp) return stepUp;
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
  await notify(c.env, me.id, {
    type: 'link_created',
    title: 'Enlace de pago creado',
    body: `"${title}" ya está listo para compartir y recibir pagos.`,
    link: '#pagos',
  });
  return c.json({ ok: true, link: { id, slug, title, price_usd: price, currency, kind, active: Boolean(active), payUrl: payUrlFor(c.req.url, me.id, slug, kind), live: kind === 'x402' } }, 201);
});

// PATCH /api/profile/payment-links/:id — update title/price/description/active/kind.
profile.patch('/payment-links/:id', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const stepUp = await enforceStepUp(c, me.id); if (stepUp) return stepUp;
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
  const stepUp = await enforceStepUp(c, me.id); if (stepUp) return stepUp;
  const id = c.req.param('id');
  const owns: any = await c.env.DB.prepare(`SELECT id FROM x402_resources WHERE id=? AND user_id=?`).bind(id, me.id).first();
  if (!owns) return c.json({ error: 'not_found' }, 404);
  await c.env.DB.prepare(`UPDATE x402_resources SET active=0, archived_ms=?, updated_ms=? WHERE id=?`)
    .bind(Date.now(), Date.now(), id).run();
  await audit(c, 'profile.link.archive', { id });
  return c.json({ ok: true, archived: true });
});

// ── Accounting ledger (over the x402 payments) ────────────────────────────────
const TAX_CATEGORIES = ['ingreso', 'donacion', 'servicio', 'venta', 'reembolso', 'otro'];

// GET /api/profile/accounting/ledger — the caller's received-payment ledger +
// accounting KPIs. x402 settles the full amount on-chain, so fees = 0 (gross=net).
profile.get('/accounting/ledger', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.created_ms, p.settled_ms, p.payer, p.amount_usd, p.asset, p.status,
            p.tx_hash, p.authorization_hash, p.tax_category, p.notes, p.reconciled, p.reconciled_ms,
            r.title AS link_title, r.kind AS provider
       FROM x402_payments p
       LEFT JOIN x402_resources r ON r.id = p.resource_id
      WHERE p.payee_user_id = ? ORDER BY p.created_ms DESC LIMIT 500`
  ).bind(me.id).all();

  const rows = ((results ?? []) as any[]).map((p) => ({
    id: p.id, date_ms: p.settled_ms || p.created_ms, payer: p.payer ?? null,
    provider: p.provider || 'x402', amount_usd: Number(p.amount_usd) || 0, currency: p.asset || 'USDC',
    status: p.status, link_title: p.link_title ?? null,
    tx_hash: p.tx_hash ?? null, ref: p.tx_hash || p.authorization_hash || null,
    tax_category: p.tax_category ?? null, notes: p.notes ?? null,
    reconciled: Boolean(p.reconciled), reconciled_ms: p.reconciled_ms ?? null,
  }));

  // KPIs over SETTLED rows only (real money). Fees are 0 for x402 → net = gross.
  const settled = rows.filter((r) => r.status === 'settled');
  const gross = settled.reduce((s, r) => s + r.amount_usd, 0);
  const reconciledAmt = settled.filter((r) => r.reconciled).reduce((s, r) => s + r.amount_usd, 0);
  const byMonth: Record<string, number> = {};
  for (const r of settled) {
    const ym = new Date(r.date_ms || 0).toISOString().slice(0, 7);
    byMonth[ym] = (byMonth[ym] || 0) + r.amount_usd;
  }
  return c.json({
    ok: true,
    rows,
    kpis: {
      gross_usd: Math.round(gross * 100) / 100,
      fees_usd: 0,                       // x402 settles full amount on-chain
      net_usd: Math.round(gross * 100) / 100,
      reconciled_usd: Math.round(reconciledAmt * 100) / 100,
      unreconciled_usd: Math.round((gross - reconciledAmt) * 100) / 100,
      count: settled.length,
    },
    monthly: Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b)).map(([ym, usd]) => ({ ym, usd: Math.round(usd * 100) / 100 })),
  });
});

// PATCH /api/profile/accounting/ledger/:id — set tax_category / notes / reconciled.
profile.patch('/accounting/ledger/:id', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const id = c.req.param('id');
  const owns: any = await c.env.DB.prepare(`SELECT id FROM x402_payments WHERE id=? AND payee_user_id=?`).bind(id, me.id).first();
  if (!owns) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b !== 'object') return c.json({ error: 'bad_body' }, 400);
  const sets: string[] = []; const vals: unknown[] = [];
  if (b.tax_category !== undefined) {
    const tc = str(b.tax_category, 40);
    if (tc && !TAX_CATEGORIES.includes(tc)) return c.json({ error: 'tax_category_invalid' }, 400);
    sets.push('tax_category=?'); vals.push(tc);
  }
  if (b.notes !== undefined) { sets.push('notes=?'); vals.push(str(b.notes, 1000)); }
  if (b.reconciled !== undefined) {
    if (typeof b.reconciled !== 'boolean') return c.json({ error: 'reconciled_must_be_boolean' }, 400);
    sets.push('reconciled=?'); vals.push(b.reconciled ? 1 : 0);
    sets.push('reconciled_ms=?'); vals.push(b.reconciled ? Date.now() : null);
  }
  if (!sets.length) return c.json({ error: 'nothing_to_update' }, 400);
  vals.push(id);
  await c.env.DB.prepare(`UPDATE x402_payments SET ${sets.join(', ')} WHERE id=?`).bind(...vals).run();
  await audit(c, 'profile.accounting.update', { id, fields: sets.map((s) => s.split('=')[0]) });
  return c.json({ ok: true });
});

// ── Withdrawals / payouts ─────────────────────────────────────────────────────
function publicRequest(r: any) {
  // Only ever expose the masked summary + redacted details — never raw destination.
  return {
    id: r.id, method_type: r.method_type, amount_source: Number(r.amount_source) || 0,
    source_currency: r.source_currency, payout_currency: r.payout_currency,
    exchange_rate: r.exchange_rate ?? null, fee_amount: Number(r.fee_amount) || 0,
    net_amount: Number(r.net_amount) || 0, destination_summary: r.destination_summary ?? null,
    destination: (() => { try { return r.destination_details_json ? JSON.parse(r.destination_details_json) : null; } catch { return null; } })(),
    status: r.status, provider: r.provider ?? null, risk_score: Number(r.risk_score) || 0,
    review_note: r.review_note ?? null, created_ms: r.created_ms, updated_ms: r.updated_ms, completed_ms: r.completed_ms ?? null,
  };
}

// GET /api/profile/withdrawals — balance + saved methods + request history (masked).
profile.get('/withdrawals', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const [balance, methods, requests] = await Promise.all([
    computeBalance(c.env, me.id),
    c.env.DB.prepare(`SELECT id, type, label, details_json, is_default, created_ms FROM withdrawal_methods WHERE user_id = ? ORDER BY created_ms DESC`).bind(me.id).all(),
    c.env.DB.prepare(`SELECT * FROM withdrawal_requests WHERE user_id = ? ORDER BY created_ms DESC LIMIT 200`).bind(me.id).all(),
  ]);
  return c.json({
    ok: true,
    balance,
    limits: { per_tx_usd: PER_TX_MAX_USD, daily_usd: DAILY_MAX_USD, min_usd: MIN_WITHDRAWAL_USD },
    methods: ((methods.results ?? []) as any[]).map((m) => ({
      id: m.id, type: m.type, label: m.label, is_default: Boolean(m.is_default), created_ms: m.created_ms,
      details: (() => { try { return m.details_json ? JSON.parse(m.details_json) : null; } catch { return null; } })(),
    })),
    requests: ((requests.results ?? []) as any[]).map(publicRequest),
  });
});

// POST /api/profile/withdrawals — request a payout. Idempotent, balance-checked,
// limit-checked, audit-logged. Manual rails default to pending_review (never
// auto-completed). Destination details are masked before storage.
profile.post('/withdrawals', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const stepUp = await enforceStepUp(c, me.id); if (stepUp) return stepUp;
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b !== 'object') return c.json({ error: 'bad_body' }, 400);

  const method = String(b.method_type || '') as WithdrawalMethod;
  if (!WITHDRAWAL_METHODS.includes(method)) return c.json({ error: 'method_invalid' }, 400);
  if (method === 'stripe') return c.json({ error: 'method_unavailable', detail: 'Stripe payouts no están disponibles aún.' }, 400);
  const amount = Number(b.amount_source ?? b.amount);
  if (!(amount >= MIN_WITHDRAWAL_USD) || !isFinite(amount)) return c.json({ error: 'amount_invalid' }, 400);
  if (amount > PER_TX_MAX_USD) return c.json({ error: 'over_per_tx_limit', limit: PER_TX_MAX_USD }, 400);

  const idem = str(b.idempotency_key, 80);
  // Idempotency: a repeat with the same key returns the existing request (no double-spend).
  if (idem) {
    const dupe: any = await c.env.DB.prepare(`SELECT * FROM withdrawal_requests WHERE user_id=? AND idempotency_key=?`).bind(me.id, idem).first();
    if (dupe) return c.json({ ok: true, idempotent: true, request: publicRequest(dupe) }, 200);
  }

  const now = Date.now();
  const fee = 0; // no platform payout fee today
  const net = Math.round((amount - fee) * 100) / 100;

  const balance = await computeBalance(c.env, me.id);
  if (net > balance.available_usd) return c.json({ error: 'insufficient_balance', available: balance.available_usd }, 400);
  const today = await withdrawnLast24h(c.env, me.id, now);
  if (today + net > DAILY_MAX_USD) return c.json({ error: 'over_daily_limit', limit: DAILY_MAX_USD, already: today }, 400);

  const { summary, redacted } = maskDestination(method, (b.destination && typeof b.destination === 'object') ? b.destination : {});
  const risk = riskScore(method, amount);
  // No licensed payout provider → ALWAYS pending_review (manual operator action).
  const status = 'pending_review';
  const id = uid('wr');
  try {
    await c.env.DB.prepare(
      `INSERT INTO withdrawal_requests (id,user_id,method_type,amount_source,source_currency,payout_currency,exchange_rate,fee_amount,net_amount,destination_summary,destination_details_json,status,idempotency_key,risk_score,created_ms,updated_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(id, me.id, method, amount, str(b.source_currency, 8) || 'USDC', str(b.payout_currency, 8) || 'USD',
      b.exchange_rate != null ? Number(b.exchange_rate) : null, fee, net, summary, JSON.stringify(redacted), status, idem, risk, now, now).run();
  } catch (e: any) {
    if (String(e?.message || '').includes('UNIQUE')) { // idem race
      const dupe: any = await c.env.DB.prepare(`SELECT * FROM withdrawal_requests WHERE user_id=? AND idempotency_key=?`).bind(me.id, idem).first();
      if (dupe) return c.json({ ok: true, idempotent: true, request: publicRequest(dupe) }, 200);
    }
    throw e;
  }
  await audit(c, 'withdrawal.create', { id, method, amount, risk, status });
  await notify(c.env, me.id, {
    type: 'withdrawal_update',
    title: 'Solicitud de retiro recibida',
    body: `Tu retiro de $${Number(amount).toFixed(2)} está en revisión. Te avisaremos cuando cambie de estado.`,
    link: '#retiros',
    email: true,
  });
  const row: any = await c.env.DB.prepare(`SELECT * FROM withdrawal_requests WHERE id=?`).bind(id).first();
  return c.json({ ok: true, request: publicRequest(row) }, 201);
});

// PATCH /api/profile/withdrawals/:id/cancel — user cancels a not-yet-processed request.
profile.patch('/withdrawals/:id/cancel', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const stepUp = await enforceStepUp(c, me.id); if (stepUp) return stepUp;
  const id = c.req.param('id');
  const row: any = await c.env.DB.prepare(`SELECT id, status FROM withdrawal_requests WHERE id=? AND user_id=?`).bind(id, me.id).first();
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (!['draft', 'pending_review'].includes(row.status)) return c.json({ error: 'not_cancellable', status: row.status }, 409);
  await c.env.DB.prepare(`UPDATE withdrawal_requests SET status='cancelled', updated_ms=? WHERE id=?`).bind(Date.now(), id).run();
  await audit(c, 'withdrawal.cancel', { id });
  await notify(c.env, me.id, {
    type: 'withdrawal_update',
    title: 'Retiro cancelado',
    body: 'Cancelaste tu solicitud de retiro.',
    link: '#retiros',
  });
  return c.json({ ok: true, status: 'cancelled' });
});

// ── Withdrawal methods (saved payout destinations) ────────────────────────────
profile.post('/withdrawal-methods', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const stepUp = await enforceStepUp(c, me.id); if (stepUp) return stepUp;
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b !== 'object') return c.json({ error: 'bad_body' }, 400);
  const type = String(b.type || '') as WithdrawalMethod;
  if (!WITHDRAWAL_METHODS.includes(type)) return c.json({ error: 'type_invalid' }, 400);
  const { summary, redacted } = maskDestination(type, (b.details && typeof b.details === 'object') ? b.details : {});
  const label = str(b.label, 80) || summary;
  const now = Date.now();
  const id = uid('wm');
  await c.env.DB.prepare(
    `INSERT INTO withdrawal_methods (id,user_id,type,label,details_json,is_default,created_ms,updated_ms) VALUES (?,?,?,?,?,?,?,?)`
  ).bind(id, me.id, type, label, JSON.stringify(redacted), b.is_default ? 1 : 0, now, now).run();
  await audit(c, 'withdrawal.method.add', { id, type });
  return c.json({ ok: true, method: { id, type, label, is_default: Boolean(b.is_default), details: redacted } }, 201);
});

profile.delete('/withdrawal-methods/:id', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const stepUp = await enforceStepUp(c, me.id); if (stepUp) return stepUp;
  const id = c.req.param('id');
  const owns: any = await c.env.DB.prepare(`SELECT id FROM withdrawal_methods WHERE id=? AND user_id=?`).bind(id, me.id).first();
  if (!owns) return c.json({ error: 'not_found' }, 404);
  await c.env.DB.prepare(`DELETE FROM withdrawal_methods WHERE id=?`).bind(id).run();
  await audit(c, 'withdrawal.method.delete', { id });
  return c.json({ ok: true });
});
