// src/security/metadata-cleaner.ts
//
// Normalizes + sanitizes the loose "metadata" bag that ingestion payloads carry
// (the rav_reports.meta JSON column, citizen-report extras, etc.). Only TRUSTED
// keys survive; values are type-normalized; tracking garbage and empty junk are
// dropped. The output is safe to JSON.stringify straight into a D1 text column.

import { normalizeString } from './validators';
import { validLatLon, blurCoord } from '../lib/security';

// URL query params that are pure tracking noise — stripped from any URL we keep.
const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid', 'mc_eid', 'mc_cid', 'igshid',
  'ref', 'ref_src', 'ref_url', 's', 'spm', 'scm', 'yclid', '_ga', 'vero_id',
];

/** Validate + canonicalize a URL: https/http only, no credentials, tracking
 *  params stripped, length-capped. Returns null if not a safe absolute URL. */
export function cleanUrl(input: unknown, maxLen = 2048): string | null {
  const s = normalizeString(input);
  if (!s || s.length > maxLen) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null; // no embedded creds
  for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
  return u.toString();
}

/** Validate a timestamp. Accepts epoch ms (number/string) or ISO-8601; returns
 *  epoch ms, or null if out of a sane range (2000-01-01 .. now + 1 day). */
export function cleanTimestamp(input: unknown): number | null {
  if (input == null || input === '') return null;
  let ms: number;
  if (typeof input === 'number') ms = input < 1e12 ? input * 1000 : input; // sec→ms heuristic
  else {
    const s = String(input).trim();
    ms = /^\d+$/.test(s) ? (s.length <= 10 ? Number(s) * 1000 : Number(s)) : Date.parse(s);
  }
  if (!Number.isFinite(ms)) return null;
  const MIN = Date.UTC(2000, 0, 1);
  const MAX = Date.now() + 24 * 60 * 60 * 1000;
  return ms >= MIN && ms <= MAX ? Math.round(ms) : null;
}

/** Normalize a loose boolean ("true"/"1"/"yes"/"si" → true). */
export function cleanBool(input: unknown): boolean | null {
  if (typeof input === 'boolean') return input;
  if (input == null) return null;
  const s = String(input).trim().toLowerCase();
  if (['true', '1', 'yes', 'si', 'sí', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  return null;
}

/** Normalize a number; null if non-finite or outside optional bounds. */
export function cleanNumber(input: unknown, min?: number, max?: number): number | null {
  const n = typeof input === 'number' ? input : Number(String(input).trim());
  if (!Number.isFinite(n)) return null;
  if (min != null && n < min) return null;
  if (max != null && n > max) return null;
  return n;
}

/** Validate a {lat,lon}; returns blurred (privacy-rounded) coords or null. */
export function cleanGeo(
  lat: unknown,
  lon: unknown,
  decimals = 2,
): { lat: number; lon: number } | null {
  const la = cleanNumber(lat);
  const lo = cleanNumber(lon);
  if (la == null || lo == null || !validLatLon(la, lo)) return null;
  const bl = blurCoord(la, decimals);
  const bo = blurCoord(lo, decimals);
  if (bl == null || bo == null) return null;
  return { lat: bl, lon: bo };
}

export interface MetaFieldSpec {
  type: 'string' | 'url' | 'timestamp' | 'bool' | 'number' | 'geo';
  max?: number; // string length / number max
  min?: number; // number min
}

/** Clean a metadata bag against a trusted-key spec. Unknown keys are dropped,
 *  values normalized per spec, and empty/null results pruned. The 'geo' type
 *  consumes the companion `${key}_lon` (or `lon`) field. */
export function cleanMetadata(
  raw: Record<string, unknown> | null | undefined,
  spec: Record<string, MetaFieldSpec>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, fs] of Object.entries(spec)) {
    const v = raw[key];
    let cleaned: unknown = null;
    switch (fs.type) {
      case 'string': {
        const s = normalizeString(v).slice(0, fs.max ?? 1000);
        cleaned = s || null;
        break;
      }
      case 'url':
        cleaned = cleanUrl(v, fs.max);
        break;
      case 'timestamp':
        cleaned = cleanTimestamp(v);
        break;
      case 'bool':
        cleaned = cleanBool(v);
        break;
      case 'number':
        cleaned = cleanNumber(v, fs.min, fs.max);
        break;
      case 'geo':
        cleaned = cleanGeo(v, raw[`${key}_lon`] ?? raw.lon ?? raw.lng);
        break;
    }
    if (cleaned !== null && cleaned !== undefined && cleaned !== '') out[key] = cleaned;
  }
  return out;
}

/** Recursively drop null/undefined/'' leaves from a plain object (after cleaning). */
export function pruneEmpty<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '') continue;
    out[k] = v;
  }
  return out as Partial<T>;
}
