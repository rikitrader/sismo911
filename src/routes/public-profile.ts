import { Hono } from 'hono';
import type { Env } from '../types';
import { isX402Live, x402Network, x402Asset } from '../lib/x402';

// Public payment profile — the page behind a citizen's "Enlace público"
// (sismo911.com/u/:id). PUBLIC by design: anyone, logged-in or not, can view a
// citizen's display name + their ACTIVE payment links so they can pay them.
// It exposes ONLY safe public fields: name, role, country, member-since, and
// each active link's title/price/pay URL. NEVER email, phone, city, wallet
// address, settings, completion, or any PII. Mounted at /api/u.

export const publicProfile = new Hono<{ Bindings: Env }>();

function parseSettings(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw) return {};
  try { const o = JSON.parse(raw); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}

const ROLE_LABEL: Record<string, string> = {
  citizen: 'Ciudadano', operator: 'Operador', admin: 'Administrador',
};

// GET /api/u/:id — public profile + active payment links for a citizen.
publicProfile.get('/:id', async (c) => {
  const id = c.req.param('id');
  if (!id || id.length > 64) return c.json({ ok: false, found: false }, 404);

  // Resolve by vanity handle (username, lowercased) OR raw user id.
  const u: any = await c.env.DB.prepare(
    `SELECT id, username, name, email, role, country, created_ms, settings_json,
            x402_enabled, wallet_address, avatar_r2
       FROM users WHERE username = ? OR id = ? LIMIT 1`
  ).bind(id.toLowerCase(), id).first();

  if (!u) return c.json({ ok: false, found: false }, 404);
  const uid = u.id as string; // canonical id for all downstream lookups/URLs

  const settings = parseSettings(u.settings_json);
  // Public unless the owner turned the public page OFF via EITHER the payment
  // pref (public_profile) or the security toggle (sec_public_page). Both default
  // to public when unset, so existing profiles stay reachable.
  const isPublic = settings.public_profile !== false && settings.sec_public_page !== false;
  if (!isPublic) return c.json({ ok: true, found: true, public: false });

  // Email is PRIVATE by default. It is exposed publicly ONLY when the owner has
  // explicitly opted in by turning the "Ocultar mi correo" toggle OFF (persisted
  // sec_hide_email === false). Unset/true → hidden. No other PII is ever exposed.
  const showEmail = settings.sec_hide_email === false;

  const receiving = settings.receive_payments !== false
    && Boolean(u.x402_enabled || u.wallet_address);

  const { results } = await c.env.DB.prepare(
    `SELECT slug, title, description, price_usd, currency, kind
       FROM x402_resources
      WHERE user_id = ? AND active = 1 AND archived_ms IS NULL
      ORDER BY created_ms DESC LIMIT 50`
  ).bind(uid).all();

  const links = ((results ?? []) as any[]).map((r) => ({
    slug: r.slug,
    title: r.title,
    description: r.description ?? null,
    price_usd: Number(r.price_usd) || 0,
    currency: r.currency || 'USDC',
    kind: r.kind || 'x402',
    payUrl: (r.kind || 'x402') === 'x402'
      ? new URL(`/api/x402/pay/${uid}/${r.slug}`, c.req.url).toString()
      : null,
  }));

  return c.json({
    ok: true,
    found: true,
    public: true,
    receiving,
    profile: {
      id: u.id,
      username: u.username || null,
      handle: u.username || u.id,           // what the public link should display
      name: u.name || null,
      role_label: ROLE_LABEL[u.role] || 'Ciudadano',
      country: u.country || null,
      created_ms: u.created_ms || null,
      email: showEmail ? (u.email || null) : null,
      has_avatar: Boolean(u.avatar_r2),
      avatar_url: u.avatar_r2 ? `/api/u/${encodeURIComponent(u.username || u.id)}/avatar` : null,
    },
    links,
  });
});

// Resolve a citizen by vanity handle (username) OR raw id, returning the
// public-safe wallet/x402 fields needed to render a checkout. NEVER returns PII.
async function resolvePayee(env: Env, id: string) {
  return env.DB.prepare(
    `SELECT id, username, name, role, x402_enabled, x402_pay_to, wallet_address,
            x402_network, x402_asset, settings_json
       FROM users WHERE username = ? OR id = ? LIMIT 1`
  ).bind(id.toLowerCase(), id).first<any>();
}

