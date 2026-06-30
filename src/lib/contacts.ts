import type { Env } from '../types';
import { uid } from './db';

// Personal contacts ("Contactos") domain helpers — parsing (vCard/CSV), a stable
// dedupe key, and an idempotent upsert so imports + payee auto-create UPDATE an
// existing card instead of duplicating it.

export interface ContactInput {
  display_name?: string;
  first_name?: string;
  last_name?: string;
  org?: string;
  emails?: { label?: string; value: string }[];
  phones?: { label?: string; value: string }[];
  wallet_address?: string;
  payee_user_id?: string;
  note?: string;
  avatar_url?: string;
  favorite?: boolean;
  external_id?: string;
}

const clip = (v: unknown, n: number) => (v == null ? '' : String(v)).trim().slice(0, n);
export const normEmail = (s: string) => clip(s, 200).toLowerCase();
export const normPhone = (s: string) => clip(s, 40).replace(/[^\d+]/g, '');

/** Best display name from the parts available. */
export function deriveName(i: ContactInput): string {
  if (i.display_name) return clip(i.display_name, 160);
  const fn = [i.first_name, i.last_name].filter(Boolean).join(' ').trim();
  if (fn) return clip(fn, 160);
  if (i.emails && i.emails[0]?.value) return clip(i.emails[0].value, 160);
  if (i.org) return clip(i.org, 160);
  if (i.wallet_address) return clip(i.wallet_address, 160);
  return 'Contacto';
}

/** Stable dedupe key: first email, else phone, else wallet, else name. */
export function deriveDedupeKey(i: ContactInput): string {
  const email = i.emails?.find((e) => e.value)?.value;
  if (email) return 'e:' + normEmail(email);
  const phone = i.phones?.find((p) => p.value)?.value;
  if (phone && normPhone(phone)) return 'p:' + normPhone(phone);
  if (i.wallet_address) return 'w:' + clip(i.wallet_address, 80).toLowerCase();
  return 'n:' + deriveName(i).toLowerCase();
}

/** Row → safe public JSON (parse the *_json blobs). */
export function toPublic(r: any) {
  const arr = (s: any) => { try { return s ? JSON.parse(s) : []; } catch { return []; } };
  return {
    id: r.id, display_name: r.display_name, first_name: r.first_name ?? null, last_name: r.last_name ?? null,
    org: r.org ?? null, emails: arr(r.emails_json), phones: arr(r.phones_json),
    wallet_address: r.wallet_address ?? null, payee_user_id: r.payee_user_id ?? null,
    note: r.note ?? null, avatar_url: r.avatar_url ?? null, favorite: Boolean(r.favorite),
    source: r.source || 'manual', created_ms: r.created_ms, updated_ms: r.updated_ms,
  };
}

