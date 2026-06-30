import { describe, it, expect } from 'vitest';
import { requestSubscription, confirmSubscription, unsubscribeByToken, normalizeEmail, caseUrlFor } from '../src/lib/case-subscribe';
import { evaluateGate } from '../src/rbac/route-policy';

// Stateful in-memory D1 covering exactly the statements the subscribe lib issues
// (+ the personas read caseStateSnapshot does for a fam- case). Lets us drive the
// real double-opt-in lifecycle end-to-end without a live D1.
function makeEnv(personas: Record<string, any>) {
  const subs: any[] = [];
  const alertState: any[] = [];
  const exec = (sql: string, args: any[], kind: 'first' | 'run' | 'all') => {
    if (/FROM personas WHERE id = \?/.test(sql)) return personas[args[0]] ?? null;
    if (/FROM persons WHERE id = \?/.test(sql)) return null;
    if (/FROM rav_reports/.test(sql)) return null;
    if (/FROM case_intel/.test(sql) && /COUNT/.test(sql)) return { n: 0, latest: '' };
    if (/FROM case_meta/.test(sql)) return null;
    if (/SELECT id, status FROM case_subscriptions WHERE case_id = \? AND email = \?/.test(sql))
      return subs.find((s) => s.case_id === args[0] && s.email === args[1]) ?? null;
    if (/INSERT INTO case_subscriptions/.test(sql)) {
      const [id, case_id, email, verify_hash, unsub_token, created_ms] = args;
      const ex = subs.find((s) => s.case_id === case_id && s.email === email);
      if (ex) Object.assign(ex, { status: 'pending', verify_hash, created_ms }); // ON CONFLICT keeps unsub_token stable
      else subs.push({ id, case_id, email, status: 'pending', verify_hash, unsub_token, created_ms, last_state_hash: null, verified_ms: null });
      return { success: true, meta: { changes: 1 } };
    }
    if (/SELECT id, case_id, email, unsub_token FROM case_subscriptions WHERE verify_hash = \?/.test(sql))
      return subs.find((s) => s.verify_hash === args[0]) ?? null;
    if (/UPDATE case_subscriptions SET status='active'/.test(sql)) {
      const [verified_ms, last_state_hash, id] = args;
      const s = subs.find((x) => x.id === id);
      if (s) Object.assign(s, { status: 'active', verified_ms, last_state_hash, verify_hash: null });
      return { meta: { changes: s ? 1 : 0 } };
    }
    if (/SELECT id, case_id FROM case_subscriptions WHERE unsub_token = \?/.test(sql))
      return subs.find((s) => s.unsub_token === args[0]) ?? null;
    if (/UPDATE case_subscriptions SET status='unsubscribed' WHERE id=\?/.test(sql)) {
      const s = subs.find((x) => x.id === args[0]); if (s) s.status = 'unsubscribed';
      return { meta: { changes: s ? 1 : 0 } };
    }
    if (/INSERT INTO case_alert_state/.test(sql)) {
      const [case_id, state_hash, state_json, updated_ms] = args;
      if (!alertState.find((a) => a.case_id === case_id)) alertState.push({ case_id, state_hash, state_json, updated_ms });
      return { meta: { changes: 1 } };
    }
    return kind === 'all' ? { results: [] } : null;
  };
  const prepare = (sql: string) => ({
    bind: (...args: any[]) => ({
      first: async () => exec(sql, args, 'first'),
      run: async () => exec(sql, args, 'run'),
      all: async () => exec(sql, args, 'all'),
    }),
  });
  return { env: { DB: { prepare } } as any, subs, alertState };
}

const PERSONAS = { p1: { nombre: 'Juana Pérez', estado: 'sin-contacto', ubicacion: 'La Guaira', descripcion: 'visto en el puerto', reportes: 1 } };
const ORIGIN = 'https://sismo911.com';

