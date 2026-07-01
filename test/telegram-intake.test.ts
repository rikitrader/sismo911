// Unit tests for the Telegram photo/PDF intake pipeline (pure logic + matching).
import { describe, it, expect } from 'vitest';
import { pickMedia } from '../src/telegram/intake/download';
import { isIntakeMessage } from '../src/telegram/intake';
import { matchCase } from '../src/telegram/intake/match';
import { summarize } from '../src/telegram/intake/persist';
import { buildReceipt } from '../src/telegram/intake/notify';
import type { ExtractedRecord } from '../src/telegram/intake/types';
import type { TelegramMessage } from '../src/telegram/types';
import type { Env } from '../src/types';

const chat = { id: 555, type: 'private' as const };

function msg(extra: Record<string, unknown>): TelegramMessage {
  return { chat, ...extra } as unknown as TelegramMessage;
}

/** Minimal D1 stub: routes queries by table name in the SQL. */
function fakeEnv(opts: { identity?: { person_id: string } | null; personas?: Array<{ id: string; name_norm: string }> }): Env {
  const DB = {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async first() {
              return sql.includes('case_identity') ? (opts.identity ?? null) : null;
            },
            async all() {
              return { results: sql.includes('personas') ? (opts.personas ?? []) : [] };
            },
          };
        },
      };
    },
  };
  return { DB } as unknown as Env;
}

describe('pickMedia', () => {
  it('picks the largest photo', () => {
    const p = pickMedia(msg({ photo: [{ file_id: 'small' }, { file_id: 'big' }] }));
    expect(p).toEqual({ fileId: 'big', mime: 'image/jpeg', fileName: 'photo.jpg' });
  });

  it('accepts a PDF document', () => {
    const p = pickMedia(msg({ document: { file_id: 'd1', mime_type: 'application/pdf', file_name: 'reporte.pdf' } }));
    expect(p).toMatchObject({ fileId: 'd1', mime: 'application/pdf', fileName: 'reporte.pdf' });
  });

  it('accepts an image document', () => {
    const p = pickMedia(msg({ document: { file_id: 'd2', mime_type: 'image/png' } }));
    expect(p?.mime).toBe('image/png');
  });

  it('rejects unsupported documents', () => {
    expect(pickMedia(msg({ document: { file_id: 'd3', mime_type: 'application/zip' } }))).toBeNull();
  });

  it('returns null for a text-only message', () => {
    expect(pickMedia(msg({ text: 'hola' }))).toBeNull();
    expect(isIntakeMessage(msg({ text: 'hola' }))).toBe(false);
    expect(isIntakeMessage(msg({ photo: [{ file_id: 'x' }] }))).toBe(true);
  });
});

const rec = (over: Partial<ExtractedRecord>): ExtractedRecord => ({
  nombre: null,
  cedula: null,
  edad: null,
  ubicacion: null,
  fecha: null,
  contacto: null,
  descripcion: null,
  ...over,
});

describe('matchCase', () => {
  it('matches by cédula (strongest)', async () => {
    const env = fakeEnv({ identity: { person_id: 'fam-pc_abc' } });
    const m = await matchCase(env, rec({ cedula: '12345678', nombre: 'Cualquiera' }));
    expect(m).toEqual({ personId: 'fam-pc_abc', score: 0.99, reason: 'cedula' });
  });

  it('matches by fuzzy name when no cédula', async () => {
    const env = fakeEnv({ personas: [{ id: 'pc_x', name_norm: 'juan perez gomez' }] });
    const m = await matchCase(env, rec({ nombre: 'Juan Pérez Gómez' }));
    expect(m.reason).toBe('name');
    expect(m.personId).toBe('fam-pc_x');
    expect(m.score).toBeGreaterThanOrEqual(0.6);
  });

  it('does not match a weak name overlap', async () => {
    const env = fakeEnv({ personas: [{ id: 'pc_y', name_norm: 'maria lopez rangel' }] });
    const m = await matchCase(env, rec({ nombre: 'Juan Pérez Gómez' }));
    expect(m.reason).toBe('none');
    expect(m.personId).toBeNull();
  });

  it('returns none when nothing is extracted', async () => {
    const env = fakeEnv({});
    expect(await matchCase(env, rec({}))).toEqual({ personId: null, score: 0, reason: 'none' });
  });
});

describe('summarize + buildReceipt', () => {
  it('summarizes present fields only', () => {
    const s = summarize(rec({ nombre: 'Ana', cedula: '999', ubicacion: 'La Guaira' }));
    expect(s).toContain('Nombre: Ana');
    expect(s).toContain('Cédula: 999');
    expect(s).not.toContain('Edad');
  });

  it('falls back when empty', () => {
    expect(summarize(rec({}))).toBe('Sin datos legibles.');
  });

  it('receipt carries the tracking code and a per-outcome line', () => {
    const base = { submissionId: 'itk_x', code: 'ITK-ABC', personId: null, intelId: null, fields: rec({}), score: 0, note: '' };
    expect(buildReceipt({ ...base, outcome: 'created' })).toContain('ITK-ABC');
    expect(buildReceipt({ ...base, outcome: 'created' })).toContain('caso nuevo');
    expect(buildReceipt({ ...base, outcome: 'needs_review' })).toContain('nombre');
  });
});
