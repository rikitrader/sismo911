import { describe, it, expect } from 'vitest';
import { makeDb, makeEnv } from './helpers/d1';
import { createSession, isPrivilegedRole, IDLE_TTL_MS } from '../src/lib/auth';

// Session idle timeout: privileged sessions get the short sliding window, while
// citizens keep the long absolute TTL.
describe('session idle timeout', () => {
  it('isPrivilegedRole flags operator/admin only', () => {
    expect(isPrivilegedRole('operator')).toBe(true);
    expect(isPrivilegedRole('admin')).toBe(true);
    expect(isPrivilegedRole('citizen')).toBe(false);
    expect(isPrivilegedRole(null)).toBe(false);
  });

  it('privileged session is created with the ~30-min idle window', async () => {
    const env = makeEnv(makeDb(['migrations/0004_auth.sql']));
    const before = Date.now();
    const s = await createSession(env as any, 'u_op', 'ua', IDLE_TTL_MS);
    expect(s.expires).toBeGreaterThanOrEqual(before + IDLE_TTL_MS - 2000);
    expect(s.expires).toBeLessThanOrEqual(Date.now() + IDLE_TTL_MS + 2000);
    // and far short of the 30-day absolute TTL
    expect(s.expires).toBeLessThan(Date.now() + 24 * 3600_000);
  });

  it('citizen session (default TTL) is long-lived', async () => {
    const env = makeEnv(makeDb(['migrations/0004_auth.sql']));
    const s = await createSession(env as any, 'u_cit', 'ua'); // default = 30 days
    expect(s.expires).toBeGreaterThan(Date.now() + 20 * 24 * 3600_000);
  });
});
