import { describe, it, expect } from 'vitest';
import { chunk, placeholders, queryByIds, deleteByIds, deletePhotos, D1_MAX_PARAMS, R2_MAX_DELETE } from '../src/lib/sql';

// A minimal D1 stub recording every prepared statement + its bind count, so we
// can assert no single statement ever exceeds the D1 bound-parameter cap.
function fakeDB(rowsFor?: (binds: any[]) => any[]) {
  const calls: { sql: string; binds: any[] }[] = [];
  const db: any = {
    prepare(sql: string) {
      return {
        bind(...binds: any[]) {
          calls.push({ sql, binds });
          return {
            all: async () => ({ results: rowsFor ? rowsFor(binds) : [] }),
            run: async () => ({ meta: { changes: binds.length } }),
          };
        },
      };
    },
  };
  return { db, calls };
}

describe('sql helpers', () => {
  it('chunk splits into ≤size groups and covers all items', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 10)).toEqual([]);
    expect(chunk([1, 2, 3], 0).every((g) => g.length === 1)).toBe(true); // size<1 → 1
  });

  it('placeholders builds the right count', () => {
    expect(placeholders(3)).toBe('?,?,?');
    expect(placeholders(1)).toBe('?');
  });

  it('queryByIds never exceeds the D1 param cap and concatenates rows', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id${i}`);
    const { db, calls } = fakeDB((binds) => binds.map((b) => ({ id: b })));
    const rows = await queryByIds<{ id: string }>(db, ids, (ph) => `SELECT id WHERE id IN (${ph})`);
    expect(rows.length).toBe(250);                       // all rows returned
    expect(calls.length).toBe(Math.ceil(250 / D1_MAX_PARAMS)); // chunked
    expect(Math.max(...calls.map((c) => c.binds.length))).toBeLessThanOrEqual(D1_MAX_PARAMS);
  });

  it('deleteByIds chunks under the cap and sums deletions', async () => {
    const ids = Array.from({ length: 130 }, (_, i) => `x${i}`);
    const { db, calls } = fakeDB();
    const n = await deleteByIds(db, 'personas', ids);
    expect(n).toBe(130);
    expect(Math.max(...calls.map((c) => c.binds.length))).toBeLessThanOrEqual(D1_MAX_PARAMS);
    expect(calls.every((c) => c.sql.startsWith('DELETE FROM personas'))).toBe(true);
  });

  it('deletePhotos drops nulls, bulk-deletes ≤1000/call, and never throws', async () => {
    const deleted: string[][] = [];
    const bucket: any = { delete: async (keys: string[]) => { deleted.push(keys); } };
    const keys = [...Array.from({ length: 1500 }, (_, i) => `k${i}`), null, undefined];
    const n = await deletePhotos(bucket, keys as any);
    expect(n).toBe(1500);                                // nulls filtered
    expect(deleted.length).toBe(2);                      // 1000 + 500
    expect(Math.max(...deleted.map((b) => b.length))).toBeLessThanOrEqual(R2_MAX_DELETE);
  });

  it('deletePhotos swallows R2 errors (best-effort)', async () => {
    const bucket: any = { delete: async () => { throw new Error('r2 down'); } };
    await expect(deletePhotos(bucket, ['a', 'b'])).resolves.toBe(0);
  });
});
