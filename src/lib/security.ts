import type { Context } from 'hono';
import type { Env } from '../types';
import { STRICT_SCRIPT_SRC } from './csp';

const DEFAULT_ORIGINS = [
  'https://sismo911.com',
  'https://www.sismo911.com',
  'https://app.sismo911.com',
  // SUMINISTROS division is served from its own subdomain (custom_domain route);
  // its SPA issues same-origin operator writes from this Origin, so it must be
  // trusted by the CSRF same-site check or every write returns bad_origin.
  'https://suministros.sismo911.com',
];

export function allowedOrigins(env: Env): string[] {
  const extra = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...DEFAULT_ORIGINS, ...extra];
}

export function isAllowedOrigin(env: Env, origin: string | undefined): boolean {
  if (!origin) return true;
  // Localhost dev origins stay trusted for the local `wrangler dev` workflow.
  // NOTE (security follow-up): this implicit always-on localhost trust is a low-risk
  // defense-in-depth gap in prod (mitigated by SameSite=Lax+Secure cookies and
  // credentials:false CORS). Replace with a dev-only flag rather than removing it
  // outright, so local dev keeps working. Tracked in the security follow-ups.
  if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) return true;
  return allowedOrigins(env).includes(origin);
}

/**
 * Constant-time string comparison for secret/token checks (avoids leaking a
 * high-entropy token byte-by-byte via response timing). Length-checked, then
 * XOR-accumulated over the chars. Use for any request-supplied secret/token
 * compare instead of `===`/`!==`.
 */
export function timingSafeEqualStr(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function setSecurityHeaders(c: Context) {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('X-DNS-Prefetch-Control', 'off');
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), payment=(), usb=(), browsing-topics=()');
  c.header('Cross-Origin-Opener-Policy', 'same-origin');
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
  c.header('Origin-Agent-Cluster', '?1');
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    'upgrade-insecure-requests',
    // 'unsafe-eval' removed: no page loads the Tailwind Play CDN (CSS is built to
    // static app.css) and no remaining script source needs eval(). 'unsafe-inline'
    // stays in the ENFORCING policy only because pages still carry inline <script>
    // blocks. The Report-Only header below runs the STRICT (hashed, no unsafe-inline)
    // policy in parallel to measure what must be refactored before we can enforce it.
    "script-src 'self' 'unsafe-inline' https://unpkg.com https://esm.sh https://static.cloudflareinsights.com https://maps.googleapis.com https://js.stripe.com https://*.crossmint.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com https://esm.sh",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https://earthquake.usgs.gov https://api.weather.gov https://www.fema.gov https://overpass-api.de https://overpass.kumi.systems https://maps.mail.ru https://cloudflareinsights.com https://fonts.googleapis.com https://fonts.gstatic.com https://unpkg.com https://esm.sh https://maps.googleapis.com https://maps.gstatic.com https://api.stripe.com https://staging.crossmint.com https://www.crossmint.com https://*.crossmint.com",
    // Crossmint Embedded Checkout (card → USDC) + its Stripe-Elements iframe.
    // Blog ("Noticias") source-video iframes: YouTube, TikTok, Instagram.
    "frame-src 'self' https://*.crossmint.com https://js.stripe.com https://*.stripe.com https://www.youtube-nocookie.com https://www.youtube.com https://www.tiktok.com https://www.instagram.com",
    "worker-src 'self'",
    "manifest-src 'self'",
  ];
  c.header('Content-Security-Policy', directives.join('; '));
  // Report-Only strict CSP (observational; blocks NOTHING): same directives, but a
  // hashed script-src with NO 'unsafe-inline'. Violations (the 19 inline-handler
  // pages + the dynamic Worker-rendered pages) are POSTed to /api/csp-report so we
  // can refactor them, then flip this to the enforcing header. (M5/M1 vault item.)
  c.header(
    'Content-Security-Policy-Report-Only',
    [
      // `upgrade-insecure-requests` is ignored in a Report-Only policy (browsers
      // warn) — keep it only in the enforcing header above, drop it here.
      ...directives
        .filter((d) => d !== 'upgrade-insecure-requests')
        .map((d) => (d.startsWith('script-src') ? `script-src ${STRICT_SCRIPT_SRC}` : d)),
      'report-uri /api/csp-report',
    ].join('; '),
  );
}

