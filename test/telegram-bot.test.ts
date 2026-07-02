// Auth, command-parsing, and response-builder tests for the Telegram bot.
import { describe, it, expect } from 'vitest';
import { parseCommand, tokenize } from '../src/telegram/commands';
import { chunkText } from '../src/telegram/route';
import {
  verifyWebhook,
  isRequestAuthorized,
  canViewSensitiveData,
  isAdmin,
  viewerRoleFor,
  timingSafeEqual,
} from '../src/telegram/auth';
import { buildTelegramResponse, buildListMessages } from '../src/telegram/responses';
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
  it('flags only too-short fragments as partial (a full single name is OK)', () => {
    expect(parseCommand('/missing nombre Jo').partialName).toBe(true);
    expect(parseCommand('/missing nombre Ana').partialName).toBe(false);
  });
  it('greetings and bare @-mentions resolve to the welcome', () => {
    expect(parseCommand('hola').kind).toBe('ayuda');
    expect(parseCommand('Hola!').kind).toBe('ayuda');
    expect(parseCommand('buenas').kind).toBe('ayuda');
    expect(parseCommand('@Vzla911bot').kind).toBe('ayuda');
    expect(parseCommand('@Vzla911bot hola').kind).toBe('ayuda');
    expect(parseCommand('hi').kind).toBe('ayuda');
    expect(parseCommand('hi').lang).toBe('en');
  });
  it('tolerates a leading mention before a real command', () => {
    expect(parseCommand('@Vzla911bot /caso EXP-2026-1').caseId).toBe('EXP-2026-1');
    const c = parseCommand('@Vzla911bot Moises Carpio');
    expect(c.kind).toBe('buscar');
    expect(c.name).toBe('Moises Carpio');
  });
  it('accepts command words without a slash, and names without quotes', () => {
    expect(parseCommand('caso EXP-2026-1').kind).toBe('caso');
    expect(parseCommand('buscar Maria Perez').name).toBe('Maria Perez');
  });
  it('unknown slash command falls back to the welcome', () => {
    expect(parseCommand('/wat').kind).toBe('ayuda');
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
  it('unauthorized + rate_limited', () => {
    expect(buildTelegramResponse({ kind: 'unauthorized' }, base)).toMatch(/No autorizado/);
    expect(buildTelegramResponse({ kind: 'rate_limited', retryAfterSec: 12 }, base)).toMatch(/12s/);
  });
  it('welcome (help) greets and lists every command', () => {
    const w = buildTelegramResponse({ kind: 'help' }, base);
    expect(w).toMatch(/Hola/);
    for (const cmd of ['/buscar', '/caso', '/status', '/hospitalizados', '/missing', '/ayuda']) {
      expect(w).toContain(cmd);
    }
  });

  const rec: CaseRecord = {
    registry: 'hospital', internalId: 'hp_1', caseId: 'HOSP-hp_1', fullName: 'Jose Garcia',
    age: 50, isMinor: false, protectedFlag: false, internalStatus: 'hospitalizado',
    publicStatus: 'HOSPITALIZED', verification: 'VERIFIED', generalLocation: 'Caracas, Distrito Capital',
    lastVerifiedMs: Date.parse('2026-06-30T14:20:00Z'), matchStrength: 'name',
    sensitive: { cedula: '12345678', phone: '+584141234567', hospital: 'Hospital Vargas', medicalNotes: 'reservado' },
  };

  it('verified match (public) shows humanized status + profile link but NO sensitive data', () => {
    const out = buildTelegramResponse({ kind: 'match', record: rec }, base);
    expect(out).toMatch(/Registro verificado/);
    expect(out).toMatch(/Estado: 🏥 En un hospital/);
    expect(out).toMatch(/Nivel: VERIFIED/);
    expect(out).toMatch(/Ficha: https:\/\/sismo911\.com\/casos#caso=HOSP-hp_1/);
    expect(out).not.toContain('12345678');
    expect(out).not.toContain('Vargas');
    expect(out).not.toContain('Jose Garcia'); // name is not a public field
  });
  it('splits a long list into card messages, EACH with a (parte i/total) header', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ...rec, internalId: `hp_${i}`, caseId: `HOSP-hp_${i}`, fullName: `Persona ${i}` }));
    const msgs = buildListMessages(many, base, 'MARIA DELGADO');
    expect(msgs.length).toBeGreaterThan(1);
    msgs.forEach((m, i) => {
      expect(m).toContain(`(parte ${i + 1}/${msgs.length})`);
      expect(m).toContain('«MARIA DELGADO» — 40 registros'); // total reflects the whole search
      expect(m).toMatch(/🏥 <b>Persona \d+<\/b>/); // card: bold name
    });
  });
  it('single-page list has no "parte" label', () => {
    const [msg] = buildListMessages([rec], base, 'Jose');
    expect(msg).not.toContain('parte');
  });
  it('respects a custom baseUrl for the profile link', () => {
    const out = buildTelegramResponse({ kind: 'match', record: rec }, { ...base, baseUrl: 'https://sismo911.com' });
    expect(out).toContain('https://sismo911.com/casos#caso=HOSP-hp_1');
  });
  it("/caso (detail:full) shows name + age + link, still no sensitive PII in a group", () => {
    const out = buildTelegramResponse({ kind: 'match', record: rec, detail: 'full' }, base);
    expect(out).toMatch(/Detalle del caso/);
    expect(out).toContain('Nombre: <b>Jose Garcia</b>');
    expect(out).toContain('Edad: 50');
    expect(out).toMatch(/Ficha: https:\/\/sismo911\.com\/casos#caso=HOSP-hp_1/);
    expect(out).not.toContain('12345678'); // cédula still hidden in a group
    expect(out).not.toContain('Vargas');
  });
  it("/caso (detail:full) as admin DM adds the operator block", () => {
    const out = buildTelegramResponse({ kind: 'match', record: rec, detail: 'full' }, { lang: 'es', role: 'admin', canSeeSensitive: true });
    expect(out).toContain('Nombre: <b>Jose Garcia</b>');
    expect(out).toContain('12345678');
    expect(out).toContain('Hospital Vargas');
  });
  it('/status (detail:status) is a short status line with the link', () => {
    const out = buildTelegramResponse({ kind: 'match', record: rec, detail: 'status' }, base);
    expect(out).toMatch(/Caso: HOSP-hp_1/);
    expect(out).toMatch(/Estado: 🏥 En un hospital/);
    expect(out).toMatch(/Ficha: https:\/\/sismo911\.com\/casos#caso=HOSP-hp_1/);
    expect(out).not.toContain('Nombre');
    expect(out).not.toContain('Ubicación');
  });
  it('list renders every record as a formal card (bold name, humanized status, linked ficha; no PII)', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...rec, internalId: `hp_${i}`, caseId: `HOSP-hp_${i}`, fullName: `Persona ${i}` }));
    const [msg] = buildListMessages(many, base, 'MARIA DELGADO');
    expect(msg).toMatch(/🔎 «MARIA DELGADO» — 5 registros:/);
    expect(msg).toContain('🏥 <b>Persona 0</b>');
    expect(msg).toContain('🏥 <b>Persona 4</b>');
    // Humanized status + facility (public on /hospitales for the hospital registry) + coarsened location.
    expect((msg.match(/En un hospital — Hospital Vargas \(Distrito Capital\)/g) || []).length).toBe(5);
    expect((msg.match(/<a href="https:\/\/sismo911\.com\/casos#caso=HOSP-hp_\d+">Ver ficha<\/a>/g) || []).length).toBe(5);
    expect(msg).toContain('HOSP-hp_0 · Verificado 2026-06-30');
    expect(msg).not.toMatch(/HOSPITALIZED/); // raw enum never shown
    expect(msg).not.toContain('12345678'); // no cédula/phone PII in the list
  });
  it('card for a SISMO911-registry (personas) record never shows a facility', () => {
    const persona: CaseRecord = {
      ...rec, registry: 'personas', internalId: 'p1', caseId: 'FAM-p1', fullName: 'Ana <Prueba>',
      sensitive: { hospital: 'Hospital Secreto' },
    };
    const [msg] = buildListMessages([persona], base, 'Ana');
    expect(msg).not.toContain('Hospital Secreto'); // operator-only for non-hospital registries
    expect(msg).toContain('En un hospital — Distrito Capital');
    expect(msg).toContain('🏥 <b>Ana &lt;Prueba&gt;</b>'); // DB text is HTML-escaped
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
    expect(out).toMatch(/Pendiente de verificación/);
    expect(out).not.toMatch(/En un hospital/);
  });

  it('English verified match', () => {
    const out = buildTelegramResponse({ kind: 'match', record: rec }, { lang: 'en', role: 'public', canSeeSensitive: false });
    expect(out).toMatch(/Verified record/);
    expect(out).toMatch(/Status: 🏥 In a hospital/);
  });
});

describe('chunkText splits long replies for Telegram', () => {
  it('keeps short text as one chunk', () => {
    expect(chunkText('hola', 100)).toEqual(['hola']);
  });
  it('splits at line boundaries under the max', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(80)}`).join('\n');
    const chunks = chunkText(lines, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
    expect(chunks.join('\n')).toBe(lines);
  });
});
