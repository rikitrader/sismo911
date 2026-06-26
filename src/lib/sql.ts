// SQL / D1 safety helpers — centralize the patterns that have bitten us so a
// single correct implementation is reused everywhere instead of re-derived
// (and re-broken) per call site.
//
// Two hard limits these guard against:
//  1. D1 binds at most ~100 parameters per statement. A `WHERE id IN (?,?,…)`
//     built from an unbounded array silently 500s past that. `chunk()` +
//     `queryByIds()` keep every statement under the cap.
//  2. Workers cap subrequests per invocation. R2 `delete()` accepts an ARRAY of
//     keys (≤1000) deleted in ONE call — `deletePhotos()` uses that so purging
//     N photos costs 1 subrequest, not N.

export const D1_MAX_PARAMS = 90;            // safe margin under D1's ~100 cap
export const R2_MAX_DELETE = 1000;          // R2 deletes up to 1000 keys per call

export function chunk<T>(arr: T[], size = D1_MAX_PARAMS): T[][] {
  if (size < 1) size = 1;
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function placeholders(n: number): string {
  return new Array(n).fill('?').join(',');
}

// Run an `IN (...)` SELECT across as many chunked statements as needed and
// concatenate the rows. `makeSql(ph)` receives the placeholder string for the
// current chunk and must return the full SQL. Never exceeds the D1 param cap.
export async function queryByIds<T = Record<string, unknown>>(
  db: D1Database,
  ids: string[],
  makeSql: (ph: string) => string,
  size = D1_MAX_PARAMS,
): Promise<T[]> {
  const out: T[] = [];
  for (const part of chunk(ids, size)) {
    const { results } = await db.prepare(makeSql(placeholders(part.length))).bind(...part).all<T>();
    if (results) out.push(...results);
  }
  return out;
}

// Delete rows by id from a single table in param-safe chunks. Returns the count.
export async function deleteByIds(db: D1Database, table: string, ids: string[], size = D1_MAX_PARAMS): Promise<number> {
  let deleted = 0;
  for (const part of chunk(ids, size)) {
    const res = await db.prepare(`DELETE FROM ${table} WHERE id IN (${placeholders(part.length)})`).bind(...part).run();
    deleted += res.meta?.changes ?? 0;
  }
  return deleted;
}

// Delete R2 objects in bulk (≤1000/call) — 1 subrequest per batch instead of
// one per key. Best-effort: a failing batch is swallowed so it never aborts a
// cleanup pass. Returns how many keys were submitted for deletion.
export async function deletePhotos(bucket: R2Bucket, keys: (string | null | undefined)[]): Promise<number> {
  const real = keys.filter((k): k is string => !!k);
  let submitted = 0;
  for (const part of chunk(real, R2_MAX_DELETE)) {
    try { await bucket.delete(part); submitted += part.length; } catch { /* best-effort */ }
  }
  return submitted;
}
