// src/security/file-scan.ts
//
// Upload inspection for the gate. Verifies that a file IS the image it claims to
// be (magic bytes ↔ declared MIME ↔ extension all agree), is within size, is not
// an executable / SVG / polyglot, then hashes it (SHA-256) for content dedupe and
// derives a safe storage key. Nothing is written to R2 until every check passes.
//
// We build on isImageBytes() from lib/security.ts (already used by the photo
// routes) and add explicit magic-byte sniffing + the negative checks.

import { isImageBytes } from '../lib/security';

export type DetectedType = 'jpeg' | 'png' | 'webp' | 'gif' | 'svg' | 'unknown';

export interface FileScanResult {
  ok: boolean;
  reason?: FileRejectReason;
  detail?: string;
  detectedType: DetectedType;
  size: number;
  sha256?: string; // hex, present when bytes are readable
  safeName?: string; // sanitized, extension-corrected filename
  safeKey?: string; // suggested R2 object key (sha-based, collision-free)
}

export type FileRejectReason =
  | 'empty_file'
  | 'too_large'
  | 'type_not_allowed'
  | 'mime_mismatch'
  | 'bad_magic_bytes'
  | 'svg_disabled'
  | 'executable_content'
  | 'polyglot';

const DEFAULT_MAX = 8 * 1024 * 1024; // 8 MiB
const ALLOWED: ReadonlyArray<DetectedType> = ['jpeg', 'png', 'webp'];

const MIME_BY_TYPE: Record<DetectedType, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  unknown: 'application/octet-stream',
};
const EXT_BY_TYPE: Record<DetectedType, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  gif: 'gif',
  svg: 'svg',
  unknown: 'bin',
};

/** Sniff the real type from leading bytes — never trust the declared MIME. */
export function sniffType(b: Uint8Array): DetectedType {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  // SVG / XML — text-based; look for an <svg or <?xml prefix (skip BOM/space).
  const head = new TextDecoder().decode(b.slice(0, 256)).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  return 'unknown';
}

// Executable / script magic bytes that must never be accepted as an "image".
function isExecutable(b: Uint8Array): boolean {
  if (b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a) return true; // MZ — PE/EXE/DLL
  if (b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return true; // ELF
  if (b.length >= 4 && b[0] === 0xca && b[1] === 0xfe && b[2] === 0xba && b[3] === 0xbe) return true; // Mach-O fat
  if (b.length >= 4 && b[0] === 0xcf && b[1] === 0xfa && b[2] === 0xed && b[3] === 0xfe) return true; // Mach-O 64
  if (b.length >= 2 && b[0] === 0x23 && b[1] === 0x21) return true; // #! shebang
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return true; // ZIP/JAR/APK/OOXML
  return false;
}

// Polyglot detection: a real raster image must not contain embedded HTML/script.
// We scan the WHOLE buffer as latin1 (cheap, no allocation blowup) for the
// telltale `<script`, `<?php`, `<svg`, or `<!doctype html` mid-file — the classic
// "valid JPEG that is also valid HTML" attack.
function isPolyglot(b: Uint8Array, detected: DetectedType): boolean {
  if (detected === 'svg' || detected === 'unknown') return false; // handled elsewhere
  const txt = new TextDecoder('latin1').decode(b).toLowerCase();
  return /<script[\s>]|<\?php|<!doctype html|<svg[\s>]|javascript:/.test(txt);
}

export async function sha256Hex(b: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', b);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Derive a safe, traversal-proof filename. We DISCARD the user's filename for
 *  storage (only used for the display extension) — the canonical key is hash-based. */
export function safeFilename(original: string | null | undefined, detected: DetectedType): string {
  const ext = EXT_BY_TYPE[detected] ?? 'bin';
  const base = (original ?? 'upload')
    .replace(/^.*[\\/]/, '') // strip any path
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/\.[^.]*$/, '') // drop original extension
    .slice(0, 64) || 'upload';
  return `${base}.${ext}`;
}

export interface ScanOpts {
  maxSize?: number;
  allowSvg?: boolean;
  declaredMime?: string | null;
  filename?: string | null;
  keyPrefix?: string; // R2 key namespace, e.g. 'persona/'
}

/** Full pipeline for one uploaded file. Pass the raw bytes (already read into a
 *  Uint8Array — do this AFTER the size pre-check on Content-Length). */
export async function scanFile(bytes: Uint8Array, opts: ScanOpts = {}): Promise<FileScanResult> {
  const maxSize = opts.maxSize ?? DEFAULT_MAX;
  const size = bytes.length;
  const detectedType = sniffType(bytes);
  const base: FileScanResult = { ok: false, detectedType, size };

  if (size === 0) return { ...base, reason: 'empty_file' };
  if (size > maxSize) return { ...base, reason: 'too_large', detail: `${size} > ${maxSize}` };
  if (isExecutable(bytes)) return { ...base, reason: 'executable_content' };

  if (detectedType === 'svg') {
    if (!opts.allowSvg) return { ...base, reason: 'svg_disabled' };
    // SVG explicitly enabled — still reject obvious script content.
    const txt = new TextDecoder().decode(bytes).toLowerCase();
    if (/<script|onload=|onerror=|javascript:|<foreignobject/.test(txt))
      return { ...base, reason: 'executable_content', detail: 'active svg content' };
  } else {
    if (!ALLOWED.includes(detectedType))
      return { ...base, reason: 'type_not_allowed', detail: detectedType };
    // Confirm the declared MIME (if any) agrees with the real bytes.
    const expectedMime = MIME_BY_TYPE[detectedType];
    if (opts.declaredMime && opts.declaredMime.split(';')[0].trim().toLowerCase() !== expectedMime)
      return { ...base, reason: 'mime_mismatch', detail: `${opts.declaredMime} vs ${expectedMime}` };
    // Double-confirm magic bytes via the project's own checker.
    if (!isImageBytes(bytes, expectedMime)) return { ...base, reason: 'bad_magic_bytes' };
    if (isPolyglot(bytes, detectedType)) return { ...base, reason: 'polyglot' };
  }

  const sha256 = await sha256Hex(bytes);
  const safeName = safeFilename(opts.filename, detectedType);
  const safeKey = `${opts.keyPrefix ?? ''}${sha256}.${EXT_BY_TYPE[detectedType]}`;
  return { ok: true, detectedType, size, sha256, safeName, safeKey };
}

// NOTE on EXIF: the Workers runtime has no native image re-encoder, so we cannot
// RE-COMPRESS to drop metadata. Instead, callers that store user images publicly
// (e.g. the avatar upload) run `stripImageMetadata()` from ./image-metadata, which
// LOSSLESSLY removes the EXIF/GPS/XMP/IPTC/text segments (no re-encode) before
// storing — so geotags, device, and timestamps never leave the upload. We also
// DO NOT persist any client-supplied metadata into D1. (A full re-encode via
// Cloudflare Images remains an option if pixel-level scrubbing is ever required.)
