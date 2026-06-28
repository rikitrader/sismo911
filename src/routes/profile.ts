import { Hono } from 'hono';
import type { Env } from '../types';
import { getUserFromRequest } from '../lib/auth';
import { audit } from '../lib/audit';
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
