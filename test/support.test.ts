import { describe, it, expect } from 'vitest';
import {
  makeRef, extractRef, stripQuotedReply, isCategory, isPriority, isStatus,
  CATEGORIES, STATUSES, CATEGORY_LABELS,
} from '../src/lib/support';
import { inboundEmailEnabled, INBOUND_FLAG } from '../src/routes/support';
import {
  supportTicketOpenedEmail, supportStaffReplyEmail, supportTicketResolvedEmail,
} from '../src/lib/email';

describe('support ref (ticket hash)', () => {
  it('matches SOP-XXXXXX with only unambiguous glyphs', () => {
    for (let i = 0; i < 200; i++) {
      const ref = makeRef();
      expect(ref).toMatch(/^SOP-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
      // never contains the confusable characters 0/1/I/L/O/U
      expect(ref.slice(4)).not.toMatch(/[01ILOU]/);
    }
  });
  it('is effectively unique across a batch', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(makeRef());
    expect(seen.size).toBeGreaterThan(495); // collisions vanishingly rare
  });
});

describe('extractRef — inbound reply matching', () => {
  it('pulls the ref out of a [#…] subject', () => {
    expect(extractRef('[#SOP-7K3F9A] Mi problema — Soporte SISMO911')).toBe('SOP-7K3F9A');
  });
  it('reads it case-insensitively and uppercases', () => {
    expect(extractRef('re: sop-abcdef pago')).toBe('SOP-ABCDEF');
  });
  it('falls through multiple parts (subject → body)', () => {
    expect(extractRef(null, undefined, 'gracias, ref SOP-MNPQRS')).toBe('SOP-MNPQRS');
  });
  it('returns null when no ref present', () => {
    expect(extractRef('hola, tengo una duda', 'sin referencia')).toBeNull();
  });
});

describe('stripQuotedReply — keep only the new text', () => {
  it('drops Gmail-style quoted history (es)', () => {
    const raw = 'Sí, ya lo resolví, gracias.\n\nEl mié, 25 jun 2026 a las 10:00, Soporte SISMO911 escribió:\n> ¿Pudiste entrar?';
    expect(stripQuotedReply(raw)).toBe('Sí, ya lo resolví, gracias.');
  });
  it('drops Outlook divider', () => {
    const raw = 'Gracias por la ayuda.\n\n________________________________\nDe: Soporte Enviado: ...';
    expect(stripQuotedReply(raw)).toBe('Gracias por la ayuda.');
  });
  it('drops leading > quote lines', () => {
    const raw = 'Confirmo el pago.\n> mensaje anterior\n> más cita';
    expect(stripQuotedReply(raw)).toBe('Confirmo el pago.');
  });
  it('returns the original when there is nothing to strip', () => {
    expect(stripQuotedReply('mensaje simple sin citas')).toBe('mensaje simple sin citas');
  });
});

describe('controlled vocabularies', () => {
  it('validators accept members and reject junk', () => {
    expect(isCategory('pagos')).toBe(true);
    expect(isCategory('nope')).toBe(false);
    expect(isPriority('urgent')).toBe(true);
    expect(isPriority('mega')).toBe(false);
    expect(isStatus('resolved')).toBe(true);
    expect(isStatus('zzz')).toBe(false);
  });
  it('every category has a Spanish label', () => {
    for (const c of CATEGORIES) expect(CATEGORY_LABELS[c]).toBeTruthy();
  });
  it('status set is the documented 5-state machine', () => {
    expect([...STATUSES]).toEqual(['open', 'pending', 'answered', 'resolved', 'closed']);
  });
});

describe('support email templates — threading contract', () => {
  const ref = 'SOP-7K3F9A';
  it('opened email carries [#REF] in the subject + escapes the body', () => {
    const m = supportTicketOpenedEmail({ name: 'Ricardo', ref, subject: 'Mi pago', body: '<b>hola</b>', manageUrl: 'https://sismo911.com/cuenta#soporte', categoryLabel: 'Pagos' });
    expect(m.subject).toContain(`[#${ref}]`);
    expect(m.html).toContain(ref);
    expect(m.html).toContain('&lt;b&gt;hola&lt;/b&gt;'); // body escaped, not raw HTML
    expect(m.html).not.toContain('<b>hola</b>');
    expect(m.text).toContain(ref);
  });
  it('staff reply email keeps the SAME ref subject so replies thread', () => {
    const m = supportStaffReplyEmail({ name: 'Ricardo', ref, subject: 'Mi pago', body: 'ya quedó', agentName: 'Ana', manageUrl: 'u' });
    expect(m.subject).toContain(`[#${ref}]`);
    expect(m.html).toContain('Ana');
    expect(m.html).toContain('ya quedó');
  });
  it('resolved email references the ref + invites reopening', () => {
    const m = supportTicketResolvedEmail({ name: 'Ricardo', ref, subject: 'Mi pago', manageUrl: 'u' });
    expect(m.subject).toContain(`[#${ref}]`);
    expect(m.subject.toLowerCase()).toContain('resuelto');
    expect(m.text).toContain(ref);
  });
});

// Minimal D1 stub: only the feature_flags SELECT the toggle uses.
function dbWithFlag(row: { enabled: number } | null) {
  return {
    prepare(_sql: string) {
      return {
        bind() { return this; },
        async first() { return row; },
      };
    },
  } as any;
}

describe('inbound-email toggle — persisted + fail-closed', () => {
  it('module key is the documented flag', () => {
    expect(INBOUND_FLAG).toBe('support_inbound_email');
  });
  it('OFF when no flag row exists (fail-closed default)', async () => {
    expect(await inboundEmailEnabled({ DB: dbWithFlag(null) } as any)).toBe(false);
  });
  it('OFF when the row is explicitly disabled', async () => {
    expect(await inboundEmailEnabled({ DB: dbWithFlag({ enabled: 0 }) } as any)).toBe(false);
  });
  it('ON only when the row is enabled=1', async () => {
    expect(await inboundEmailEnabled({ DB: dbWithFlag({ enabled: 1 }) } as any)).toBe(true);
  });
  it('fail-closed if the query throws', async () => {
    const env = { DB: { prepare() { return { bind() { return this; }, async first() { throw new Error('db down'); } }; } } } as any;
    expect(await inboundEmailEnabled(env)).toBe(false);
  });
});
