import { Hono } from 'hono';
import type { Env } from '../types';
import { getUserFromRequest } from '../lib/auth';
import { audit } from '../lib/audit';
import {
  toPublic, upsertContact, parseVCard, parseCSV, peopleConnectionsToContacts,
  type ContactInput,
} from '../lib/contacts';
import { getProvider, providerCreds, randomToken, pkceChallenge, exchangeCode } from '../lib/oauth';

// Personal "Contactos" manager — a per-user address book (like Apple Contacts).
// Mounted UNDER /api/profile (self-authenticating, scoped to the caller), so it
// never collides with the operator agency directory at /api/contacts.

export const contactsPersonal = new Hono<{ Bindings: Env }>();

const clip = (v: unknown, n: number) => (v == null ? '' : String(v)).trim().slice(0, n);
const GOOGLE_CONTACTS_SCOPE = 'https://www.googleapis.com/auth/contacts.readonly';
const stateKey = (s: string) => `contacts:gstate:${s}`;

function inputFromBody(b: any): ContactInput {
  const arr = (x: any) => Array.isArray(x) ? x.filter((e) => e && e.value).map((e) => ({ label: clip(e.label, 24), value: clip(e.value, 200) })) : [];
  return {
    display_name: clip(b.display_name, 160) || undefined,
    first_name: clip(b.first_name, 80) || undefined,
    last_name: clip(b.last_name, 80) || undefined,
    org: clip(b.org, 160) || undefined,
    emails: arr(b.emails), phones: arr(b.phones),
    wallet_address: clip(b.wallet_address, 80) || undefined,
    note: clip(b.note, 1000) || undefined,
    avatar_url: clip(b.avatar_url, 500) || undefined,
    favorite: b.favorite === true,
  };
}

// GET /api/profile/contacts?q=&favorite=1 — list + search the caller's contacts.
contactsPersonal.get('/contacts', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const q = clip(c.req.query('q'), 80).toLowerCase();
  const favOnly = c.req.query('favorite') === '1';
  let sql = `SELECT * FROM user_contacts WHERE user_id = ?`;
  const binds: unknown[] = [me.id];
  if (q) {
    sql += ` AND (lower(display_name) LIKE ? OR lower(org) LIKE ? OR lower(emails_json) LIKE ? OR lower(phones_json) LIKE ? OR lower(wallet_address) LIKE ?)`;
    const like = `%${q}%`; binds.push(like, like, like, like, like);
  }
  if (favOnly) sql += ` AND favorite = 1`;
  sql += ` ORDER BY favorite DESC, display_name COLLATE NOCASE ASC LIMIT 1000`;
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all();
  return c.json({ ok: true, contacts: ((results ?? []) as any[]).map(toPublic), count: (results ?? []).length });
});

// POST /api/profile/contacts — create a contact.
contactsPersonal.post('/contacts', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b !== 'object') return c.json({ error: 'bad_body' }, 400);
  const input = inputFromBody(b);
  if (!input.display_name && !input.first_name && !input.last_name && !(input.emails && input.emails.length) && !(input.phones && input.phones.length) && !input.wallet_address) {
    return c.json({ error: 'empty_contact' }, 400);
  }
  const { id, created } = await upsertContact(c.env, me.id, input, 'manual', Date.now());
  await audit(c, 'contacts.create', { id, created });
  const row: any = await c.env.DB.prepare(`SELECT * FROM user_contacts WHERE id=?`).bind(id).first();
  return c.json({ ok: true, contact: toPublic(row), created }, created ? 201 : 200);
});

// GET /api/profile/contacts/:id
contactsPersonal.get('/contacts/:id', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const row: any = await c.env.DB.prepare(`SELECT * FROM user_contacts WHERE id=? AND user_id=?`).bind(c.req.param('id'), me.id).first();
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true, contact: toPublic(row) });
});

// PATCH /api/profile/contacts/:id — edit fields (Apple-Contacts-style).
contactsPersonal.patch('/contacts/:id', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const id = c.req.param('id');
  const owns: any = await c.env.DB.prepare(`SELECT id FROM user_contacts WHERE id=? AND user_id=?`).bind(id, me.id).first();
  if (!owns) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b !== 'object') return c.json({ error: 'bad_body' }, 400);
  const sets: string[] = []; const vals: unknown[] = [];
  const set = (col: string, v: unknown) => { sets.push(`${col}=?`); vals.push(v); };
  if (b.display_name !== undefined) { const v = clip(b.display_name, 160); if (!v) return c.json({ error: 'name_required' }, 400); set('display_name', v); }
  if (b.first_name !== undefined) set('first_name', clip(b.first_name, 80) || null);
  if (b.last_name !== undefined) set('last_name', clip(b.last_name, 80) || null);
  if (b.org !== undefined) set('org', clip(b.org, 160) || null);
  if (b.emails !== undefined) set('emails_json', JSON.stringify((Array.isArray(b.emails) ? b.emails : []).filter((e: any) => e && e.value).map((e: any) => ({ label: clip(e.label, 24) || 'email', value: clip(e.value, 200) }))));
  if (b.phones !== undefined) set('phones_json', JSON.stringify((Array.isArray(b.phones) ? b.phones : []).filter((p: any) => p && p.value).map((p: any) => ({ label: clip(p.label, 24) || 'tel', value: clip(p.value, 40) }))));
  if (b.wallet_address !== undefined) set('wallet_address', clip(b.wallet_address, 80) || null);
  if (b.note !== undefined) set('note', clip(b.note, 1000) || null);
  if (b.avatar_url !== undefined) set('avatar_url', clip(b.avatar_url, 500) || null);
  if (b.favorite !== undefined) { if (typeof b.favorite !== 'boolean') return c.json({ error: 'favorite_must_be_boolean' }, 400); set('favorite', b.favorite ? 1 : 0); }
  if (!sets.length) return c.json({ error: 'nothing_to_update' }, 400);
  set('updated_ms', Date.now()); vals.push(id);
  await c.env.DB.prepare(`UPDATE user_contacts SET ${sets.join(', ')} WHERE id=?`).bind(...vals).run();
  await audit(c, 'contacts.update', { id, fields: sets.map((s) => s.split('=')[0]) });
  const row: any = await c.env.DB.prepare(`SELECT * FROM user_contacts WHERE id=?`).bind(id).first();
  return c.json({ ok: true, contact: toPublic(row) });
});

