// OCR-artifact normalization: repair only mechanically-unambiguous age units,
// FLAG (never rewrite) suspect names. Corpus drawn from the real 2026-07-05
// Telegram roster that motivated the module.
import { describe, it, expect } from 'vitest';
import { repairAgeToken, cleanOcrName, isAgeUnitToken, mergeFlags, ocrNote } from '../src/lib/ocr-normalize';
import { parseRosterLine, parseTextRoster } from '../src/telegram/intake/text-roster';
import { normalize } from '../src/telegram/intake/extract';
import { persist } from '../src/telegram/intake/persist';
import type { Env } from '../src/types';
import type { IntakeMedia } from '../src/telegram/intake/types';

describe('isAgeUnitToken', () => {
  it('accepts años/anos and known OCR misreads', () => {
    for (const t of ['años', 'anos', 'año', 'ohms', 'afios', 'anios', 'aros', 'aftos']) {
      expect(isAgeUnitToken(t), t).toBe(true);
    }
  });
  it('rejects real words and numbers', () => {
    for (const t of ['metros', 'kilos', 'nombre', '99', 'a1os']) {
      expect(isAgeUnitToken(t), t).toBe(false);
    }
  });
});

describe('repairAgeToken', () => {
  it('reads a clean "· N años" tail without marking repair', () => {
    expect(repairAgeToken('ALEXIS RODRÍGUEZ · 9 años')).toEqual({ age: 9, rest: 'ALEXIS RODRÍGUEZ', repaired: false });
  });
  it('repairs OCR-garbled units and marks the repair', () => {
    expect(repairAgeToken('DENIS YANES · 22 ohms')).toEqual({ age: 22, rest: 'DENIS YANES', repaired: true });
    expect(repairAgeToken('ELSA GARCEDA - 79 afios')).toEqual({ age: 79, rest: 'ELSA GARCEDA', repaired: true });
  });
  it('accepts age 0 (infants) and a bare trailing number', () => {
    expect(repairAgeToken('YOILE ESCALONA · 0 años').age).toBe(0);
    expect(repairAgeToken('MARIA PEREZ - 40')).toMatchObject({ age: 40, repaired: false });
  });
  it('leaves non-age tails alone', () => {
    expect(repairAgeToken('ACUÑA')).toEqual({ age: null, rest: 'ACUÑA', repaired: false });
    expect(repairAgeToken('CALLE 5 CASA 12 metros')).toMatchObject({ age: null });
  });
});

describe('cleanOcrName', () => {
  it('passes clean names through untouched', () => {
    const c = cleanOcrName('SONIA DE FERNANDEZ');
    expect(c.name).toBe('SONIA DE FERNANDEZ');
    expect(c.flags).toEqual([]);
  });
  it('drops ILEGIBLE markers and flags the record', () => {
    const c = cleanOcrName('ILEGIBLE SOL');
    expect(c.name).toBe('SOL');
    expect(c.flags).toContain('illegible_marker');
    expect(c.original).toBe('ILEGIBLE SOL');
    expect(cleanOcrName('(ilegible)').name).toBeNull();
  });
  it('flags fused single-token names without rewriting them', () => {
    const c = cleanOcrName('JERRYSCOBAR');
    expect(c.name).toBe('JERRYSCOBAR'); // preserved verbatim — No-Fabrication
    expect(c.flags).toContain('suspect_glyphs');
  });
  it('does not flag legitimate long or short names', () => {
    for (const n of ['GONCALVES', 'MAXXIMILIANO RODRÍGUEZ', 'JUAN ROBERTO DE FREITAS', 'ACUÑA']) {
      expect(cleanOcrName(n).flags, n).toEqual([]);
    }
  });
  it('flags digit-bearing and vowel-less tokens', () => {
    expect(cleanOcrName('MAR1A PEREZ').flags).toContain('suspect_glyphs');
    expect(cleanOcrName('XXRT PEREZ').flags).toContain('suspect_glyphs');
  });
  it('strips edge junk', () => {
    expect(cleanOcrName('| MARIA PEREZ ~').name).toBe('MARIA PEREZ');
  });
});

describe('mergeFlags / ocrNote', () => {
  it('dedupes and preserves order', () => {
    expect(mergeFlags(['suspect_glyphs'], ['suspect_glyphs', 'age_unit_repaired'])).toEqual(['suspect_glyphs', 'age_unit_repaired']);
  });
  it('note carries the original text', () => {
    expect(ocrNote(['illegible_marker'], 'ILEGIBLE SOL')).toContain('ILEGIBLE SOL');
  });
});

describe('integration: roster line parsing with flags', () => {
  it('flags the repaired-age line but keeps the data', () => {
    const rec = parseRosterLine('34 DENIS YANES · 22 ohms');
    expect(rec).toMatchObject({ nombre: 'Denis Yanes', edad: 22 });
    expect(rec?.ocrFlags).toContain('age_unit_repaired');
  });
  it('clean lines carry no flags', () => {
    expect(parseRosterLine('1 ALEXIS RODRÍGUEZ · 9 años')?.ocrFlags).toBeUndefined();
  });
  it('an ILEGIBLE-only line is dropped, a partial one is flagged', () => {
    expect(parseRosterLine('68 ILEGIBLE')).toBeNull();
    const rec = parseRosterLine('68 ILEGIBLE SOL · 21 años');
    expect(rec).toMatchObject({ nombre: 'Sol', edad: 21 });
    expect(rec?.ocrFlags).toContain('illegible_marker');
  });
});

describe('integration: extract.normalize applies OCR hygiene', () => {
  it('flags suspect AI-extracted names and accepts edad 0', () => {
    const rec = normalize({ nombre: 'JERRYSCOBAR', edad: 0 });
    expect(rec.nombre).toBe('JERRYSCOBAR');
    expect(rec.edad).toBe(0);
    expect(rec.ocrFlags).toContain('suspect_glyphs');
  });
});

describe('integration: persist never auto-approves a flagged record', () => {
  function fakeEnv() {
    const stmt = { bind: () => stmt, first: async () => null, all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 1 } }) };
    return {
      DB: { prepare: () => stmt },
      PERSON_PHOTOS: { put: async () => undefined },
      DESAP_FOTOS: { put: async () => undefined },
    } as unknown as Env;
  }
  const media: IntakeMedia = { fileId: 'x', mime: 'text/plain', fileName: 'l.txt', bytes: new Uint8Array() };

  it('admin submission of a flagged record stays pending with an OCR note', async () => {
    const r = await persist(fakeEnv(), {
      submissionId: 'itk_test0001',
      code: 'ITK-TEST0001',
      media,
      fields: { nombre: 'Jerryscobar', cedula: null, edad: 31, ubicacion: null, fecha: null, contacto: null, descripcion: null, ocrFlags: ['suspect_glyphs'] },
      match: { personId: null, score: 0, reason: 'none' },
      tgUserId: '9',
      tgUsername: null,
      tgChatId: '1',
      rawKey: 'intake/bulk/test.txt',
      autoApprove: true, // admin — must be overridden by the flag
    });
    expect(r.outcome).toBe('created');
    expect(r.autoApproved).toBeFalsy();
    expect(r.note).toContain('Posible error de OCR');
  });
});
