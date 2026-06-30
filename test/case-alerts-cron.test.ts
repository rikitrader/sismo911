import { describe, it, expect } from 'vitest';
import { runCaseAlerts, summarizeChange, templateSummary } from '../src/ingest/case-alerts';
import { buildSnapshot, hashCaseState } from '../src/lib/case-alert';

// Stateful fake covering the cron's statements + caseStateSnapshot reads, with an
// EMAIL capture stub so we can assert exactly who got alerted.
function makeEnv(personas: Record<string, any>, subs: any[], alertState: any[], withAI = false) {
  const sent: any[] = [];
  const exec = (sql: string, args: any[], kind: 'first' | 'run' | 'all') => {
    if (/FROM case_subscriptions WHERE status='active'\s+GROUP BY case_id/.test(sql)) {
      const active = subs.filter((s) => s.status === 'active');
      const byCase: Record<string, number> = {};
      for (const s of active) byCase[s.case_id] = (byCase[s.case_id] || 0) + 1;
      return { results: Object.entries(byCase).map(([case_id, n]) => ({ case_id, subs: n })) };
    }
    if (/FROM personas WHERE id = \?/.test(sql)) return personas[args[0]] ?? null;
    if (/FROM persons WHERE id = \?/.test(sql)) return null;
    if (/FROM rav_reports/.test(sql)) return null;
    if (/FROM case_intel/.test(sql) && /COUNT/.test(sql)) return { n: 0, latest: '' };
    if (/FROM case_meta/.test(sql)) return null;
    if (/FROM case_alert_state WHERE case_id = \?/.test(sql)) return alertState.find((a) => a.case_id === args[0]) ?? null;
    if (/INSERT INTO case_alert_state/.test(sql)) {
      const [case_id, state_hash, state_json, updated_ms] = args;
      const ex = alertState.find((a) => a.case_id === case_id);
      if (ex) Object.assign(ex, { state_hash, state_json, updated_ms });
      else alertState.push({ case_id, state_hash, state_json, updated_ms });
      return { meta: { changes: 1 } };
    }
    if (/SELECT id, email, unsub_token, last_state_hash FROM case_subscriptions WHERE case_id = \? AND status='active'/.test(sql))
      return { results: subs.filter((s) => s.case_id === args[0] && s.status === 'active') };
    if (/UPDATE case_subscriptions SET last_state_hash=\?, last_alert_ms=\? WHERE id=\?/.test(sql)) {
      const s = subs.find((x) => x.id === args[2]); if (s) { s.last_state_hash = args[0]; s.last_alert_ms = args[1]; }
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
  const env: any = { DB: { prepare }, EMAIL: { send: async (m: any) => { sent.push(m); } } };
  if (withAI) env.AI = { run: async () => ({ response: 'Resumen IA del cambio.' }) };
  return { env, sent };
}

const PERSONAS = { p1: { nombre: 'Juana Pérez', estado: 'aparecido', ubicacion: 'La Guaira', descripcion: 'd', reportes: 2 } };
const sub = (over: any = {}) => ({ id: 'sub_1', case_id: 'fam-p1', email: 'w@example.com', status: 'active', unsub_token: 'UT1', last_state_hash: null, ...over });

// Build the JSON a prior tick would have stored, with a DIFFERENT estado so the
// diff yields a status change.
async function priorState(estado: string) {
  const snap = buildSnapshot({ caseId: 'fam-p1', name: 'Juana Pérez', status: estado, location: 'La Guaira', notes: 'd', reportCount: 2 });
  return { case_id: 'fam-p1', state_hash: await hashCaseState(snap), state_json: JSON.stringify(snap), updated_ms: 1 };
}

describe('templateSummary', () => {
  it('formats a status change explicitly', () => {
    const s = templateSummary({} as any, [{ field: 'status', label: 'Estado', from: 'Sin contacto', to: 'Apareció / a salvo' }]);
    expect(s).toContain('cambió de «Sin contacto» a «Apareció / a salvo»');
  });
});

describe('summarizeChange falls back to template without AI', () => {
  it('returns the deterministic sentence when env.AI is absent', async () => {
    const { env } = makeEnv(PERSONAS, [], [], false);
    const s = await summarizeChange(env, { name: 'X', statusLabel: 'Y' } as any, [{ field: 'status', label: 'Estado', from: 'a', to: 'b' }]);
    expect(s).toContain('cambió de «a» a «b»');
  });
});

describe('runCaseAlerts', () => {
  it('first observation seeds the baseline and sends NO email', async () => {
    const subs = [sub()]; const alertState: any[] = [];
    const { env, sent } = makeEnv(PERSONAS, subs, alertState);
    const r = await runCaseAlerts(env, { origin: 'https://sismo911.com' });
    expect(r.casesScanned).toBe(1);
    expect(r.casesChanged).toBe(0);
    expect(sent).toHaveLength(0);
    expect(alertState).toHaveLength(1); // baseline now exists
  });

  it('a changed case emails each active subscriber + advances watermark', async () => {
    const subs = [sub()];
    const alertState = [await priorState('sin-contacto')]; // prior estado differs from current 'aparecido'
    const { env, sent } = makeEnv(PERSONAS, subs, alertState);
    const r = await runCaseAlerts(env, { origin: 'https://sismo911.com' });
    expect(r.casesChanged).toBe(1);
    expect(r.emailsSent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('w@example.com');
    expect(sent[0].subject).toContain('Apareció / a salvo');
    expect(sent[0].html).toContain('https://sismo911.com/s/unsub/UT1');
    expect(subs[0].last_state_hash).toBeTruthy(); // watermark advanced
  });

  it('an unchanged case sends nothing', async () => {
    const subs = [sub()];
    const alertState = [await priorState('aparecido')]; // same as current
    const { env, sent } = makeEnv(PERSONAS, subs, alertState);
    const r = await runCaseAlerts(env);
    expect(r.casesChanged).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('does not re-alert a subscriber already at the current state (watermark dedup)', async () => {
    const cur = buildSnapshot({ caseId: 'fam-p1', name: 'Juana Pérez', status: 'aparecido', location: 'La Guaira', notes: 'd', reportCount: 2 });
    const curHash = await hashCaseState(cur);
    const subs = [sub({ last_state_hash: curHash })]; // already alerted at this state
    const alertState = [await priorState('sin-contacto')];
    const { env, sent } = makeEnv(PERSONAS, subs, alertState);
    const r = await runCaseAlerts(env);
    expect(r.casesChanged).toBe(1); // case changed...
    expect(sent).toHaveLength(0);    // ...but this sub was already notified
  });

  it('uses the AI summary when env.AI is present', async () => {
    const subs = [sub()];
    const alertState = [await priorState('sin-contacto')];
    const { env, sent } = makeEnv(PERSONAS, subs, alertState, true);
    await runCaseAlerts(env);
    expect(sent[0].html).toContain('Resumen IA del cambio.');
  });
});
