import { describe, it, expect, vi, afterEach } from 'vitest';
import { catchupFunvisis, ingestFunvisis } from '../src/ingest/funvisis-cron';

// FUNVISIS intermittently 403s Cloudflare egress IPs. These tests lock in the
// resilience contract: (1) catch-up seats self-skip in ONE D1 read while the
// data is fresh, (2) a transient failure with fresh data soft-fails (no throw →
// no SYS-02 alert email), (3) a sustained outage (stale data) still throws so
// the alert fires.

// Minimal fake D1: `first()` returns the given ingest_log row; every write
// (`run`) is accepted and counted.
function fakeEnv(row: { last_ok_ms: number | null } | null) {
  const calls = { first: 0, run: 0 };
  const stmt: any = {
    bind: () => stmt,
    first: async () => { calls.first++; return row; },
    run: async () => { calls.run++; return {}; },
    all: async () => ({ results: [] }),
  };
  return { env: { DB: { prepare: () => stmt, batch: async () => [] }, CACHE: { put: async () => {} } } as any, calls };
}

afterEach(() => vi.restoreAllMocks());

describe('catchupFunvisis', () => {
  it('skips with a single D1 read when the last success is fresh (<55min)', async () => {
    const { env, calls } = fakeEnv({ last_ok_ms: Date.now() - 10 * 60 * 1000 });
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as any);
    const r: any = await catchupFunvisis(env);
    expect(r.skipped).toBe('fresh');
    expect(calls.first).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('re-attempts the ingest when the last success is stale (>55min)', async () => {
    const { env } = fakeEnv({ last_ok_ms: Date.now() - 2 * 60 * 60 * 1000 });
    // Feed fetch succeeds with an empty feature set → full ingest path runs.
    vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue(
      new Response(JSON.stringify({ features: [] }), { status: 200 }) as any,
    );
    const r: any = await catchupFunvisis(env);
    expect(r.count).toBe(0);           // ingest ran (not skipped)
    expect(globalThis.fetch).toHaveBeenCalled();
  });
});

describe('ingestFunvisis transient-failure grace', () => {
  it('soft-fails (no throw) on fetch failure while data is fresh (<3h)', async () => {
    const { env } = fakeEnv({ last_ok_ms: Date.now() - 30 * 60 * 1000 });
    vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue(new Response('forbidden', { status: 403 }) as any);
    const r: any = await ingestFunvisis(env);
    expect(r.softFail).toContain('403');
    expect(r.lastOkAgeMin).toBeGreaterThanOrEqual(29);
  }, 15000);

  it('still throws (→ alert email) when the outage is sustained (>3h stale)', async () => {
    const { env } = fakeEnv({ last_ok_ms: Date.now() - 4 * 60 * 60 * 1000 });
    vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue(new Response('forbidden', { status: 403 }) as any);
    await expect(ingestFunvisis(env)).rejects.toThrow('FUNVISIS 403');
  }, 15000);

  it('retries the fetch up to 3 times inside one invocation', async () => {
    const { env } = fakeEnv({ last_ok_ms: Date.now() - 30 * 60 * 1000 });
    const spy = vi.spyOn(globalThis, 'fetch' as any)
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }) as any)
      .mockResolvedValueOnce(new Response(JSON.stringify({ features: [] }), { status: 200 }) as any);
    const r: any = await ingestFunvisis(env);
    expect(r.count).toBe(0);           // succeeded on the retry
    expect(spy).toHaveBeenCalledTimes(2);
  }, 15000);
});
