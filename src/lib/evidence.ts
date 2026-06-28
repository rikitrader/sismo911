import type { Context } from 'hono';
import type { Env } from '../types';
import { uid } from './db';
import { getUserFromRequest } from './auth';
import { requestIp } from './security';

// Evidence statuses (case_attachments.status) and the legal-grade vocabulary.
export const EVIDENCE_STATUSES = ['draft', 'reviewed', 'verified', 'disputed', 'archived'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export const ANNOTATION_SHAPES = [
  'freehand', 'line', 'arrow', 'rect', 'ellipse', 'text', 'highlight', 'redact', 'sticker',
] as const;

/** Hex SHA-256 of arbitrary bytes — the immutable original's integrity hash. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Best-effort pixel dimensions from raw image bytes, header-only (no decode), so
 * it runs cheaply inside a Worker. Supports JPEG, PNG, GIF, WebP (VP8/VP8L/VP8X).
 * Returns null when the format is unknown — callers store NULL width/height.
 */
export function imageDimensions(b: Uint8Array): { width: number; height: number } | null {
  try {
    // PNG: width/height are big-endian uint32 at byte 16/20 in the IHDR chunk.
    if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      const dv = new DataView(b.buffer, b.byteOffset);
      return { width: dv.getUint32(16), height: dv.getUint32(20) };
    }
    // GIF: little-endian uint16 width/height at byte 6/8.
    if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
      const dv = new DataView(b.buffer, b.byteOffset);
      return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
    }
    // WebP: 'RIFF'....'WEBP'
    if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
      const fmt = String.fromCharCode(b[12], b[13], b[14], b[15]);
      const dv = new DataView(b.buffer, b.byteOffset);
      if (fmt === 'VP8 ') return { width: (dv.getUint16(26, true) & 0x3fff), height: (dv.getUint16(28, true) & 0x3fff) };
      if (fmt === 'VP8L') {
        const bits = dv.getUint32(21, true);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (fmt === 'VP8X') {
        const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
        const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
        return { width: w, height: h };
      }
    }
    // JPEG: scan SOFn markers for the frame dimensions.
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1];
        // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 carry dimensions.
        if (((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
             (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf))) {
          const height = (b[i + 5] << 8) | b[i + 6];
          const width = (b[i + 7] << 8) | b[i + 8];
          return { width, height };
        }
        const len = (b[i + 2] << 8) | b[i + 3];
        if (len < 2) break;
        i += 2 + len;
      }
    }
  } catch { /* fall through */ }
  return null;
}

/**
 * Append a chain-of-custody event. Append-only — never updated or deleted. Failures
 * never break the request (custody is observability, not a transactional gate).
 */
export async function logCustody(
  c: Context<{ Bindings: Env }>,
  attachmentId: string,
  personId: string,
  event: string,
  detail?: unknown,
): Promise<void> {
  try {
    const actor = await getUserFromRequest(c.env, c).catch(() => null);
    await c.env.DB.prepare(
      `INSERT INTO evidence_chain_of_custody (id, attachment_id, person_id, event, detail, actor, actor_role, ip, created_ms)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(
      uid('coc'), attachmentId, personId, event,
      detail != null ? JSON.stringify(detail).slice(0, 1500) : null,
      actor?.email ?? actor?.id ?? null, actor?.role ?? null, requestIp(c), Date.now(),
    ).run();
  } catch { /* non-fatal */ }
}

/**
 * Mint a share token. Returns the SECRET (shown to the operator/recipient once,
 * embedded in the URL) and its sha-256 hash (the only thing persisted, so a DB
 * leak cannot reconstruct live links). Lookup is by hash.
 */
export async function mintShareToken(): Promise<{ secret: string; hash: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(24));
  const secret = [...raw].map((b) => b.toString(16).padStart(2, '0')).join('');
  const hash = await sha256Hex(new TextEncoder().encode(secret));
  return { secret, hash };
}

export const tokenHash = (secret: string) => sha256Hex(new TextEncoder().encode(String(secret)));
