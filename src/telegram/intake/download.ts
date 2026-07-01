// SISMO911 — Telegram intake: pick + download the submitted media.
// ---------------------------------------------------------------------------
// Telegram sends photos as message.photo[] (multiple sizes; last = largest) and
// files as message.document (with mime_type). We only ingest photos and
// PDF/image documents; anything else is ignored. Download is a two-step dance:
// getFile → file_path, then GET /file/bot<token>/<path>.

import type { TelegramMessage } from '../types';
import type { IntakeMedia } from './types';

const TG_API = 'https://api.telegram.org';
const MAX_BYTES = 20 * 1024 * 1024; // Telegram Bot API download cap is 20 MB.

export interface PickedFile {
  fileId: string;
  mime: string;
  fileName: string;
}

/** Pick the intake-relevant media from a message: largest photo, or a PDF/image document. */
export function pickMedia(msg: TelegramMessage): PickedFile | null {
  const m = msg as unknown as {
    photo?: Array<{ file_id?: string }>;
    document?: { file_id?: string; mime_type?: string; file_name?: string };
  };
  if (Array.isArray(m.photo) && m.photo.length) {
    const largest = m.photo[m.photo.length - 1];
    if (largest?.file_id) return { fileId: String(largest.file_id), mime: 'image/jpeg', fileName: 'photo.jpg' };
  }
  const doc = m.document;
  if (doc?.file_id) {
    const mime = String(doc.mime_type || '').toLowerCase();
    if (mime === 'application/pdf' || mime.startsWith('image/')) {
      return { fileId: String(doc.file_id), mime, fileName: String(doc.file_name || 'documento').slice(0, 120) };
    }
  }
  return null;
}

/** Resolve a Telegram file_id to its bytes. Returns null on any failure or an
 *  empty / over-cap file (guardrails at the trust boundary). */
export async function downloadFile(token: string, picked: PickedFile): Promise<IntakeMedia | null> {
  const meta = await fetch(`${TG_API}/bot${token}/getFile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file_id: picked.fileId }),
  })
    .then((r) => r.json() as Promise<{ ok?: boolean; result?: { file_path?: string } }>)
    .catch(() => null);
  const filePath = meta?.result?.file_path;
  if (!filePath) return null;

  const res = await fetch(`${TG_API}/file/bot${token}/${filePath}`).catch(() => null);
  if (!res || !res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) return null;

  return { fileId: picked.fileId, mime: picked.mime, fileName: picked.fileName, bytes: buf };
}
