// Pasted-text roster intake: detection, deterministic parsing, preview
// mapping (duplicate check BEFORE creation), and the /confirmar–/cancelar gate.
// Fixture lines mirror the real 2026-07-05 list that motivated the feature.
import { describe, it, expect } from 'vitest';
import {
  looksLikeTextRoster,
  parseTextRoster,
  parseRosterLine,
  parseLoteCommand,
  buildPreviewReply,
  saveBatch,
  loadBatch,
  deleteBatch,
  resolveLoteCommand,
  type TextRosterBatch,
} from '../src/telegram/intake/text-roster';
import type { Env } from '../src/types';
import type { TelegramConfig } from '../src/telegram/env';
import type { TelegramMessage } from '../src/telegram/types';

const ROSTER = [
  'Niños / Adolescentes (Hasta 17 años)',
  '1 ALEXIS RODRÍGUEZ · 9 años',
  '2 ANDER TORREALBA · 16 años',
  '3 BEYLA RAMÍREZ · 9 años',
  '4 ISABEL PEÑA · 15 años',
  '5 YOILE ESCALONA · 0 años',
  'Adultos (18 años en adelante)',
  '1 ACUÑA',
  '2 ALBERTO FIGUEROA · 40 años',
  '3 DENIS YANES · 22 ohms',
  '4 SONIA DE FERNANDEZ · 58 años',
].join('\n');

function fakeKV() {
  const store = new Map<string, string>();
  return {
    async put(k: string, v: string) {
      store.set(k, v);
    },
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async delete(k: string) {
      store.delete(k);
    },
  };
}

/** Env stub: KV-backed CACHE + a DB whose name searches return no candidates. */
function fakeEnv(): Env {
  const stmt = {
    bind: () => stmt,
    first: async () => null,
    all: async () => ({ results: [] }),
    run: async () => ({ meta: { changes: 1 } }),
  };
  return { CACHE: fakeKV(), DB: { prepare: () => stmt }, PERSON_PHOTOS: { put: async () => undefined }, AI: undefined } as unknown as Env;
}

describe('parseRosterLine', () => {
  it('parses "N NAME · age años" with accents and Title-Cases the name', () => {
    expect(parseRosterLine('1 ALEXIS RODRÍGUEZ · 9 años')).toMatchObject({ nombre: 'Alexis Rodríguez', edad: 9 });
  });
  it('treats OCR "ohms" as años and keeps particles lowercase', () => {
    expect(parseRosterLine('34 DENIS YANES · 22 ohms')).toMatchObject({ nombre: 'Denis Yanes', edad: 22 });
    expect(parseRosterLine('150 SONIA DE FERNANDEZ · 58 años')).toMatchObject({ nombre: 'Sonia de Fernandez', edad: 58 });
  });
  it('accepts a numbered name with no age', () => {
    expect(parseRosterLine('1 ACUÑA')).toMatchObject({ nombre: 'Acuña', edad: null });
  });
  it('rejects headings and non-name lines', () => {
    expect(parseRosterLine('Niños / Adolescentes (Hasta 17 años)')).toBeNull();
    expect(parseRosterLine('hola como estas')).toBeNull();
    expect(parseRosterLine('1 http://x.com/y')).toBeNull();
  });
});

describe('parseTextRoster / looksLikeTextRoster', () => {
  it('parses the fixture list, skipping section headings', () => {
    const recs = parseTextRoster(ROSTER);
    expect(recs.length).toBe(9);
    expect(recs[0].nombre).toBe('Alexis Rodríguez');
    expect(recs.some((r) => r.nombre === 'Yoile Escalona' && r.edad === 0)).toBe(true);
  });
  it('detects a pasted roster', () => {
    expect(looksLikeTextRoster(ROSTER)).toBe(true);
  });
  it('does not fire on commands, prose, or short lists', () => {
    expect(looksLikeTextRoster('/buscar nombre "Maria Perez"')).toBe(false);
    expect(looksLikeTextRoster('Hola, vi a Maria Perez en el refugio de Catia ayer por la tarde.')).toBe(false);
    expect(looksLikeTextRoster('1 MARIA PEREZ\n2 JOSE GARCIA\n3 ANA DIAZ')).toBe(false); // < 5 lines
  });
});

