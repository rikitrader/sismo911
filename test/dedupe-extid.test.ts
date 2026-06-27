import { describe, it, expect } from 'vitest';
import { dedupePersonas, dedupeRavReports } from '../src/lib/dedupe';

// Fake D1 that (a) returns a seeded duplicate set for the dedupe SELECT and
// (b) reports rows-changed for the DELETE issued by deleteByIds(). The window-
// function grouping itself is exercised against real local D1 in the Phase-5
// verification; this locks in the function CONTRACT: extid scope, dry-run vs
// apply, and convergent delete wiring.
function fakeD1(seedRows: Array<Record<string, unknown>>) {
  const seen: { sql: string; binds: unknown[] }[] = [];
  return {
    seen,
    prepare(sql: string) {
      const stmt: any = {
        _binds: [] as unknown[],
        bind(...b: unknown[]) {
          this._binds = b;
          return this;
        },
        async all() {
          seen.push({ sql, binds: this._binds });
          return { results: sql.trimStart().toUpperCase().startsWith('SELECT') ? seedRows : [] };
        },
        async run() {
          seen.push({ sql, binds: this._binds });
          // DELETE … WHERE id IN (?,?) → report one change per bound id.
          const changes = /^\s*DELETE/i.test(sql) ? this._binds.length : 0;
          return { meta: { changes } };
        },
        async first() {
          return null;
        },
      };
      return stmt;
    },
  };
}

const env = (db: any) => ({ DB: db, DESAP_FOTOS: { async delete() {} } }) as any;

describe('dedupePersonas extid mode', () => {
  it('dry-run counts duplicates, deletes nothing', async () => {
    const db = fakeD1([{ id: 'p1', foto_r2: null }, { id: 'p2', foto_r2: null }]);
    const r = await dedupePersonas(env(db), { mode: 'extid', apply: false });
    expect(r.mode).toBe('extid');
    expect(r.found).toBe(2);
    expect(r.applied).toBe(false);
    expect(r.deletedRows).toBe(0);
    // partition + scope must be the (origen, ext_id) ones
    expect(db.seen[0].sql).toMatch(/PARTITION BY origen, ext_id/);
    expect(db.seen[0].sql).toMatch(/ext_id.*!= ''/s);
    expect(db.seen.some((q) => /^\s*DELETE/i.test(q.sql))).toBe(false);
  });

  it('apply deletes the extra rows', async () => {
    const db = fakeD1([{ id: 'p1', foto_r2: null }, { id: 'p2', foto_r2: null }]);
    const r = await dedupePersonas(env(db), { mode: 'extid', apply: true });
    expect(r.applied).toBe(true);
    expect(r.deletedRows).toBe(2);
    expect(db.seen.some((q) => /^\s*DELETE FROM personas/i.test(q.sql))).toBe(true);
  });
});

describe('dedupeRavReports', () => {
  it('dry-run counts, no delete', async () => {
    const db = fakeD1([{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }]);
    const r = await dedupeRavReports(env(db), { apply: false });
    expect(r.found).toBe(3);
    expect(r.applied).toBe(false);
    expect(db.seen[0].sql).toMatch(/PARTITION BY origen, ext_id/);
  });
  it('apply deletes from rav_reports', async () => {
    const db = fakeD1([{ id: 'r1' }, { id: 'r2' }]);
    const r = await dedupeRavReports(env(db), { apply: true });
    expect(r.deletedRows).toBe(2);
    expect(db.seen.some((q) => /^\s*DELETE FROM rav_reports/i.test(q.sql))).toBe(true);
  });
});