describe('normalizeEmail', () => {
  it('accepts a normal email (lowercased/trimmed)', () => expect(normalizeEmail('  ME@Example.COM ')).toBe('me@example.com'));
  it('rejects garbage', () => { expect(normalizeEmail('nope')).toBeNull(); expect(normalizeEmail('')).toBeNull(); expect(normalizeEmail('a@b')).toBeNull(); });
});

describe('subscribe lifecycle: request → confirm → unsubscribe', () => {
  it('rejects a bad email (400) and an unknown case (404)', async () => {
    const { env } = makeEnv(PERSONAS);
    expect((await requestSubscription(env, 'fam-p1', 'garbage', ORIGIN)).status).toBe(400);
    expect((await requestSubscription(env, 'fam-NOPE', 'a@b.com', ORIGIN)).status).toBe(404);
  });

  it('creates a PENDING subscription (never active before confirm)', async () => {
    const { env, subs } = makeEnv(PERSONAS);
    const r = await requestSubscription(env, 'fam-p1', 'watcher@example.com', ORIGIN);
    expect(r.ok).toBe(true);
    expect(r.verifyTok).toBeTruthy();
    expect(subs).toHaveLength(1);
    expect(subs[0].status).toBe('pending');
    expect(subs[0].verify_hash).toBeTruthy();
  });

  it('confirm activates + baselines the watermark + seeds case_alert_state', async () => {
    const { env, subs, alertState } = makeEnv(PERSONAS);
    const req = await requestSubscription(env, 'fam-p1', 'watcher@example.com', ORIGIN);
    const conf = await confirmSubscription(env, req.verifyTok!, ORIGIN);
    expect(conf.ok).toBe(true);
    expect(conf.caseName).toBe('Juana Pérez');
    expect(conf.caseUrl).toBe(caseUrlFor(ORIGIN, 'fam-p1'));
    expect(subs[0].status).toBe('active');
    expect(subs[0].verify_hash).toBeNull();
    expect(subs[0].last_state_hash).toBeTruthy();   // baselined → no alert for pre-existing state
    expect(alertState).toHaveLength(1);             // cron baseline seeded
  });

  it('a used/garbage verify token does not confirm', async () => {
    const { env } = makeEnv(PERSONAS);
    expect((await confirmSubscription(env, 'totally-bogus', ORIGIN)).ok).toBe(false);
  });

  it('one-click unsubscribe via the confirmed link flips status', async () => {
    const { env, subs } = makeEnv(PERSONAS);
    const req = await requestSubscription(env, 'fam-p1', 'watcher@example.com', ORIGIN);
    const conf = await confirmSubscription(env, req.verifyTok!, ORIGIN);
    const unsubTok = conf.unsubUrl!.split('/s/unsub/')[1];
    const u = await unsubscribeByToken(env, unsubTok);
    expect(u.ok).toBe(true);
    expect(u.caseName).toBe('Juana Pérez');
    expect(subs[0].status).toBe('unsubscribed');
  });

  it('re-subscribe after confirm is idempotent (already active → no duplicate)', async () => {
    const { env, subs } = makeEnv(PERSONAS);
    const req = await requestSubscription(env, 'fam-p1', 'watcher@example.com', ORIGIN);
    await confirmSubscription(env, req.verifyTok!, ORIGIN);
    const again = await requestSubscription(env, 'fam-p1', 'watcher@example.com', ORIGIN);
    expect(again.already).toBe(true);
    expect(subs).toHaveLength(1);
  });
});

describe('route classification', () => {
  it('POST /api/persons/:id/subscribe is PUBLIC (open), not gated', () => {
    expect(evaluateGate('/api/persons/fam-p1/subscribe', 'POST').kind).toBe('open');
  });
  it('/s confirm + unsub pages are open (non-/api)', () => {
    expect(evaluateGate('/s/verify/abc', 'GET').kind).toBe('open');
    expect(evaluateGate('/s/unsub/abc', 'GET').kind).toBe('open');
  });
});
