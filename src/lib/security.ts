import type { Context } from 'hono';
import type { Env } from '../types';

const DEFAULT_ORIGINS = [
  'https://sismo911.com',
  'https://www.sismo911.com',
  'https://app.sismo911.com',
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
  if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) return true;
  return allowedOrigins(env).includes(origin);
}

export function setSecurityHeaders(c: Context) {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), payment=(), usb=(), browsing-topics=()');
  c.header(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://unpkg.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: https:",
      "connect-src 'self' https://earthquake.usgs.gov https://api.weather.gov https://www.fema.gov https://overpass-api.de https://overpass.kumi.systems https://maps.mail.ru",
      "worker-src 'self'",
      "manifest-src 'self'",
    ].join('; ')
  );
}

export function requestIp(c: Context): string {
  return (
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

export async function rateLimit(
  env: Env,
  c: Context,
  name: string,
  limit: number,
  windowSec: number
): Promise<Response | null> {
  const ip = requestIp(c);
  const now = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(now / windowSec);
  const key = `rl:${name}:${ip}:${bucket}`;
  const current = Number((await env.CACHE.get(key)) ?? '0');
  if (current >= limit) {
    return c.json({ error: 'rate_limited', retry_after: windowSec - (now % windowSec) }, 429);
  }
  await env.CACHE.put(key, String(current + 1), { expirationTtl: windowSec + 30 });
  return null;
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