// One settled-revenue rollup for a resource (the donation "raised" amount).
async function settledTotals(env: Env, resourceId: string) {
  const r: any = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount_usd),0) AS usd
       FROM x402_payments WHERE resource_id = ? AND status = 'settled'`
  ).bind(resourceId).first();
  return { count: Number(r?.n) || 0, raised: Number(r?.usd) || 0 };
}

// GET /api/u/:id/cobro/:slug — PUBLIC checkout metadata for the hosted /pagar
// page. Returns only safe display fields + the receiving x402 config (a public
// receiving address is meant to be shared). The actual payment requirements are
// fetched from the 402 handshake against /api/x402/pay/:id/:slug, not here.
publicProfile.get('/:id/cobro/:slug', async (c) => {
  const id = c.req.param('id'); const slug = c.req.param('slug');
  if (!id || id.length > 64 || !slug || slug.length > 64) return c.json({ ok: false, found: false }, 404);
  const u = await resolvePayee(c.env, id);
  if (!u) return c.json({ ok: false, found: false }, 404);
  const r: any = await c.env.DB.prepare(
    `SELECT id, slug, title, description, price_usd, currency, kind, active,
            goal_usd, campaign_blurb, campaign_image, client_name, invoice_status
       FROM x402_resources
      WHERE user_id = ? AND slug = ? AND archived_ms IS NULL LIMIT 1`
  ).bind(u.id, slug).first();
  if (!r || !r.active) return c.json({ ok: false, found: false }, 404);
  if (r.kind === 'stripe') return c.json({ ok: false, found: false }, 404); // deferred

  const payTo = u.x402_pay_to || u.wallet_address || null;
  const receiving = Boolean(u.x402_enabled && payTo);
  const network = u.x402_network || x402Network(c.env);
  const totals = r.kind === 'donation' ? await settledTotals(c.env, r.id) : null;

  return c.json({
    ok: true, found: true,
    payee: { handle: u.username || u.id, name: u.name || null },
    link: {
      slug: r.slug, title: r.title, description: r.description ?? null,
      kind: r.kind || 'x402', price_usd: Number(r.price_usd) || 0, currency: r.currency || 'USDC',
      goal_usd: Number(r.goal_usd) || null, campaign_blurb: r.campaign_blurb ?? null,
      campaign_image: r.campaign_image ?? null,
      client_name: r.client_name ?? null, invoice_status: r.invoice_status ?? null,
      raised_usd: totals?.raised ?? null, donor_count: totals?.count ?? null,
      // open-amount donations carry price_usd=0; the payer names the amount.
      open_amount: (r.kind || 'x402') === 'donation' && (Number(r.price_usd) || 0) === 0,
    },
    x402: {
      live: isX402Live(c.env), receiving, payTo,
      network, asset: u.x402_asset || x402Asset(c.env, network),
      payUrl: new URL(`/api/x402/pay/${u.id}/${r.slug}`, c.req.url).toString(),
    },
  });
});

// GET /api/u/:id/campana/:slug — PUBLIC donation campaign (goal + raised +
// progress) behind the /campana page. 404 unless it's a public donation link.
publicProfile.get('/:id/campana/:slug', async (c) => {
  const id = c.req.param('id'); const slug = c.req.param('slug');
  if (!id || id.length > 64 || !slug || slug.length > 64) return c.json({ ok: false, found: false }, 404);
  const u = await resolvePayee(c.env, id);
  if (!u) return c.json({ ok: false, found: false }, 404);
  const r: any = await c.env.DB.prepare(
    `SELECT id, slug, title, description, currency, kind, active,
            goal_usd, campaign_blurb, campaign_image, campaign_public
       FROM x402_resources
      WHERE user_id = ? AND slug = ? AND archived_ms IS NULL LIMIT 1`
  ).bind(u.id, slug).first();
  if (!r || !r.active || (r.kind || 'x402') !== 'donation' || !r.campaign_public) {
    return c.json({ ok: false, found: false }, 404);
  }
  const goal = Number(r.goal_usd) || 0;
  const { raised, count } = await settledTotals(c.env, r.id);
  return c.json({
    ok: true, found: true,
    campaign: {
      slug: r.slug, title: r.title,
      blurb: r.campaign_blurb ?? r.description ?? null, image: r.campaign_image ?? null,
      currency: r.currency || 'USDC',
      goal_usd: goal || null, raised_usd: raised, donor_count: count,
      progress_pct: goal > 0 ? Math.min(100, Math.round((raised / goal) * 100)) : null,
    },
    payee: { handle: u.username || u.id, name: u.name || null },
    checkoutUrl: new URL(`/pagar/${u.id}/${r.slug}`, c.req.url).toString(),
  });
});

// GET /api/u/:id/avatar — public avatar image (served from KV when present).
// Falls through to 404 so the page renders initials. Safe: only image bytes,
// never PII. The bytes were magic-byte-validated at upload time (scanFile),
// and the content-type is constrained to the image types the upload admits.
publicProfile.get('/:id/avatar', async (c) => {
  const id = c.req.param('id');
  const u: any = await c.env.DB.prepare(`SELECT avatar_r2 FROM users WHERE username = ? OR id = ? LIMIT 1`)
    .bind(id.toLowerCase(), id).first().catch(() => null);
  if (!u || !u.avatar_r2) return c.notFound();
  const obj = await c.env.PHOTOS.getWithMetadata(u.avatar_r2 as string, 'arrayBuffer');
  if (!obj || !obj.value) return c.notFound();
  const meta = (obj.metadata || {}) as { contentType?: string };
  return new Response(obj.value, {
    headers: {
      'Content-Type': meta.contentType || 'image/jpeg',
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    },
  });
});
