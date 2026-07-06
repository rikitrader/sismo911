// Hourly scored-dedupe job — idempotency + bounding, against a fake D1.
import { describe, it, expect } from 'vitest';
import { runHourlyDedupe } from '../src/db/dedupe-cron';
import type { Env } from '../src/types';

interface FakeState {
  personas: Array<Record<string, unknown>>;
  candidateKeys: Set<string>; // UNIQUE(table,id_a,id_b)
  merges: Array<{ keeper: string; loser: string }>;
  runs: number;
  watermark: number;
}

/** Minimal D1 fake covering exactly the SQL shapes dedupe-cron issues. */
function fakeEnv(state: FakeState): Env {
  function stmt(sql: string) {
    let bound: unknown[] = [];
    const api = {
      bind(...args: unknown[]) {
        bound = args;
        return api;
      },
      async first() {
        if (sql.includes('MAX(watermark_ms)')) return { wm: state.watermark };
        return null;
      },
      async all() {
        if (sql.includes('GROUP BY name_norm')) {
          const wm = Number(bound[0] ?? 0);
          const keys = [...new Set(state.personas.filter((p) => Number(p.updated_at) > wm).map((p) => String(p.name_norm)))];
          return { results: keys.map((k) => ({ k })) };
        }
        if (sql.includes('name_norm IN')) {
          const set = new Set(bound.map(String));
          return { results: state.personas.filter((p) => set.has(String(p.name_norm))) };
        }
        return { results: [] };
      },
      async run() {
        return { meta: { changes: 1 } };
      },
      _sql: sql,
      _bound: () => bound,
    };
    return api;
  }
  return {
    DB: {
      prepare: (sql: string) => stmt(sql),
      batch: async (stmts: Array<ReturnType<typeof stmt>>) => {
        return stmts.map((s) => {
          const sql = (s as { _sql: string })._sql;
          const bound = (s as { _bound: () => unknown[] })._bound();
          if (sql.includes('INSERT OR IGNORE INTO dedupe_candidates')) {
            const key = `${bound[2]}:${bound[3]}:${bound[4]}`;
            if (state.candidateKeys.has(key)) return { meta: { changes: 0 } };
            state.candidateKeys.add(key);
            return { meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE personas SET merged_into")) {
            state.merges.push({ keeper: String(bound[0]), loser: String(bound[2]) });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('INSERT INTO dedupe_runs')) state.runs++;
          return { meta: { changes: 1 } };
        });
      },
    },
  } as unknown as Env;
}

function persona(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, nombre: 'Jose Perez Marcano', name_norm: 'jose perez marcano', edad: 50,
    contacto: '04141112233', ubicacion: 'Catia La Mar', origen: 'telegram:dm', ext_id: null,
    estado: 'sin-contacto', fallecido: 0, hospitalizado: 0, geo_estado: null, geo_municipio: null,
    updated_at: 1000, ...over,
  };
}

describe('runHourlyDedupe', () => {
  it('auto-merges a corroborated pair and records the run', async () => {
    const state: FakeState = { personas: [persona('p1'), persona('p2', { contacto: '+58 414 111 2233' })], candidateKeys: new Set(), merges: [], runs: 0, watermark: 0 };
    const s = await runHourlyDedupe(fakeEnv(state));
    expect(s.candidates).toBe(1);
    expect(s.autoMerged).toBe(1);
    expect(state.merges.length).toBe(1);
    expect(state.runs).toBe(1);
  });

  it('is idempotent: the same pair is NEVER merged twice (UNIQUE-pair guard)', async () => {
    const state: FakeState = { personas: [persona('p1'), persona('p2', { contacto: '+58 414 111 2233' })], candidateKeys: new Set(), merges: [], runs: 0, watermark: 0 };
    await runHourlyDedupe(fakeEnv(state));
    const second = await runHourlyDedupe(fakeEnv(state)); // watermark still 0 → same rows rescanned
    expect(second.autoMerged).toBe(0);
    expect(state.merges.length).toBe(1); // still exactly one merge
  });

  it('skips cleanly when nothing changed since the watermark', async () => {
    const state: FakeState = { personas: [persona('p1')], candidateKeys: new Set(), merges: [], runs: 0, watermark: 5000 };
    const s = await runHourlyDedupe(fakeEnv(state));
    expect(s.skipped).toBe(true);
    expect(s.scanned).toBe(0);
  });

  it('queues namesake-only pairs for review instead of merging', async () => {
    const state: FakeState = {
      personas: [persona('p1', { contacto: null, edad: null, ubicacion: null }), persona('p2', { contacto: null, edad: null, ubicacion: null })],
      candidateKeys: new Set(), merges: [], runs: 0, watermark: 0,
    };
    const s = await runHourlyDedupe(fakeEnv(state));
    expect(s.autoMerged).toBe(0);
    expect(state.merges.length).toBe(0);
  });
});
