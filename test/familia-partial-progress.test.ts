import { describe, it, expect, afterEach, vi } from 'vitest';
import { ingestFamilia } from '../src/ingest/familia-cron';

// Partial progress under a rate-limited resolver (2026-07-02): the reCAPTCHA-v3
// upstream rejects token bursts, so a 25-page run can die mid-loop. Pages that
// already landed must be INGESTED and the cursor advanced past them — an hourly
// tick that fetched 4 good pages and then hit the limit is progress, not a
// failure. Only a first-page failure still fails the whole run.

const PAGE_ROWS = (page: number) => Array.from({ length: 3 }, (_, i) => ({
  id: `p${page}_${i}`, nombre: `Persona Página${page} N${i}`, edad: 30,
  ubicacion: 'La Guaira', estado: 'sin-contacto',
}));

function fakeEnv(failFromPage: number, extra: Record<string, unknown> = {}) {
  const batched: any[] = [];
  const kv: Record<string, string> = { 'familia:cursor': '1' };
  const stmt = () => {
    const s: any = {
      bind: (...b: unknown[]) => { s._binds = b; return s; },
      run: async () => ({ meta: { changes: 0 } }),
      first: async () => null,
      all: async () => ({ results: [] }),
    };
    return s;
  };
  const env: any = {
    FAMILIA_SOURCE_URL: 'https://upstream.example/api/personas',
    ...extra,
    CACHE: {
      get: async (k: string) => kv[k] ?? null,
      put: async (k: string, v: string) => { kv[k] = v; },
    },
    DB: {
      prepare: () => stmt(),
      batch: async (stmts: any[]) => { batched.push(...stmts); return stmts.map(() => ({})); },
    },
  };
  const fetchMock = vi.fn(async (url: string) => {
    const page = Number(new URL(String(url)).searchParams.get('page'));
    if (page >= failFromPage) return new Response('{"error":"rate_limited"}', { status: 403 });
    return Response.json({ items: PAGE_ROWS(page), totalPages: 500 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { env, batched, kv, fetchMock };
}

afterEach(() => vi.unstubAllGlobals());

describe('ingestFamilia partial progress', () => {
  it('mid-run failure keeps the pages already fetched and advances the cursor to the last good page', async () => {
    const { env, batched, kv } = fakeEnv(5);      // pages 1-4 succeed, 5 fails
    const written = await ingestFamilia(env);
    expect(written).toBe(12);                      // 4 pages × 3 rows ingested
    expect(kv['familia:cursor']).toBe('5');        // resumes exactly where it stopped
    expect(batched.length).toBe(12);
  });

  it('first-page failure still fails the run (no progress to keep)', async () => {
    const { env, batched, kv } = fakeEnv(1);       // page 1 fails immediately
    const written = await ingestFamilia(env);
    expect(written).toBe(0);
    expect(batched.length).toBe(0);
    expect(kv['familia:cursor']).toBe('1');        // untouched
  });

  it('clean full window keeps the old behavior (cursor = lastPage + 1)', async () => {
    const { env, kv } = fakeEnv(99);               // no failure within the window
    const written = await ingestFamilia(env);
    expect(written).toBe(75);                      // 25 pages × 3 rows (direct path)
    expect(kv['familia:cursor']).toBe('26');
  });

  it('resolver path uses the gentle 4-page burst (stays under the reCAPTCHA-v3 threshold)', async () => {
    const { env, kv } = fakeEnv(99, {              // no failure; resolver configured
      FAMILIA_RESOLVER_URL: 'https://tunnel.example/familia',
      FAMILIA_RESOLVER_TOKEN: 'tok',
    });
    const written = await ingestFamilia(env);
    expect(written).toBe(12);                      // 4 pages × 3 rows, NOT 25
    expect(kv['familia:cursor']).toBe('5');
  });

  it('resolver page cap is env-overridable', async () => {
    const { env, kv } = fakeEnv(99, {
      FAMILIA_RESOLVER_URL: 'https://tunnel.example/familia',
      FAMILIA_RESOLVER_TOKEN: 'tok',
      FAMILIA_RESOLVER_MAX_PAGES: '2',
    });
    const written = await ingestFamilia(env);
    expect(written).toBe(6);                        // 2 pages × 3 rows
    expect(kv['familia:cursor']).toBe('3');
  });
});
