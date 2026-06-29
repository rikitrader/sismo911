import type { Env } from '../types';

// Support-ticket domain helpers: ref (hash) generation, the controlled
// vocabularies for category/priority/status, and the inbound-email plumbing
// (subject ref extraction + quoted-reply stripping). Kept dependency-free so it
// is usable from both the request path and the email() handler.

export const CATEGORIES = ['cuenta', 'pagos', 'retiros', 'tecnico', 'seguridad', 'otro'] as const;
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
// open      → citizen waiting on us (new or after a citizen reply)
// pending   → operator needs more info from the citizen
// answered  → operator replied; citizen's move
// resolved  → operator marked solved (citizen can reopen by replying)
// closed    → terminal
export const STATUSES = ['open', 'pending', 'answered', 'resolved', 'closed'] as const;

export type Category = (typeof CATEGORIES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type Status = (typeof STATUSES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  cuenta: 'Cuenta',
  pagos: 'Pagos',
  retiros: 'Retiros',
  tecnico: 'Problema técnico',
  seguridad: 'Seguridad',
  otro: 'Otro',
};

export const STATUS_LABELS: Record<Status, string> = {
  open: 'Abierto',
  pending: 'Esperando tu respuesta',
  answered: 'Respondido',
  resolved: 'Resuelto',
  closed: 'Cerrado',
};

export function isCategory(v: unknown): v is Category {
  return typeof v === 'string' && (CATEGORIES as readonly string[]).includes(v);
}
export function isPriority(v: unknown): v is Priority {
  return typeof v === 'string' && (PRIORITIES as readonly string[]).includes(v);
}
export function isStatus(v: unknown): v is Status {
  return typeof v === 'string' && (STATUSES as readonly string[]).includes(v);
}

// Crockford-ish base32 alphabet minus easily-confused glyphs (no I/L/O/U/0/1).
const REF_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

// Human-readable, voice-friendly ticket hash, e.g. "SOP-7K3F9A".
export function makeRef(): string {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  let s = '';
  for (let i = 0; i < 6; i++) s += REF_ALPHABET[a[i] % REF_ALPHABET.length];
  return `SOP-${s}`;
}

// Generate a ref that is not already taken (1-in-30^6 collisions; retry a few).
export async function uniqueRef(env: Env): Promise<string> {
  for (let i = 0; i < 6; i++) {
    const ref = makeRef();
    const hit = await env.DB.prepare(`SELECT 1 FROM support_tickets WHERE ref = ?`).bind(ref).first();
    if (!hit) return ref;
  }
  // Astronomically unlikely; widen with a timestamp suffix as a last resort.
  return `${makeRef()}${Date.now().toString(36).slice(-3).toUpperCase()}`;
}

const REF_RE = /SOP-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6,}/i;

// Pull a ticket ref out of an email subject / body (inbound reply matching).
export function extractRef(...parts: (string | null | undefined)[]): string | null {
  for (const part of parts) {
    if (!part) continue;
    const m = String(part).match(REF_RE);
    if (m) return m[0].toUpperCase();
  }
  return null;
}

// Best-effort strip of quoted history from an inbound plain-text email reply so
// the appended message holds only what the citizen actually typed this time.
export function stripQuotedReply(text: string): string {
  if (!text) return '';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    // Common reply delimiters across Gmail / Outlook / Apple Mail (es + en).
    if (/^\s*>/.test(line)) break;
    if (/^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^\s*El\s.+escribió:\s*$/i.test(line)) break;            // Gmail es
    if (/^\s*On\s.+wrote:\s*$/i.test(line)) break;               // Gmail en
    if (/^\s*De:\s.+(Enviado|Para):/i.test(line)) break;         // Outlook es
    if (/^\s*From:\s.+(Sent|To):/i.test(line)) break;            // Outlook en
    if (/^\s*_{5,}\s*$/.test(line)) break;                       // Outlook divider
    out.push(line);
  }
  return out.join('\n').trim() || text.trim();
}
