// Tests for the Telegram ↔ Muro de Emergencia bridge: /muro parsing, wall
// writes/reads (postToMuro, searchMuroMentions, latestMuroPosts) and the
// deterministic replies (post confirmation, latest list, mentions section).
import { describe, it, expect } from 'vitest';
import { parseCommand } from '../src/telegram/commands';
import { postToMuro, searchMuroMentions, latestMuroPosts, muroDisplayName, MURO_CHANNEL, MURO_MAX_LEN } from '../src/telegram/muro';
import { buildMuroPostResponse, buildMuroLatestResponse, buildMuroMentions, buildTelegramResponse, type BuildOpts } from '../src/telegram/responses';
import type { Env } from '../src/types';

// ---- parsing ----------------------------------------------------------------
describe('parseCommand /muro', () => {
  it('parses /muro with text (raw text preserved)', () => {
    const c = parseCommand('/muro Vi a Maria Perez en el refugio de Catia');
    expect(c.kind).toBe('muro');
    expect(c.muroText).toBe('Vi a Maria Perez en el refugio de Catia');
  });
  it('parses /wall in English', () => {
    const c = parseCommand('/wall I saw Maria at the shelter');
    expect(c.kind).toBe('muro');
    expect(c.lang).toBe('en');
    expect(c.muroText).toBe('I saw Maria at the shelter');
  });
  it('bare /muro → empty text (list mode)', () => {
    const c = parseCommand('/muro');
    expect(c.kind).toBe('muro');
    expect(c.muroText).toBe('');
  });
  it('tolerates a bot-mention suffix and leading @-mention', () => {
    expect(parseCommand('/muro@Vzla911bot hola muro').muroText).toBe('hola muro');
    expect(parseCommand('@Vzla911bot /muro hola').muroText).toBe('hola');
  });
  it('does NOT treat the bare word "muro" as the write command', () => {
    const c = parseCommand('muro se cayó en Catia');
    expect(c.kind).not.toBe('muro'); // falls through to free-text search
  });
});

// ---- fake D1 ------------------------------------------------------------------
type Captured = { sql: string; args: any[] };
function fakeEnv(rows: any[], capture: Captured[]): Env {
  const DB = {
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          return {
            async all() {
              capture.push({ sql, args });
              return { results: rows };
            },
            async run() {
              capture.push({ sql, args });
              return { success: true };
            },
            async first() {
              return null;
            },
          };
        },
      };
    },
  };
  return { DB } as unknown as Env;
}

// ---- postToMuro ---------------------------------------------------------------
describe('postToMuro', () => {
  it('inserts into chat_messages on the wall channel, unflagged', async () => {
    const cap: Captured[] = [];
    const r = await postToMuro(fakeEnv([], cap), { name: 'Ricardo', text: 'Vi a Maria en Catia' });
    expect(r.kind).toBe('muro_ok');
    expect(cap).toHaveLength(1);
    expect(cap[0].sql).toContain('INSERT INTO chat_messages');
    expect(cap[0].args[1]).toBe(MURO_CHANNEL); // channel = 'terremotos'
    expect(cap[0].args[2]).toBe('Ricardo');
    expect(cap[0].args[3]).toBe('Vi a Maria en Catia');
    expect(cap[0].args[4]).toBe('citizen');
  });
  it('sanitizes HTML like the web wall does', async () => {
    const cap: Captured[] = [];
    const r = await postToMuro(fakeEnv([], cap), { name: 'X', text: '<script>alert(1)</script>hola' });
    expect(r.kind).toBe('muro_ok');
    expect(String(cap[0].args[3])).not.toContain('<script>');
  });
  it('rejects empty and over-long messages without touching the DB', async () => {
    const cap: Captured[] = [];
    expect((await postToMuro(fakeEnv([], cap), { name: 'X', text: '   ' })).kind).toBe('muro_empty');
    expect((await postToMuro(fakeEnv([], cap), { name: 'X', text: 'a'.repeat(MURO_MAX_LEN + 1) })).kind).toBe('muro_too_long');
    expect(cap).toHaveLength(0);
  });
});

describe('muroDisplayName', () => {
  it('prefers first_name, then username, then Anónimo', () => {
    expect(muroDisplayName({ first_name: 'Maria', username: 'mp' })).toBe('Maria');
    expect(muroDisplayName({ username: 'mp' })).toBe('mp');
    expect(muroDisplayName({})).toBe('Anónimo');
    expect(muroDisplayName(undefined)).toBe('Anónimo');
  });
});

// ---- reads ---------------------------------------------------------------------
const POST = { id: 'msg_1', name: 'Vecino', body: 'Vi a Maria Perez en Catia', created_ms: 1750000000000 };

describe('searchMuroMentions', () => {
  it('queries the wall channel with a LIKE on the name', async () => {
    const cap: Captured[] = [];
    const posts = await searchMuroMentions(fakeEnv([POST], cap), 'Maria Perez');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toContain('Maria Perez');
    expect(cap[0].sql).toContain('LIKE');
    expect(cap[0].args[0]).toBe(MURO_CHANNEL);
    expect(cap[0].args[1]).toBe('%Maria Perez%');
  });
  it('refuses too-short queries (no DB call)', async () => {
    const cap: Captured[] = [];
    expect(await searchMuroMentions(fakeEnv([POST], cap), 'ma')).toEqual([]);
    expect(cap).toHaveLength(0);
  });
});

describe('latestMuroPosts', () => {
  it('returns recent unflagged wall posts', async () => {
    const cap: Captured[] = [];
    const posts = await latestMuroPosts(fakeEnv([POST], cap));
    expect(posts).toHaveLength(1);
    expect(cap[0].sql).toContain('flagged = 0');
    expect(cap[0].args[0]).toBe(MURO_CHANNEL);
  });
});

// ---- replies ---------------------------------------------------------------------
const OPTS: BuildOpts = { lang: 'es', role: 'public', canSeeSensitive: false, baseUrl: 'https://sismo911.com' };
const MENTION = { id: 'msg_1', name: 'Vecino', body: 'Vi a Maria Perez en Catia', createdMs: 1750000000000 };

describe('muro replies', () => {
  it('post confirmation links the share page', () => {
    const t = buildMuroPostResponse({ kind: 'muro_ok', id: 'msg_1', name: 'Ricardo' }, OPTS);
    expect(t).toContain('https://sismo911.com/muro/p/msg_1');
    expect(t).toContain('Ricardo');
  });
  it('latest list renders posts with links; empty state invites posting', () => {
    const t = buildMuroLatestResponse([MENTION], OPTS);
    expect(t).toContain('Muro de Emergencia');
    expect(t).toContain('/muro/p/msg_1');
    expect(buildMuroLatestResponse([], OPTS)).toContain('/muro');
  });
  it('mentions section labels wall posts as unverified and is empty with no posts', () => {
    const s = buildMuroMentions('Maria Perez', [MENTION], OPTS);
    expect(s).toContain('SIN verificar');
    expect(s).toContain('/muro/p/msg_1');
    expect(buildMuroMentions('Maria Perez', [], OPTS)).toBe('');
  });
  it('help now documents /muro in both languages', () => {
    const es = buildTelegramResponse({ kind: 'help' }, OPTS);
    const en = buildTelegramResponse({ kind: 'help' }, { ...OPTS, lang: 'en' });
    expect(es).toContain('/muro');
    expect(en).toContain('/muro');
  });
});
