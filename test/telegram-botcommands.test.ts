// Tests for the BotFather command-menu registration.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PUBLIC_COMMANDS, OPERATOR_COMMANDS, COMMANDS_VERSION, syncBotCommands } from '../src/telegram/botcommands';
import type { Env } from '../src/types';
import type { TelegramConfig } from '../src/telegram/env';

const NAME_RE = /^[a-z0-9_]{1,32}$/;

describe('command list validity', () => {
  it('every command name and description is Telegram-valid', () => {
    for (const c of OPERATOR_COMMANDS) {
      expect(c.command, c.command).toMatch(NAME_RE);
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.description.length).toBeLessThanOrEqual(256);
    }
  });
  it('public menu excludes operator commands; operator menu includes them', () => {
    const pub = PUBLIC_COMMANDS.map((c) => c.command);
    const ops = OPERATOR_COMMANDS.map((c) => c.command);
    expect(pub).not.toContain('actualizar');
    expect(pub).not.toContain('menu');
    expect(ops).toContain('actualizar');
    expect(ops).toContain('menu');
    expect(pub).toContain('buscar');
  });
});

const cfg: TelegramConfig = {
  botToken: 'bottoken1234567890abcdef',
  webhookSecret: 'supersecretwebhook',
  allowedGroupIds: ['-100'],
  adminUserIds: ['111', '222'],
  allowedUserIds: [],
};

function kvEnv(initial: string | null): { env: Env; store: { v: string | null } } {
  const store = { v: initial };
  const CACHE = {
    async get() {
      return store.v;
    },
    async put(_k: string, val: string) {
      store.v = val;
    },
  };
  return { env: { CACHE } as unknown as Env, store };
}

afterEach(() => vi.unstubAllGlobals());

describe('syncBotCommands', () => {
  it('no-ops when already at the current version', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { env } = kvEnv(String(COMMANDS_VERSION));
    const r = await syncBotCommands(env, cfg);
    expect(r.ran).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('registers (default + per-admin) when unregistered, then records the version', async () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }) as any);
    vi.stubGlobal('fetch', fetchMock);
    const { env, store } = kvEnv(null);
    const r = await syncBotCommands(env, cfg);
    expect(r.ran).toBe(true);
    expect(r.ok).toBe(true);
    // 1 default + 2 admins setMyCommands + 2 description calls = 5.
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const urls = fetchMock.mock.calls.map((c: any[]) => String(c[0]));
    expect(urls.filter((u) => u.includes('setMyCommands')).length).toBe(3);
    expect(store.v).toBe(String(COMMANDS_VERSION));
  });

  it('force re-registers even when already current', async () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }) as any);
    vi.stubGlobal('fetch', fetchMock);
    const { env } = kvEnv(String(COMMANDS_VERSION));
    const r = await syncBotCommands(env, cfg, { force: true });
    expect(r.ran).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
  });
});
