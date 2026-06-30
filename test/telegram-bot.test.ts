// Auth, command-parsing, and response-builder tests for the Telegram bot.
import { describe, it, expect } from 'vitest';
import { parseCommand, tokenize } from '../src/telegram/commands';
import {
  verifyWebhook,
  isRequestAuthorized,
  canViewSensitiveData,
  isAdmin,
  viewerRoleFor,
  timingSafeEqual,
} from '../src/telegram/auth';
import { buildTelegramResponse } from '../src/telegram/responses';
import type { TelegramConfig } from '../src/telegram/env';
import type { CaseRecord, TelegramMessage } from '../src/telegram/types';
import { parseIdList } from '../src/telegram/env';

const cfg: TelegramConfig = {
  botToken: 'bottoken1234567890abcdef',
  webhookSecret: 'supersecretwebhook',
  allowedGroupIds: ['-1001', '-1002'],
  adminUserIds: ['111'],
  allowedUserIds: ['222'],
};

const msg = (over: Partial<TelegramMessage> & { chat: TelegramMessage['chat'] }): TelegramMessage =>
  ({ text: '/ayuda', ...over }) as TelegramMessage;

describe('env.parseIdList', () => {
  it('splits, trims, de-dupes', () => {
    expect(parseIdList(' -1001, -1002 ,-1001 ')).toEqual(['-1001', '-1002']);
    expect(parseIdList(undefined)).toEqual([]);
  });
});