/** Idempotent upsert keyed by (user_id, dedupe_key). Merges into an existing card. */
export async function upsertContact(env: Env, userId: string, input: ContactInput, source: string, now: number): Promise<{ id: string; created: boolean }> {
  const display = deriveName(input);
  const dedupe = deriveDedupeKey(input);
  const emails = JSON.stringify((input.emails || []).filter((e) => e && e.value).map((e) => ({ label: clip(e.label, 24) || 'email', value: clip(e.value, 200) })));
  const phones = JSON.stringify((input.phones || []).filter((p) => p && p.value).map((p) => ({ label: clip(p.label, 24) || 'tel', value: clip(p.value, 40) })));

  const existing: any = await env.DB.prepare(`SELECT id FROM user_contacts WHERE user_id=? AND dedupe_key=?`).bind(userId, dedupe).first();
  if (existing) {
    await env.DB.prepare(
      `UPDATE user_contacts SET display_name=?, first_name=COALESCE(?,first_name), last_name=COALESCE(?,last_name),
         org=COALESCE(?,org), emails_json=CASE WHEN ?='[]' THEN emails_json ELSE ? END,
         phones_json=CASE WHEN ?='[]' THEN phones_json ELSE ? END,
         wallet_address=COALESCE(?,wallet_address), payee_user_id=COALESCE(?,payee_user_id),
         note=COALESCE(?,note), avatar_url=COALESCE(?,avatar_url), updated_ms=?
       WHERE id=?`
    ).bind(display, input.first_name || null, input.last_name || null, clip(input.org, 160) || null,
      emails, emails, phones, phones, clip(input.wallet_address, 80) || null, clip(input.payee_user_id, 64) || null,
      clip(input.note, 1000) || null, clip(input.avatar_url, 500) || null, now, existing.id).run();
    return { id: existing.id, created: false };
  }
  const id = uid('con');
  await env.DB.prepare(
    `INSERT INTO user_contacts (id,user_id,display_name,first_name,last_name,org,emails_json,phones_json,
       wallet_address,payee_user_id,note,avatar_url,favorite,source,external_id,dedupe_key,created_ms,updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, userId, display, input.first_name || null, input.last_name || null, clip(input.org, 160) || null,
    emails, phones, clip(input.wallet_address, 80) || null, clip(input.payee_user_id, 64) || null,
    clip(input.note, 1000) || null, clip(input.avatar_url, 500) || null, input.favorite ? 1 : 0,
    source, clip(input.external_id, 200) || null, dedupe, now, now).run();
  return { id, created: true };
}

/** Auto-create/update a contact from a new "send" wallet/payee. */
export async function upsertFromPayee(env: Env, userId: string, p: { wallet_address?: string; display_name?: string; payee_user_id?: string }, now: number) {
  if (!p.wallet_address && !p.payee_user_id) return null;
  return upsertContact(env, userId, {
    display_name: p.display_name, wallet_address: p.wallet_address, payee_user_id: p.payee_user_id,
  }, 'payee', now);
}

// ── Importers ─────────────────────────────────────────────────────────────────

/** Parse a vCard (2.1/3.0/4.0) blob into contact inputs. Tolerant: skips junk. */
export function parseVCard(text: string): ContactInput[] {
  const out: ContactInput[] = [];
  const cards = String(text || '').split(/BEGIN:VCARD/i).slice(1);
  for (const block of cards) {
    const body = block.split(/END:VCARD/i)[0];
    // Unfold folded lines (RFC 6350: a line starting with space/tab continues prior).
    const lines = body.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
    const c: ContactInput = { emails: [], phones: [] };
    for (const line of lines) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const rawKey = line.slice(0, idx);
      const val = line.slice(idx + 1).trim();
      if (!val) continue;
      const key = rawKey.split(';')[0].toUpperCase().replace(/^ITEM\d+\./, '');
      const params = rawKey.toUpperCase();
      const typeMatch = /TYPE=([A-Z,]+)/.exec(params);
      const label = typeMatch ? typeMatch[1].split(',')[0].toLowerCase() : '';
      if (key === 'FN') c.display_name = val;
      else if (key === 'N') { const parts = val.split(';'); c.last_name = parts[0] || undefined; c.first_name = parts[1] || undefined; }
      else if (key === 'ORG') c.org = val.replace(/;/g, ' ').trim();
      else if (key === 'EMAIL') c.emails!.push({ label: label || 'email', value: val });
      else if (key === 'TEL') c.phones!.push({ label: label || 'tel', value: val });
      else if (key === 'NOTE') c.note = val;
    }
    if (c.display_name || c.first_name || c.last_name || c.emails!.length || c.phones!.length) out.push(c);
  }
  return out;
}

/** Parse a simple CSV (header row) into contact inputs. Recognizes common headers. */
export function parseCSV(text: string): ContactInput[] {
  const rows = parseCsvRows(String(text || ''));
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const find = (...names: string[]) => header.findIndex((h) => names.some((n) => h === n || h.includes(n)));
  const iName = find('display name', 'full name', 'name');
  const iFirst = find('first name', 'first', 'given');
  const iLast = find('last name', 'last', 'family', 'surname');
  const iOrg = find('organization', 'company', 'org');
  const iEmail = find('e-mail address', 'email', 'e-mail', 'correo');
  const iPhone = find('phone', 'tel', 'mobile', 'teléfono', 'telefono');
  const iWallet = find('wallet', 'address', 'usdc');
  const iNote = find('notes', 'note', 'nota');
  const out: ContactInput[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]; if (!row.length || row.every((c) => !c.trim())) continue;
    const at = (i: number) => (i >= 0 && i < row.length ? row[i].trim() : '');
    const c: ContactInput = {
      display_name: at(iName) || undefined, first_name: at(iFirst) || undefined, last_name: at(iLast) || undefined,
      org: at(iOrg) || undefined, note: at(iNote) || undefined, wallet_address: at(iWallet) || undefined,
      emails: at(iEmail) ? [{ label: 'email', value: at(iEmail) }] : [],
      phones: at(iPhone) ? [{ label: 'tel', value: at(iPhone) }] : [],
    };
    if (c.display_name || c.first_name || c.last_name || c.emails!.length || c.phones!.length || c.wallet_address) out.push(c);
  }
  return out;
}

/** Minimal RFC-4180-ish CSV row parser (quotes, commas, embedded newlines). */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let field = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = ''; rows.push(row); row = [];
    } else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Google People API "connections" → contact inputs. */
export function peopleConnectionsToContacts(connections: any[]): ContactInput[] {
  return (connections || []).map((p) => {
    const name = p.names?.[0] || {};
    return {
      display_name: name.displayName || undefined,
      first_name: name.givenName || undefined,
      last_name: name.familyName || undefined,
      org: p.organizations?.[0]?.name || undefined,
      emails: (p.emailAddresses || []).filter((e: any) => e.value).map((e: any) => ({ label: (e.type || 'email').toLowerCase(), value: e.value })),
      phones: (p.phoneNumbers || []).filter((t: any) => t.value).map((t: any) => ({ label: (t.type || 'tel').toLowerCase(), value: t.value })),
      avatar_url: p.photos?.find((ph: any) => !ph.default)?.url || undefined,
      external_id: p.resourceName || undefined,
    } as ContactInput;
  }).filter((c) => c.display_name || c.first_name || (c.emails && c.emails.length) || (c.phones && c.phones.length));
}