export function requestIp(c: Context): string {
  return (
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

// Mask a phone/email for public display (anti-scraping): the raw value is never
// sent in list/profile JSON — only this mask, plus has_* flags. The full value
// comes from a separate rate-limited reveal endpoint on a human click.
//   phone "04129979186" → "0412•••186"   ·   email "ixela@gmail.com" → "ix•••@gmail.com"
export function maskPhone(phone: string | null | undefined): string | null {
  const d = String(phone ?? '').replace(/[^\d+]/g, '');
  if (d.replace(/\D/g, '').length < 6) return d ? '•••' : null;
  const head = d.slice(0, 4), tail = d.slice(-3);
  return `${head}•••${tail}`;
}
export function maskEmail(email: string | null | undefined): string | null {
  const e = String(email ?? '').trim();
  const at = e.indexOf('@');
  if (at < 1) return e ? '•••' : null;
  const user = e.slice(0, at), dom = e.slice(at);
  return `${user.slice(0, 2)}•••${dom}`;
}
// Returns {has_phone, has_email, contact_mask} for a free-text contact field that
// may hold a phone, an email, or both. contact_mask prefers the phone.
export function maskContact(contact: string | null | undefined): { has_phone: boolean; has_email: boolean; contact_mask: string | null } {
  const s = String(contact ?? '').trim();
  const emailMatch = s.match(/[^\s,;]+@[^\s,;]+\.[^\s,;]+/);
  const phoneDigits = s.replace(/[^\d]/g, '');
  const has_email = !!emailMatch;
  const has_phone = phoneDigits.length >= 6;
  const contact_mask = has_phone ? maskPhone(s.replace(/[^\d+]/g, '')) : (has_email ? maskEmail(emailMatch![0]) : null);
  return { has_phone, has_email, contact_mask };
}

export async function rateLimit(
  env: Env,
  c: Context,
  name: string,
  limit: number,
  windowSec: number
): Promise<Response | null> {
  // Delegates to the D1-atomic limiter. The previous implementation did a KV
  // `put` on EVERY request; across the busy public write endpoints (SOS,
  // check-ins, familia, reports, damage, donations) that exhausted the free-tier
  // daily KV write cap (~1,000/day) — after which ALL Worker KV writes silently
  // stopped committing (the usgs:latest hot cache, etc. went dead). D1 is atomic,
  // fails open, and does NOT consume the KV write budget. Same (name,limit,window)
  // semantics, so every call site is unchanged.
  return burstLimit(env, c, name, limit, windowSec);
}

/**
 * Atomic burst limiter backed by D1. A single SQLite statement increments the
 * per-(name,ip) counter and returns the new value, so unlike rateLimit() (KV
 * read-then-write race, and KV throttles hot keys to ~1 write/s → 429/500) this
 * is genuinely atomic and sustains bursts. Use it on public, abuse-prone write
 * endpoints. Returns a 429 Response when the cap is exceeded, else null. Any DB
 * error fails OPEN — never block a write on infra failure.
 *
 * NOTE: never call this on life-safety endpoints (SOS, "I'm safe"); those must
 * fail open — a dropped emergency submission is worse than a few extra.
 */
export async function burstLimit(
  env: Env,
  c: Context,
  name: string,
  limit = 30,
  windowSec = 60
): Promise<Response | null> {
  const key = `${name}:${requestIp(c)}`;
  const now = Date.now();
  const reset = now + windowSec * 1000;
  try {
    // Atomic: insert fresh, or if the existing window expired reset it to 1,
    // else increment. RETURNING gives us the post-write count in one round-trip.
    const row: any = await env.DB.prepare(
      `INSERT INTO rate_buckets (key, count, reset_ms) VALUES (?1, 1, ?2)
       ON CONFLICT(key) DO UPDATE SET
         count    = CASE WHEN reset_ms < ?3 THEN 1     ELSE count + 1 END,
         reset_ms = CASE WHEN reset_ms < ?3 THEN ?2    ELSE reset_ms  END
       RETURNING count, reset_ms`
    ).bind(key, reset, now).first();
    const count = Number(row?.count ?? 0);
    const resetMs = Number(row?.reset_ms ?? reset);
    if (count > limit) {
      return c.json({ error: 'rate_limited', retry_after: Math.max(1, Math.ceil((resetMs - now) / 1000)) }, 429);
    }
  } catch {
    return null; // DB error → fail open
  }
  return null;
}

// Normalizers for rate-limit subjects (so "A@B.com " and "+58 412-1" collapse to
// one bucket and can't be sidestepped by formatting).
export function normEmail(s: unknown): string { return String(s ?? '').trim().toLowerCase(); }
export function normPhone(s: unknown): string { return String(s ?? '').replace(/\D/g, '').slice(-12); }

// Per-SUBJECT limiter (email / phone), as opposed to burstLimit's per-IP key.
// Reuses the same atomic D1 `rate_buckets` row but keys on a HASH of the subject
// — no raw PII is stored, and the caller returns a GENERIC 429 so it never
// reveals whether the email/phone exists. Returns true when over the limit.
// Fails OPEN (never blocks a legit user) on any error. Empty subject = no-op.
export async function subjectLimit(
  env: Env,
  name: string,
  subject: string,
  limit: number,
  windowSec: number,
): Promise<boolean> {
  if (!subject) return false;
  let h: string;
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${name}:${subject}`));
    h = [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch { return false; }
  const key = `subj:${name}:${h}`;
  const now = Date.now();
  const reset = now + windowSec * 1000;
  try {
    const row: any = await env.DB.prepare(
      `INSERT INTO rate_buckets (key, count, reset_ms) VALUES (?1, 1, ?2)
       ON CONFLICT(key) DO UPDATE SET
         count    = CASE WHEN reset_ms < ?3 THEN 1  ELSE count + 1 END,
         reset_ms = CASE WHEN reset_ms < ?3 THEN ?2 ELSE reset_ms  END
       RETURNING count`
    ).bind(key, reset, now).first();
    return Number(row?.count ?? 0) > limit;
  } catch {
    return false; // DB error → fail open
  }
}

export function validLatLon(lat: unknown, lon: unknown): lat is number {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

export function blurCoord(n: unknown, decimals = 2): number | null {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

export function isImageBytes(bytes: Uint8Array, contentType: string): boolean {
  const jpg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const webp =
    bytes.length > 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50;
  if (contentType === 'image/jpeg') return jpg;
  if (contentType === 'image/png') return png;
  if (contentType === 'image/webp') return webp;
  return false;
}

// --- Link / spam-domain detection for public submissions -------------------
// Citizen missing-person reports never legitimately contain a website link.
// Blocking links/bare-domains at the door stops promotional link-spam (e.g.
// the "TRUSTEDF57 - infinityhotel.it" injection) before it can be created.
const URL_RE = /(https?:\/\/|www\.)/i;
const DOMAIN_RE = /\b[a-z0-9][a-z0-9-]{1,62}\.(it|com|net|org|info|biz|xyz|ru|cn|top|online|site|click|link|shop|store|vip|live|club|icu|app|io|me|co)\b/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// Known bot spam phrases flooded into the missing-persons form (e.g. the
// "SIMONE BURATTI GAY" ×353 flood). Kept in sync with SPAM_PHRASES in lib/clean.ts.
const SPAM_PHRASE_RE = /simone\s+buratti/i;

// HTML/script-injection (stored-XSS) markup in a NAME or report TITLE. A real
// person name or damage-report title never contains an HTML tag, a javascript:
// URI or an on*= event handler — these are abuse payloads (e.g. the stored
// '"><svg/onload=("@jofpin");>' case-name flood). We match a *tag-like* token
// (`<` immediately followed by a letter or `/`, i.e. '<svg', '<img', '</a'),
// `javascript:`/`data:text/html` URIs, and on*=handlers — deliberately NOT a bare
// `<`/`>` so a legitimate damage title like "grieta <5cm" / "muro >2m" is allowed.
// Kept in sync with markupNameWhere() in lib/clean.ts (the SQL twin).
const MARKUP_RE = /<\s*\/?\s*[a-z][a-z0-9]*|javascript:|data:text\/html|\bon[a-z]+\s*=/i;

/** A NAME/TITLE field carrying HTML tags, a javascript: URI or an on*= handler is XSS abuse. */
export function nameHasMarkup(s: string | null | undefined): boolean {
  if (!s) return false;
  return MARKUP_RE.test(s);
}

/** A NAME field that contains any link, bare domain, known spam phrase, or
 *  HTML/script-injection markup is spam — real names never do. */
export function nameHasSpam(s: string | null | undefined): boolean {
  if (!s) return false;
  return URL_RE.test(s) || DOMAIN_RE.test(s) || SPAM_PHRASE_RE.test(s) || nameHasMarkup(s);
}

/** Free text contains a promotional link/domain. Emails are stripped first so a
 *  legitimate contact email (maria@gmail.com) doesn't trip the domain check. */
export function textHasLink(s: string | null | undefined): boolean {
  if (!s) return false;
  const noEmail = s.replace(EMAIL_RE, ' ');
  return URL_RE.test(noEmail) || DOMAIN_RE.test(noEmail);
}
