import { describe, it, expect } from 'vitest';
import { recomputeCaseScore, sweepCaseScores } from '../src/lib/case-score-sync';

const NOW = 1_750_000_000_000;
const h = (n: number) => n * 3_600_000;

// Minimal in-memory D1+KV stub routed by SQL substring. Covers exactly the
// queries recomputeCaseScore() issues: quake ref, docket stats, the case row,
// and the priority read/write for persons + case_meta.
function makeEnv(seed: {
  persons?: Record<string, any>;
  personas?: Record<string, any>;
  caseMeta?: Record<string, any>;
  docket?: { person_id: string; created_ms: number }[];
  event?: { mag: number | null; alert: string | null };
}) {
  const persons = seed.persons ?? {};
  const personas = seed.personas ?? {};
  const caseMeta = seed.caseMeta ?? {};
  const docket = seed.docket ?? [];
  const event = seed.event ?? { mag: 7.5, alert: 'red' };

  const first = (sql: string, b: any[]) => {
    if (/FROM events/.test(sql)) return event;
    if (/FROM person_events WHERE person_id = \?/.test(sql)) {
      const es = docket.filter((e) => e.person_id === b[0]);
      return { c: es.length, last: es.length ? Math.max(...es.map((e) => e.created_ms)) : null };
    }
    if (/SELECT priority FROM persons WHERE id/.test(sql)) return persons[b[0]] ? { priority: persons[b[0]].priority } : null;
    if (/SELECT priority FROM case_meta WHERE person_id/.test(sql)) return caseMeta[b[0]] ? { priority: caseMeta[b[0]].priority } : null;
    if (/age, status, incident_type, created_ms FROM persons/.test(sql)) return persons[b[0]] ?? null;
    if (/edad, estado, created_at FROM personas/.test(sql)) return personas[b[0]] ?? null;
    if (/incident_type FROM case_meta/.test(sql)) return caseMeta[b[0]] ?? null;
    return null;
  };
  const run = (sql: string, b: any[]) => {
    if (/UPDATE persons SET priority/.test(sql)) { if (persons[b[1]]) persons[b[1]].priority = b[0]; return { meta: { changes: 1 } }; }
    if (/INSERT INTO case_meta/.test(sql)) { caseMeta[b[0]] = { ...(caseMeta[b[0]] ?? {}), priority: b[1] }; return { meta: { changes: 1 } }; }
    return { meta: { changes: 0 } };
  };
  const prepare = (sql: string) => ({
    bind: (...b: any[]) => ({ first: async () => first(sql, b), run: async () => run(sql, b), all: async () => ({ results: [] }) }),
    first: async () => first(sql, []), run: async () => run(sql, []), all: async () => ({ results: [] }),
  });
  return { DB: { prepare }, CACHE: { get: async () => null, put: async () => {} }, _store: { persons, caseMeta } } as any;
}

describe('case-score-sync: recomputeCaseScore persists derived priority', () => {
  it('native missing child + red PAGER + fresh → persists alta', async () => {
    const env = makeEnv({ persons: { p1: { age: 6, status: 'missing', incident_type: null, created_ms: NOW - h(8), priority: 'media' } } });
    const sc = await recomputeCaseScore(env, 'p1', NOW);
    expect(sc?.priority).toBe('alta');
    expect(env._store.persons.p1.priority).toBe('alta');   // written back
  });

  it('native found_safe → persists baja (auto-resolve)', async () => {
    const env = makeEnv({ persons: { p2: { age: 30, status: 'found_safe', incident_type: null, created_ms: NOW - h(8), priority: 'alta' } } });
    const sc = await recomputeCaseScore(env, 'p2', NOW);
    expect(sc?.priority).toBe('baja');
    expect(env._store.persons.p2.priority).toBe('baja');
  });

  it('familia case found → upserts case_meta priority baja', async () => {
    const env = makeEnv({ personas: { abc: { edad: 50, estado: 'localizado', created_at: NOW - h(40) } } });
    const sc = await recomputeCaseScore(env, 'fam-abc', NOW);
    expect(sc?.priority).toBe('baja');
    expect(env._store.caseMeta['fam-abc'].priority).toBe('baja');
  });

  it('unchanged priority is a no-op write (idempotent)', async () => {
    // already baja + found → stays baja, no throw.
    const env = makeEnv({ persons: { p3: { age: 30, status: 'found_safe', incident_type: null, created_ms: NOW, priority: 'baja' } } });
    const sc = await recomputeCaseScore(env, 'p3', NOW);
    expect(sc?.priority).toBe('baja');
  });

  it('returns null for a missing case id', async () => {
    const env = makeEnv({});
    expect(await recomputeCaseScore(env, 'nope', NOW)).toBeNull();
  });
});