describe('webhook authentication', () => {
  it('timingSafeEqual is correct', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
  it('accepts the right secret, rejects wrong/missing', () => {
    expect(verifyWebhook('supersecretwebhook', cfg)).toBe(true);
    expect(verifyWebhook('nope', cfg)).toBe(false);
    expect(verifyWebhook(null, cfg)).toBe(false);
    expect(verifyWebhook(undefined, cfg)).toBe(false);
  });
});

describe('authorization', () => {
  it('allows approved groups, rejects unknown groups', () => {
    expect(isRequestAuthorized(msg({ chat: { id: -1001, type: 'group' }, from: { id: 999 } }), cfg)).toBe(true);
    expect(isRequestAuthorized(msg({ chat: { id: -1001, type: 'supergroup' }, from: { id: 999 } }), cfg)).toBe(true);
    expect(isRequestAuthorized(msg({ chat: { id: -9999, type: 'group' }, from: { id: 999 } }), cfg)).toBe(false);
  });
  it('allows DMs only for admins/authorized users', () => {
    expect(isRequestAuthorized(msg({ chat: { id: 111, type: 'private' }, from: { id: 111 } }), cfg)).toBe(true);
    expect(isRequestAuthorized(msg({ chat: { id: 222, type: 'private' }, from: { id: 222 } }), cfg)).toBe(true);
    expect(isRequestAuthorized(msg({ chat: { id: 333, type: 'private' }, from: { id: 333 } }), cfg)).toBe(false);
  });
  it('isAdmin / viewerRoleFor', () => {
    expect(isAdmin(111, cfg)).toBe(true);
    expect(isAdmin(222, cfg)).toBe(false);
    expect(viewerRoleFor(111, cfg)).toBe('admin');
    expect(viewerRoleFor(222, cfg)).toBe('authorized');
    expect(viewerRoleFor(333, cfg)).toBe('public');
  });
});

describe('canViewSensitiveData — sensitive only in admin/authorized DMs', () => {
  it('admin in a private DM may see sensitive', () => {
    expect(canViewSensitiveData(111, 111, 'private', cfg)).toBe(true);
  });
  it('admin in a GROUP may NOT see sensitive (broadcast risk)', () => {
    expect(canViewSensitiveData(111, -1001, 'group', cfg)).toBe(false);
  });
  it('public user never sees sensitive', () => {
    expect(canViewSensitiveData(333, 333, 'private', cfg)).toBe(false);
  });
});

describe('tokenize keeps quoted phrases', () => {
  it('treats "Maria Perez" as one token', () => {
    expect(tokenize('nombre "Maria Perez" nacimiento 1980-05-12')).toEqual([
      'nombre', 'Maria Perez', 'nacimiento', '1980-05-12',
    ]);
  });
});

describe('parseCommand', () => {
  it('/buscar cedula V12345678', () => {
    const c = parseCommand('/buscar cedula V12345678');
    expect(c.kind).toBe('buscar');
    expect(c.cedula).toBe('V12345678');
    expect(c.lang).toBe('es');
  });
  it('/buscar nombre + nacimiento', () => {
    const c = parseCommand('/buscar nombre "Maria Perez" nacimiento 1980-05-12');
    expect(c.name).toBe('Maria Perez');
    expect(c.dob).toBe('1980-05-12');
    expect(c.partialName).toBe(false);
  });
  it('/caso and /status take a case id', () => {
    expect(parseCommand('/caso EXP-2026-0123').caseId).toBe('EXP-2026-0123');
    expect(parseCommand('/status EXP-2026-0123').kind).toBe('status');
  });
  it('English command flips language', () => {
    const c = parseCommand('/hospitalized name "Jose Garcia"');
    expect(c.kind).toBe('hospitalizados');
    expect(c.lang).toBe('en');
    expect(c.name).toBe('Jose Garcia');
  });
  it('flags a partial (single-token) name', () => {
    expect(parseCommand('/missing nombre Ana').partialName).toBe(true);
  });
  it('/ayuda and /help', () => {
    expect(parseCommand('/ayuda').kind).toBe('ayuda');
    expect(parseCommand('/help').kind).toBe('ayuda');
    expect(parseCommand('/help').lang).toBe('en');
  });
  it('detects a bare cédula and a bare phone', () => {
    const c = parseCommand('/buscar V-12345678 +584141234567');
    expect(c.cedula).toBe('V-12345678');
    expect(c.phone).toBe('+584141234567');
  });
});

describe('buildTelegramResponse', () => {
  const base = { lang: 'es' as const, role: 'public' as const, canSeeSensitive: false };
  it('no_match', () => {
    expect(buildTelegramResponse({ kind: 'no_match' }, base)).toMatch(/No se encontró un registro verificado/);
  });
  it('multiple asks for more identifying data', () => {
    expect(buildTelegramResponse({ kind: 'multiple', count: 3 }, base)).toMatch(/varios posibles registros/);
  });
  it('need_more partial_name', () => {
    expect(buildTelegramResponse({ kind: 'need_more', reason: 'partial_name' }, base)).toMatch(/nombre completo/);
  });
  it('need_more phone_requires_admin', () => {
    expect(buildTelegramResponse({ kind: 'need_more', reason: 'phone_requires_admin' }, base)).toMatch(/operadores autorizados/);
  });
  it('unauthorized + rate_limited + help', () => {
    expect(buildTelegramResponse({ kind: 'unauthorized' }, base)).toMatch(/No autorizado/);
    expect(buildTelegramResponse({ kind: 'rate_limited', retryAfterSec: 12 }, base)).toMatch(/12s/);
    expect(buildTelegramResponse({ kind: 'help' }, base)).toMatch(/\/buscar/);
  });

  const rec: CaseRecord = {
    registry: 'hospital', internalId: 'hp_1', caseId: 'HOSP-hp_1', fullName: 'Jose Garcia',
    age: 50, isMinor: false, protectedFlag: false, internalStatus: 'hospitalizado',
    publicStatus: 'HOSPITALIZED', verification: 'VERIFIED', generalLocation: 'Caracas, Distrito Capital',
    lastVerifiedMs: Date.parse('2026-06-30T14:20:00Z'), matchStrength: 'name',
    sensitive: { cedula: '12345678', phone: '+584141234567', hospital: 'Hospital Vargas', medicalNotes: 'reservado' },
  };

  it('verified match (public) shows status but NO sensitive data', () => {
    const out = buildTelegramResponse({ kind: 'match', record: rec }, base);
    expect(out).toMatch(/Registro verificado/);
    expect(out).toMatch(/Estado: HOSPITALIZED/);
    expect(out).toMatch(/Nivel: VERIFIED/);
    expect(out).not.toContain('12345678');
    expect(out).not.toContain('Vargas');
    expect(out).not.toContain('Jose Garcia'); // name is not a public field
  });

  it('admin match (DM) includes the restricted detail block', () => {
    const out = buildTelegramResponse({ kind: 'match', record: rec }, { lang: 'es', role: 'admin', canSeeSensitive: true });
    expect(out).toContain('Jose Garcia');
    expect(out).toContain('12345678');
    expect(out).toContain('Hospital Vargas');
  });

  it('an unverified record never asserts a final status', () => {
    const pending: CaseRecord = { ...rec, publicStatus: 'PENDING_VERIFICATION', verification: 'PENDING_VERIFICATION' };
    const out = buildTelegramResponse({ kind: 'match', record: pending }, base);
    expect(out).toMatch(/PENDING_VERIFICATION/);
    expect(out).not.toMatch(/Estado: HOSPITALIZED/);
  });

  it('English verified match', () => {
    const out = buildTelegramResponse({ kind: 'match', record: rec }, { lang: 'en', role: 'public', canSeeSensitive: false });
    expect(out).toMatch(/Verified record/);
    expect(out).toMatch(/Status: HOSPITALIZED/);
  });
});
