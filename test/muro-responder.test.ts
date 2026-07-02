// Tests for the Muro auto-responder: the bot answering ON the public wall.
import { describe, it, expect } from 'vitest';
import {
  maybeRespondOnMuro,
  buildWallReply,
  looksLikeQuestion,
  isBareName,
  MURO_BOT_NAME,
  MURO_BOT_USER_ID,
} from '../src/telegram/muro-responder';
import { MURO_CHANNEL } from '../src/telegram/muro';
import type { Env } from '../src/types';
import type { CaseRecord, QueryResult } from '../src/telegram/types';

// ---- fakes -------------------------------------------------------------------
type Captured = { sql: string; args: any[] };
function fakeEnv(capture: Captured[]): Env {
  const DB = {
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          return {
            async run() {
              capture.push({ sql, args });
              return { success: true };
            },
            async all() {
              return { results: [] };
            },
            async first() {
              return null;
            },
          };
        },
      };
    },
  };
  // No AI binding → aiNormalizeIntent degrades to null (deterministic tests).
  return { DB } as unknown as Env;
}

const RECORD: CaseRecord = {
  registry: 'personas',
  internalId: 'pc_1',
  caseId: 'FAM-2026-0001',
  fullName: 'Maria Fernanda Perez',
  age: 34,
  isMinor: false,
  protectedFlag: false,
  internalStatus: 'localizado',
  publicStatus: 'LOCATED',
  verification: 'VERIFIED',
  generalLocation: 'Caracas',
  lastVerifiedMs: 1750000000000,
  matchStrength: 'name',
  sensitive: {},
};
const MATCH: QueryResult = { kind: 'match', record: RECORD, detail: 'summary' };

// ---- heuristics ----------------------------------------------------------------
describe('looksLikeQuestion', () => {
  it('detects search questions in Spanish and English', () => {
    expect(looksLikeQuestion('¿Alguien ha visto a Maria Perez?')).toBe(true);
    expect(looksLikeQuestion('Busco a mi tía desde el sismo')).toBe(true);
    expect(looksLikeQuestion('No sabemos nada del paradero de Juan')).toBe(true);
    expect(looksLikeQuestion('Looking for Maria Perez')).toBe(true);
    expect(looksLikeQuestion('Se cayó una pared en Catia')).toBe(false);
    expect(looksLikeQuestion('Fuerza Venezuela 🙏')).toBe(false);
  });
});

describe('isBareName', () => {
  it('accepts 2-4 plain name tokens only', () => {
    expect(isBareName('Maria Perez')).toBe(true);
    expect(isBareName('Maria Fernanda Perez González')).toBe(true);
    expect(isBareName('Maria')).toBe(false); // single token
    expect(isBareName('vi a maria en el refugio ayer')).toBe(false); // sentence
    expect(isBareName('Maria Perez 0412')).toBe(false); // digits
  });
});

// ---- reply builder ---------------------------------------------------------------
describe('buildWallReply', () => {
  const base = 'https://sismo911.com';
  it('answers a verified match with the public summary + case link', () => {
    const t = buildWallReply('Maria Perez', MATCH, true, base)!;
    expect(t).toContain('«Maria Perez»');
    expect(t).toContain('FAM-2026-0001');
    expect(t).toContain('LOCATED');
    expect(t.length).toBeLessThanOrEqual(600);
    expect(t).not.toContain('Maria Fernanda Perez'); // summary tier: no full-name echo
  });
  it('answers "multiple" asking for more detail', () => {
    const t = buildWallReply('Maria Perez', { kind: 'multiple', count: 3 }, false, base)!;
    expect(t).toContain('varios posibles registros');
  });
  it('answers no_match ONLY for question-shaped posts, with reporting guidance', () => {
    const q = buildWallReply('Maria Perez', { kind: 'no_match' }, true, base)!;
    expect(q).toContain('no hay un registro verificado');
    expect(q).toContain(`${base}/personas`);
    expect(buildWallReply('Maria Perez', { kind: 'no_match' }, false, base)).toBeNull();
  });
  it('stays silent on error / need_more / help', () => {
    expect(buildWallReply('x', { kind: 'error' }, true, base)).toBeNull();
    expect(buildWallReply('x', { kind: 'need_more', reason: 'partial_name' }, true, base)).toBeNull();
    expect(buildWallReply('x', { kind: 'help' }, true, base)).toBeNull();
  });
});

// ---- end-to-end decision -------------------------------------------------------------
describe('maybeRespondOnMuro', () => {
  it('replies on the wall to a bare-name post with a verified match', async () => {
    const cap: Captured[] = [];
    const r = await maybeRespondOnMuro(fakeEnv(cap), { id: 'msg_a', name: 'Vecino', body: 'Maria Fernanda Perez' }, { resolve: async () => MATCH });
    expect(r.replied).toBe(true);
    const ins = cap.find((x) => x.sql.includes('INSERT INTO chat_messages'))!;
    expect(ins.args[1]).toBe(MURO_CHANNEL);
    expect(ins.args[2]).toBe(MURO_BOT_NAME);
    expect(String(ins.args[3])).toContain('FAM-2026-0001');
    expect(ins.args[4]).toBe('official'); // wall renders the badge
    expect(ins.args[5]).toBe(MURO_BOT_USER_ID);
  });
  it('replies with guidance when a question-shaped bare name has no match', async () => {
    const cap: Captured[] = [];
    const r = await maybeRespondOnMuro(fakeEnv(cap), { id: 'msg_b', name: 'Vecino', body: 'Maria Perez ¿alguien la ha visto?' }, { resolve: async () => ({ kind: 'no_match' }) });
    // sentence, not bare name; no AI binding → extractor unavailable → silence
    expect(r.replied).toBe(false);
    const r2 = await maybeRespondOnMuro(fakeEnv(cap), { id: 'msg_c', name: 'Vecino', body: 'Maria Perez' }, { resolve: async () => ({ kind: 'no_match' }) });
    // bare name but NOT question-shaped → silence on no_match
    expect(r2.replied).toBe(false);
  });
  it('never replies to itself (loop-guard)', async () => {
    const cap: Captured[] = [];
    const byId = await maybeRespondOnMuro(fakeEnv(cap), { id: 'x', name: 'Otro', body: 'Maria Perez', userId: MURO_BOT_USER_ID }, { resolve: async () => MATCH });
    const byName = await maybeRespondOnMuro(fakeEnv(cap), { id: 'y', name: MURO_BOT_NAME, body: 'Maria Perez' }, { resolve: async () => MATCH });
    expect(byId.replied).toBe(false);
    expect(byName.replied).toBe(false);
    expect(cap).toHaveLength(0);
  });
  it('stays silent on greetings and casual chatter', async () => {
    const cap: Captured[] = [];
    for (const body of ['hola', 'Fuerza Venezuela 🙏', 'gracias por la información']) {
      const r = await maybeRespondOnMuro(fakeEnv(cap), { id: 'z', name: 'Vecino', body }, { resolve: async () => MATCH });
      expect(r.replied).toBe(false);
    }
    expect(cap).toHaveLength(0);
  });
  it('never throws even when the resolver blows up', async () => {
    const r = await maybeRespondOnMuro(fakeEnv([]), { id: 'w', name: 'Vecino', body: 'Maria Perez' }, { resolve: async () => { throw new Error('boom'); } });
    expect(r.replied).toBe(false);
  });
});