// Batched-sweep stub: routes the grouped reads + collects db.batch() writes.
function makeSweepEnv(seed: { persons?: any[]; personas?: any[]; caseMeta?: Record<string, any> }) {
  const persons = seed.persons ?? [];
  const personas = seed.personas ?? [];
  const caseMeta = seed.caseMeta ?? {};
  const kv: Record<string, string> = {};
  const all = (sql: string, b: any[]) => {
    if (/FROM persons WHERE status IN/.test(sql)) return { results: persons };
    if (/FROM person_events/.test(sql)) return { results: [] };           // no docket activity
    if (/FROM personas/.test(sql)) {
      const cursor = b[0] ?? '';
      return { results: personas.filter((r) => String(r.id) > String(cursor)) };
    }
    if (/priority, incident_type FROM case_meta/.test(sql)) {
      return { results: Object.entries(caseMeta).map(([person_id, v]: any) => ({ person_id, ...v })) };
    }
    return { results: [] };
  };
  const stmt = (sql: string, b: any[] = []) => ({ _sql: sql, _b: b, all: async () => all(sql, b), first: async () => null, run: async () => ({ meta: { changes: 1 } }) });
  const prepare = (sql: string) => ({ bind: (...b: any[]) => stmt(sql, b), all: async () => all(sql, []), first: async () => null, run: async () => ({ meta: { changes: 1 } }) });
  const env: any = {
    DB: {
      prepare,
      batch: async (stmts: any[]) => {                                    // apply collected writes
        for (const s of stmts) {
          if (/UPDATE persons SET priority/.test(s._sql)) { const r = persons.find((p) => p.id === s._b[1]); if (r) r.priority = s._b[0]; }
          if (/INSERT INTO case_meta/.test(s._sql)) caseMeta[s._b[0]] = { priority: s._b[1] };
        }
        return [];
      },
    },
    CACHE: { get: async (k: string) => kv[k] ?? null, put: async (k: string, v: string) => { kv[k] = v; } },
    _store: { persons, caseMeta },
  };
  return env;
}

describe('case-score-sync: sweepCaseScores (batched, autonomous)', () => {
  it('persists derived priority for native + familia in one pass', async () => {
    const env = makeSweepEnv({
      persons: [{ id: 'p1', age: 6, status: 'missing', incident_type: null, created_ms: NOW - h(8), priority: 'media' }],
      personas: [{ id: 'a1', edad: 40, estado: 'sin-contacto', created_at: NOW - h(8) }],
      caseMeta: {},
    });
    const r = await sweepCaseScores(env, { famLimit: 100, now: NOW });
    expect(r.native).toBe(1);
    expect(r.familia).toBe(1);
    expect(r.changed).toBeGreaterThanOrEqual(1);
    expect(env._store.persons[0].priority).toBe('alta');         // child + red quake + fresh
    expect(env._store.caseMeta['fam-a1'].priority).toBeDefined(); // familia upserted
  });

  it('wraps the familia cursor when the batch is exhausted', async () => {
    const env = makeSweepEnv({ personas: [{ id: 'a1', edad: 40, estado: 'sin-contacto', created_at: NOW }] });
    await sweepCaseScores(env, { famLimit: 100, now: NOW }); // 1 row < limit → cursor resets to ''
    const r2 = await sweepCaseScores(env, { famLimit: 100, now: NOW });
    expect(r2.familia).toBe(1); // cursor wrapped, re-reads from start
  });
});