describe('parseLoteCommand', () => {
  it('parses confirm and cancel with or without slash', () => {
    expect(parseLoteCommand('/confirmar LOT-A1B2C3')).toEqual({ action: 'confirmar', code: 'LOT-A1B2C3' });
    expect(parseLoteCommand('cancelar lot-a1b2c3')).toEqual({ action: 'cancelar', code: 'LOT-A1B2C3' });
    expect(parseLoteCommand('/confirm LOT-XY99ZZ')).toEqual({ action: 'confirmar', code: 'LOT-XY99ZZ' });
  });
  it('ignores unrelated text', () => {
    expect(parseLoteCommand('/confirmar')).toBeNull();
    expect(parseLoteCommand('confirmo que si')).toBeNull();
  });
});

describe('batch lifecycle', () => {
  const cfg = { botToken: 't', adminUserIds: ['9'] } as unknown as TelegramConfig;
  const msgFrom = (chatId: number, userId: number): TelegramMessage =>
    ({ chat: { id: chatId, type: 'private' }, from: { id: userId }, text: '' }) as unknown as TelegramMessage;

  function mkBatch(): TextRosterBatch {
    return {
      code: 'LOT-TEST01',
      chatId: '100',
      tgUserId: '9',
      tgUsername: null,
      records: parseTextRoster(ROSTER),
      duplicates: 0,
      sourceText: ROSTER,
      createdMs: 0,
    };
  }

  it('round-trips through KV and deletes on cancel', async () => {
    const env = fakeEnv();
    await saveBatch(env, mkBatch());
    expect((await loadBatch(env, 'LOT-TEST01'))?.records.length).toBe(9);
    const reply = await resolveLoteCommand(env, cfg, msgFrom(100, 9), { action: 'cancelar', code: 'LOT-TEST01' });
    expect(reply).toContain('descartada');
    expect(await loadBatch(env, 'LOT-TEST01')).toBeNull();
  });

  it('refuses confirmation from a different chat', async () => {
    const env = fakeEnv();
    await saveBatch(env, mkBatch());
    const reply = await resolveLoteCommand(env, cfg, msgFrom(200, 9), { action: 'confirmar', code: 'LOT-TEST01' });
    expect(reply).toContain('otro chat');
    expect(await loadBatch(env, 'LOT-TEST01')).not.toBeNull(); // untouched
  });

  it('reports an unknown/expired code', async () => {
    const env = fakeEnv();
    const reply = await resolveLoteCommand(env, cfg, msgFrom(100, 9), { action: 'confirmar', code: 'LOT-NOPE99' });
    expect(reply).toContain('No encuentro la lista');
  });

  it('claims the batch on confirm so a second /confirmar cannot duplicate', async () => {
    const env = fakeEnv();
    await saveBatch(env, mkBatch());
    await resolveLoteCommand(env, cfg, msgFrom(100, 9), { action: 'confirmar', code: 'LOT-TEST01' });
    expect(await loadBatch(env, 'LOT-TEST01')).toBeNull();
    const again = await resolveLoteCommand(env, cfg, msgFrom(100, 9), { action: 'confirmar', code: 'LOT-TEST01' });
    expect(again).toContain('No encuentro la lista');
  });
});

describe('buildPreviewReply', () => {
  it('shows totals, duplicate mapping, and the confirm gate', () => {
    const batch = { code: 'LOT-TEST01', chatId: '1', tgUserId: null, tgUsername: null, records: [], duplicates: 1, sourceText: '', createdMs: 0 } as TextRosterBatch;
    const reply = buildPreviewReply(batch, [
      { rec: { nombre: 'Maria Perez', cedula: null, edad: 40, ubicacion: null, fecha: null, contacto: null, descripcion: null }, match: { personId: 'pc_abc123', score: 0.87, reason: 'name' } },
      { rec: { nombre: 'Jose Nuevo', cedula: null, edad: 20, ubicacion: null, fecha: null, contacto: null, descripcion: null }, match: { personId: null, score: 0, reason: 'none' } },
    ]);
    expect(reply).toContain('<b>2</b> persona(s)');
    expect(reply).toContain('<b>1</b> no están en la base de datos');
    expect(reply).toContain('Maria Perez ≈ caso <code>pc_abc123</code> (87%)');
    expect(reply).toContain('/confirmar LOT-TEST01');
    expect(reply).toContain('NO he creado nada');
  });
});
