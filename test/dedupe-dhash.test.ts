import { describe, it, expect } from 'vitest';
import { dedupePersonas } from '../src/lib/dedupe';

// dhash-mode SQL contract. The window grouping runs against real D1 (verified
// live 2026-07-02: the large-cluster branch selects exactly the two null-age
// twins "Adela Taberneiro" / "Belkis Carolina Mendoza" and nothing else); this
// locks in the SHAPE of the query — both branches, their guards, and the
// dry-run/apply wiring — so a refactor can't silently drop a safety clause.
function fakeD1(seedRows: Array<Record<string, unknown>>) {
  const seen: { sql: string; binds: unknown[] }[] = [];
  return {
    seen,
    prepare(sql: string) {
      const stmt: any = {
        _binds: [] as unknown[],
        bind(...b: unknown[]) { this._binds = b; return this; },
        async all() {
          seen.push({ sql, binds: this._binds });
          return { results: sql.trimStart().toUpperCase().startsWith('SELECT') ? seedRows : [] };
        },
        async run() {
          seen.push({ sql, binds: this._binds });
          const changes = /^\s*DELETE/i.test(sql) ? this._binds.length : 0;
          return { meta: { changes } };
        },
        async first() { return null; },
      };
      return stmt;
    },
  };
}

const env = (db: any) => ({ DB: db, DESAP_FOTOS: { async delete() {} } }) as any;

describe('dedupePersonas dhash mode — large-cluster subgroup redesign', () => {
  it('keeps the small-cluster branch (2..6 whole-cluster collapse)', async () => {
    const db = fakeD1([]);
    await dedupePersonas(env(db), { mode: 'dhash', apply: false });
    const sql = db.seen[0].sql;
    expect(sql).toMatch(/grp BETWEEN 2 AND 6 AND rn > 1/);
  });

  it('adds the >6 branch gated on same-name subgroup + compatible ages', async () => {
    const db = fakeD1([]);
    await dedupePersonas(env(db), { mode: 'dhash', apply: false });
    const sql = db.seen[0].sql;
    // subgroup partition = dhash + normalized name (accent/case folded)
    expect(sql).toMatch(/PARTITION BY photo_dhash, replace\(/);
    // large-cluster branch requires: >6 cluster, a real subgroup, compatible ages,
    // and a real first+last name — every clause is a safety guard.
    expect(sql).toMatch(/grp > 6 AND subgrp >= 2 AND subrn > 1 AND age_lo = age_hi/);
    expect(sql).toMatch(/length\(name_norm\) >= 5 AND instr\(name_norm, ' '\) > 0/);
    // age compatibility = min/max over the subgroup's non-null ages coincide
    expect(sql).toMatch(/coalesce\(MIN\(edad\) OVER \(PARTITION BY photo_dhash/);
    expect(sql).toMatch(/coalesce\(MAX\(edad\) OVER \(PARTITION BY photo_dhash/);
  });

  it('never collapses a whole large cluster (no bare rn > 1 outside the 2..6 branch)', async () => {
    const db = fakeD1([]);
    await dedupePersonas(env(db), { mode: 'dhash', apply: false });
    const sql = db.seen[0].sql;
    // the only rn > 1 must be inside the small-cluster conjunction
    const bare = sql.replace(/grp BETWEEN 2 AND 6 AND rn > 1/, '');
    expect(bare).not.toMatch(/\brn > 1\b/);
  });

  it('keeps the dead/degenerate-hash scope filters', async () => {
    const db = fakeD1([]);
    await dedupePersonas(env(db), { mode: 'dhash', apply: false });
    const sql = db.seen[0].sql;
    expect(sql).toMatch(/photo_dhash NOT LIKE 'dead:%'/);
    expect(sql).toMatch(/'0000000000000000','ffffffffffffffff'/);
  });

  it('dry-run counts, apply deletes — wiring unchanged', async () => {
    const rows = [{ id: 'a', foto_r2: null }, { id: 'b', foto_r2: null }];
    const dry = await dedupePersonas(env(fakeD1(rows)), { mode: 'dhash', apply: false });
    expect(dry.found).toBe(2);
    expect(dry.deletedRows).toBe(0);
    const db = fakeD1(rows);
    const wet = await dedupePersonas(env(db), { mode: 'dhash', apply: true });
    expect(wet.deletedRows).toBe(2);
    expect(db.seen.some((q) => /^\s*DELETE FROM personas/i.test(q.sql))).toBe(true);
  });

  it('non-dhash modes keep the plain rn > 1 query (no subgroup columns)', async () => {
    const db = fakeD1([]);
    await dedupePersonas(env(db), { mode: 'exact', apply: false });
    const sql = db.seen[0].sql;
    expect(sql).toMatch(/WHERE rn > 1/);
    expect(sql).not.toMatch(/subgrp|age_lo|name_norm/);
  });
});
