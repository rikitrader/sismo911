// Ingestion gatekeeper — a single defensive validation layer for everything that
// enters the system from an untrusted source (uploaded files, externally-sourced
// URLs, rich text, and DB records). Consolidates the checks already enforced
// ad-hoc across the codebase (readUpload/validUpload, isImageBytes, clean.ts,
// sanitizeHtml, isSafePublicUrl) into one reusable, unit-tested module.
//
// Defensive only: it REJECTS unsafe input and STRIPS dangerous content. It never
// executes, fetches, or stores raw secrets/payloads.
import { z } from 'zod';
import { sanitizeHtml, isSafePublicUrl } from '../src/lib/sanitize';
import { isImageBytes } from '../src/lib/security';

export const MAX_UPLOAD_BYTES = 8_000_000; // 8 MB
export const SAFE_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;

// Magic-byte sniff for executables/loaders we must NEVER store, regardless of the
// claimed Content-Type (defeats double-extension / spoofed-MIME uploads).
export function looksExecutable(b: Uint8Array): boolean {
  if (!b || b.length < 4) return false;
  const [a, c, d, e] = [b[0], b[1], b[2], b[3]];
  if (a === 0x4d && c === 0x5a) return true;                       // MZ — PE/.exe/.dll
  if (a === 0x7f && c === 0x45 && d === 0x4c && e === 0x46) return true; // ELF
  if (a === 0xfe && c === 0xed && d === 0xfa) return true;         // Mach-O
  if (a === 0xcf && c === 0xfa && d === 0xed && e === 0xfe) return true; // Mach-O 64 LE
  if (a === 0xca && c === 0xfe && d === 0xba && e === 0xbe) return true; // Java class / Mach-O fat
  if (a === 0x23 && c === 0x21) return true;                       // #! shebang script
  return false;
}

export type Verdict = { ok: true } | { ok: false; reason: string };

// Validate an uploaded file by size, allowlisted MIME, magic-byte content match,
// and executable-block. The claimed contentType must match the bytes.
export function gateUpload(
  bytes: Uint8Array | null | undefined,
  contentType: string,
  opts?: { maxBytes?: number; types?: readonly string[] },
): Verdict {
  const max = opts?.maxBytes ?? MAX_UPLOAD_BYTES;
  const types = opts?.types ?? SAFE_UPLOAD_TYPES;
  if (!bytes || bytes.length === 0) return { ok: false, reason: 'empty' };
  if (bytes.length > max) return { ok: false, reason: 'too_large' };
  if (!types.includes(contentType)) return { ok: false, reason: 'bad_type' };
  if (looksExecutable(bytes)) return { ok: false, reason: 'executable_blocked' };
  if (contentType === 'application/pdf') {
    if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) return { ok: false, reason: 'bad_pdf' }; // %PDF
  } else if (!isImageBytes(bytes, contentType)) {
    return { ok: false, reason: 'content_mismatch' };
  }
  return { ok: true };
}

// Reject non-public / internal URLs before any server-side fetch (SSRF guard).
export function gateUrl(url: unknown): boolean {
  return isSafePublicUrl(url);
}

// Allowlist-sanitize untrusted rich text (e.g. AI-generated / scraped HTML).
export function gateRichText(html: string): string {
  return sanitizeHtml(html);
}

// Validate a structured record against a Zod schema (use at every DB-write boundary).
export function gateRecord<T>(schema: z.ZodType<T>, input: unknown): { ok: true; data: T } | { ok: false; reason: string } {
  const r = schema.safeParse(input);
  if (r.success) return { ok: true, data: r.data };
  return { ok: false, reason: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 300) };
}

// Redact PII / secret-looking keys from an object before it is written to an
// audit log. Audit events should describe WHAT happened, never carry payloads.
const SENSITIVE_KEY = /token|secret|password|passwd|authorization|cookie|c[eé]dula|email|correo|phone|tel[eé]fono|lat|lon|address|direccion|api[_-]?key|signing|jwt/i;
export function safeAuditDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail || {})) {
    if (SENSITIVE_KEY.test(k)) { out[k] = '[redacted]'; continue; }
    out[k] = typeof v === 'string' ? v.slice(0, 200) : (typeof v === 'object' ? '[object]' : v);
  }
  return out;
}

// Example schema: a citizen-submitted record. Reuse the pattern at ingestion sites.
export const citizenRecordSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().email().max(160).optional().or(z.literal('')),
  phone: z.string().trim().max(60).optional().or(z.literal('')),
  description: z.string().max(2000).optional(),
}).refine((r) => !!(r.email || r.phone), { message: 'email or phone required' });
