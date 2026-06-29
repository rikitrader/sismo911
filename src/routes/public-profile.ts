import { Hono } from 'hono';
import type { Env } from '../types';

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
