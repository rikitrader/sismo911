/**
 * RFC 6238 TOTP (time-based one-time passwords) + RFC 4648 base32, implemented
 * entirely on WebCrypto (HMAC-SHA1) with NO external dependencies — so it runs
 * unchanged on Cloudflare Workers.
 *
 * Verified against the RFC 6238 Appendix-B test vectors (seed
 * "12345678901234567890" → base32 "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").
 */

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD = 30; // seconds per time-step (RFC 6238 default)
const DIGITS = 6;
const enc = new TextEncoder();

// ── base32 ──────────────────────────────────────────────────────────────────

/** RFC 4648 base32 encode (no padding). */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** RFC 4648 base32 decode. Tolerant of lowercase, spaces and '=' padding. */
export function base32Decode(secret: string): Uint8Array {
  const clean = secret.toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

// ── secret + provisioning URI ─────────────────────────────────────────────────

/** Generate a fresh base32 TOTP secret (160 bits, the RFC-recommended size). */
export function generateSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

/** Build an otpauth:// provisioning URI (Google Authenticator / Authy compatible). */
export function totpUri(secret: string, label: string, issuer = 'SISMO911'): string {
  const acct = encodeURIComponent(`${issuer}:${label}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD),
  });
  return `otpauth://totp/${acct}?${params.toString()}`;
}

// ── TOTP core ─────────────────────────────────────────────────────────────────

function counterBytes(counter: number): Uint8Array {
  const buf = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    buf[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  return buf;
}

/** Compute the 6-digit TOTP for a base32 secret at a given counter step. */
async function hotp(secret: string, counter: number): Promise<string> {
  const keyBytes = base32Decode(secret);
  const key = await crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBytes(counter) as BufferSource));
  const offset = sig[sig.length - 1] & 0x0f;
  const bin =
    ((sig[offset] & 0x7f) << 24) |
    ((sig[offset + 1] & 0xff) << 16) |
    ((sig[offset + 2] & 0xff) << 8) |
    (sig[offset + 3] & 0xff);
  return (bin % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

/** The current TOTP code for `secret` at `atMs` (defaults to now). */
export async function generateTotp(secret: string, atMs: number = Date.now()): Promise<string> {
  return hotp(secret, Math.floor(atMs / 1000 / PERIOD));
}

/**
 * Verify a TOTP `code` against `secret`, accepting codes within ±`window`
 * time-steps (clock-skew tolerance). Constant-time string compare per candidate.
 */
export async function verifyTotp(secret: string, code: string, window = 1, atMs: number = Date.now()): Promise<boolean> {
  const want = String(code ?? '').replace(/\D/g, '');
  if (want.length !== DIGITS || !secret) return false;
  const step = Math.floor(atMs / 1000 / PERIOD);
  for (let w = -window; w <= window; w++) {
    const got = await hotp(secret, step + w);
    if (timingSafeEq(got, want)) return true;
  }
  return false;
}

/**
 * Like verifyTotp but returns the matched TOTP counter STEP (audit L1 one-time
 * replay prevention — the caller persists it and rejects any step ≤ the last
 * consumed), or -1 if the code doesn't match within the window.
 */
export async function verifyTotpStep(secret: string, code: string, window = 1, atMs: number = Date.now()): Promise<number> {
  const want = String(code ?? '').replace(/\D/g, '');
  if (want.length !== DIGITS || !secret) return -1;
  const step = Math.floor(atMs / 1000 / PERIOD);
  for (let w = -window; w <= window; w++) {
    const got = await hotp(secret, step + w);
    if (timingSafeEq(got, want)) return step + w;
  }
  return -1;
}

// ── backup recovery codes ─────────────────────────────────────────────────────

/** sha256 hex of a string (for storing backup-code hashes). */
export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Collapse a backup code to its canonical form (uppercase, dashes/spaces removed). */
function normalizeBackupCode(code: string): string {
  return String(code ?? '').toUpperCase().replace(/[^A-Z2-7]/g, '');
}

/** sha256 hex of the canonicalized backup code — use for BOTH storage and matching. */
export async function hashBackupCode(code: string): Promise<string> {
  return sha256Hex(normalizeBackupCode(code));
}

/** Generate `n` human-typable backup codes, e.g. "K7F2-9QX4" (base32, no 0/1/O/I confusion). */
export function generateBackupCodes(n = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    const raw = base32Encode(crypto.getRandomValues(new Uint8Array(5))).slice(0, 8);
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}`);
  }
  return codes;
}

/**
 * Find a plaintext `code` among stored sha256 hashes. Returns the matching index
 * (so the caller can consume/remove it — backup codes are one-time use) or -1.
 * Input is normalized (case + dashes) so users can type it loosely.
 */
export async function matchBackupCode(code: string, storedHashes: string[]): Promise<number> {
  const norm = normalizeBackupCode(code);
  if (!norm || !Array.isArray(storedHashes) || storedHashes.length === 0) return -1;
  const h = await sha256Hex(norm);
  return storedHashes.findIndex((stored) => timingSafeEq(stored, h));
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