// DELETE /api/profile/contacts/:id
contactsPersonal.delete('/contacts/:id', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const id = c.req.param('id');
  const owns: any = await c.env.DB.prepare(`SELECT id FROM user_contacts WHERE id=? AND user_id=?`).bind(id, me.id).first();
  if (!owns) return c.json({ error: 'not_found' }, 404);
  await c.env.DB.prepare(`DELETE FROM user_contacts WHERE id=?`).bind(id).run();
  await audit(c, 'contacts.delete', { id });
  return c.json({ ok: true });
});

// POST /api/profile/contacts/import — bulk import from a vCard or CSV blob.
// WhatsApp note: there is NO API to read a user's WhatsApp address book; the
// honest path is exporting a vCard/CSV and importing it here.
contactsPersonal.post('/contacts/import', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b !== 'object') return c.json({ error: 'bad_body' }, 400);
  const data = String(b.data || '');
  if (!data.trim()) return c.json({ error: 'empty_data' }, 400);
  if (data.length > 2_000_000) return c.json({ error: 'too_large' }, 413);
  const fmt = b.format === 'csv' ? 'csv' : b.format === 'vcard' ? 'vcard' : (/BEGIN:VCARD/i.test(data) ? 'vcard' : 'csv');
  const parsed = fmt === 'vcard' ? parseVCard(data) : parseCSV(data);
  if (!parsed.length) return c.json({ error: 'no_contacts_found', format: fmt }, 400);

  const now = Date.now();
  let created = 0, updated = 0;
  for (const ci of parsed.slice(0, 5000)) {
    try { const r = await upsertContact(c.env, me.id, ci, fmt, now); r.created ? created++ : updated++; } catch { /* skip a bad row */ }
  }
  await audit(c, 'contacts.import', { format: fmt, created, updated });
  return c.json({ ok: true, format: fmt, imported: created, updated, total: created + updated });
});

// ── Google People API import (gated on Google OAuth creds + the sensitive
// contacts.readonly scope + Google app verification before public use) ─────────

// GET /api/profile/contacts/import/google/start — returns the consent URL.
contactsPersonal.get('/contacts/import/google/start', async (c) => {
  const me = await getUserFromRequest(c.env, c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const p = getProvider('google');
  const creds = p && providerCreds(c.env, p);
  if (!p || !creds) return c.json({ error: 'google_not_configured', detail: 'Falta configurar OAuth de Google (OAUTH_GOOGLE_CLIENT_ID/SECRET).' }, 503);
  const state = randomToken();
  const verifier = randomToken(48);
  const challenge = await pkceChallenge(verifier);
  const redirectUri = new URL('/api/profile/contacts/import/google/callback', c.req.url).toString();
  await c.env.CACHE.put(stateKey(state), JSON.stringify({ user_id: me.id, verifier, redirectUri }), { expirationTtl: 600 });
  const u = new URL(p.authUrl);
  u.searchParams.set('client_id', creds.clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', GOOGLE_CONTACTS_SCOPE);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  return c.json({ ok: true, url: u.toString() });
});

// GET /api/profile/contacts/import/google/callback — exchange + import.
contactsPersonal.get('/contacts/import/google/callback', async (c) => {
  const code = c.req.query('code'); const state = c.req.query('state');
  const back = (q: string) => c.redirect(`/cuenta?contacts_import=${q}#contactos`, 302);
  if (!code || !state) return back('error');
  const raw = await c.env.CACHE.get(stateKey(state));
  if (!raw) return back('state');
  await c.env.CACHE.delete(stateKey(state)).catch(() => {});
  let st: any; try { st = JSON.parse(raw); } catch { return back('state'); }
  const p = getProvider('google'); const creds = p && providerCreds(c.env, p);
  if (!p || !creds) return back('config');
  try {
    const tokens = await exchangeCode(p, creds, code, st.redirectUri, st.verifier);
    if (!tokens?.access_token) return back('token');
    const url = 'https://people.googleapis.com/v1/people/me/connections?pageSize=1000&personFields=names,emailAddresses,phoneNumbers,organizations,photos';
    const r = await fetch(url, { headers: { authorization: `Bearer ${tokens.access_token}` } });
    if (!r.ok) return back('people');
    const data: any = await r.json().catch(() => ({}));
    const inputs = peopleConnectionsToContacts(data.connections || []);
    const now = Date.now(); let n = 0;
    for (const ci of inputs.slice(0, 5000)) { try { await upsertContact(c.env, st.user_id, ci, 'google', now); n++; } catch { /* skip */ } }
    return back(String(n));
  } catch {
    return back('error');
  }
});
