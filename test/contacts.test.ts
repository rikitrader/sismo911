import { describe, it, expect } from 'vitest';
import {
  parseVCard, parseCSV, deriveDedupeKey, peopleConnectionsToContacts,
  upsertContact, upsertFromPayee, toPublic,
} from '../src/lib/contacts';
import { makeDb } from './helpers/d1';

describe('parseVCard', () => {
  it('parses FN/N/ORG/EMAIL/TEL across multiple cards', () => {
    const vcf = [
      'BEGIN:VCARD', 'VERSION:3.0', 'FN:Ana Pérez', 'N:Pérez;Ana;;;',
      'ORG:Cruz Roja', 'EMAIL;TYPE=WORK:ana@example.com', 'TEL;TYPE=CELL:+58 412 1234567', 'END:VCARD',
      'BEGIN:VCARD', 'VERSION:3.0', 'FN:Luis', 'EMAIL:luis@x.com', 'END:VCARD',
    ].join('\r\n');
    const out = parseVCard(vcf);
    expect(out).toHaveLength(2);
    expect(out[0].display_name).toBe('Ana Pérez');
    expect(out[0].org).toBe('Cruz Roja');
    expect(out[0].emails?.[0].value).toBe('ana@example.com');
    expect(out[0].phones?.[0].value).toBe('+58 412 1234567');
    expect(out[1].emails?.[0].value).toBe('luis@x.com');
  });
});

describe('parseCSV', () => {
  it('maps common headers and handles quoted fields', () => {
    const csv = 'Name,Email,Phone,Organization\n"Pérez, Ana",ana@example.com,+58111,Cruz Roja\nLuis,luis@x.com,,\n';
    const out = parseCSV(csv);
    expect(out).toHaveLength(2);
    expect(out[0].display_name).toBe('Pérez, Ana');
    expect(out[0].emails?.[0].value).toBe('ana@example.com');
    expect(out[0].org).toBe('Cruz Roja');
    expect(out[1].display_name).toBe('Luis');
  });
});

describe('deriveDedupeKey', () => {
  it('prefers email, then phone, then wallet, then name (case-insensitive)', () => {
    expect(deriveDedupeKey({ emails: [{ value: 'A@B.com' }], phones: [{ value: '123' }] })).toBe('e:a@b.com');
    expect(deriveDedupeKey({ phones: [{ value: '+58 (412) 11-22' }] })).toBe('p:+584121122');
    expect(deriveDedupeKey({ wallet_address: '0xABC' })).toBe('w:0xabc');
    expect(deriveDedupeKey({ display_name: 'Ana' })).toBe('n:ana');
  });
});

describe('peopleConnectionsToContacts', () => {
  it('maps Google People connections to contact inputs', () => {
    const out = peopleConnectionsToContacts([
      { resourceName: 'people/c1', names: [{ displayName: 'Ana', givenName: 'Ana' }], emailAddresses: [{ value: 'ana@x.com', type: 'home' }] },
      { resourceName: 'people/c2' }, // no usable fields → filtered out
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].display_name).toBe('Ana');
    expect(out[0].external_id).toBe('people/c1');
  });
});

describe('upsertContact (idempotent by dedupe key)', () => {
  const db = () => makeDb(['migrations/0082_contacts.sql']);

  it('creates then UPDATEs the same card on a second upsert with the same email', async () => {
    const d = db();
    const env = { DB: d } as any;
    const a = await upsertContact(env, 'u1', { display_name: 'Ana', emails: [{ value: 'ana@x.com' }] }, 'manual', 1);
    expect(a.created).toBe(true);
    const b = await upsertContact(env, 'u1', { display_name: 'Ana P', emails: [{ value: 'ANA@x.com' }], org: 'Cruz Roja' }, 'vcard', 2);
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
    const rows = d.raw.prepare(`SELECT * FROM user_contacts WHERE user_id='u1'`).all() as any[];
    expect(rows).toHaveLength(1);
    expect(toPublic(rows[0]).display_name).toBe('Ana P');
    expect(toPublic(rows[0]).org).toBe('Cruz Roja');
  });

  it('different users do not collide on the same key', async () => {
    const d = db();
    const env = { DB: d } as any;
    await upsertContact(env, 'u1', { emails: [{ value: 'x@y.com' }] }, 'manual', 1);
    await upsertContact(env, 'u2', { emails: [{ value: 'x@y.com' }] }, 'manual', 1);
    const n = (d.raw.prepare(`SELECT COUNT(*) AS n FROM user_contacts`).get() as any).n;
    expect(n).toBe(2);
  });

  it('upsertFromPayee creates a wallet-keyed contact and re-uses it on copy', async () => {
    const d = db();
    const env = { DB: d } as any;
    const a = await upsertFromPayee(env, 'u1', { wallet_address: '0xWALLET', display_name: 'Refugio La Guaira' }, 1);
    expect(a?.created).toBe(true);
    const b = await upsertFromPayee(env, 'u1', { wallet_address: '0xwallet' }, 2); // same wallet, different case
    expect(b?.created).toBe(false);
    const n = (d.raw.prepare(`SELECT COUNT(*) AS n FROM user_contacts WHERE user_id='u1'`).get() as any).n;
    expect(n).toBe(1);
  });
});
