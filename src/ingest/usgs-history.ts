import type { Env } from '../types';
import { normalizeFeature } from '../lib/usgs';
import { upsertEvents, recordIngest } from '../lib/db';

// Historical backfill of the Venezuela seismic archive. The hourly cron only
// sees the USGS 30-day summary feed; to populate years of history we query the
// FDSN event API (arbitrary start/end + bbox) and upsert into the same `events`
// table. Upsert-by-id means it is idempotent and shares dedupe with the live feed.
//
// SUBREQUEST BUDGET: Cloudflare caps subrequests per Worker invocation (50 on
// the Free plan). The old loop did ONE fetch per year — a 60-year backfill blew
// the cap and the last ~10 years silently failed. Instead we fetch the WHOLE
// window in a single request (the VE bbox holds ~10k events all-time, well under
// FDSNWS's 20k row cap) and only split a window in half if it ever hits the cap.
// D1 upserts are chunked so a large batch can't blow the cap either.

// USGS FDSNWS path version is "1" — "1.0" returns 404 (which made every fetch
// fail and write 0 before the version fix).
const FDSN = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
const ROW_CAP = 20000;        // FDSNWS max rows per query
const UPSERT_CHUNK = 1000;    // events per D1 batch (1 subrequest each)

export interface BackfillReport {
  years: number; minMag: number; fetched: number; written: number;
  /** Year-spans [start,end) that failed to fetch; empty on full success. */
  failedYears: number[];
}

export async function backfillUsgsHistory(env: Env, opts: { years?: number; minMag?: number } = {}): Promise<BackfillReport> {
  const years = Math.min(Math.max(opts.years ?? 25, 1), 60);
  const minMag = Math.max(0, opts.minMag ?? 3.5);
  const bbox =
    `&minlatitude=${env.USGS_MINLAT}&maxlatitude=${env.USGS_MAXLAT}` +
    `&minlongitude=${env.USGS_MINLON}&maxlongitude=${env.USGS_MAXLON}`;
  const nowY = new Date().getUTCFullYear();
  const startY = nowY - years + 1;
  const endY = nowY + 1; // exclusive upper bound (covers the current year)
  let fetched = 0, written = 0;
  const failedYears: number[] = [];

  // Fetch [a, b) in one request; recurse-split only if it saturates ROW_CAP or
  // errors on a multi-year span. Returns the GeoJSON features.
  async function pull(a: number, b: number): Promise<any[]> {
    const url = `${FDSN}?format=geojson&starttime=${a}-01-01&endtime=${b}-01-01` +
      `&minmagnitude=${minMag}${bbox}&orderby=time&limit=${ROW_CAP}`;
    let feats: any[];
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'SISMO911/0.1 (emergency monitoring)' },
        cf: { cacheTtl: 3600, cacheEverything: true },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      feats = ((await res.json()) as any).features ?? [];
    } catch {
      if (b - a > 1) { const m = Math.floor((a + b) / 2); return [...await pull(a, m), ...await pull(m, b)]; }
      failedYears.push(a);
      return [];
    }
    // Saturated the row cap — split so we don't silently drop events.
    if (feats.length >= ROW_CAP && b - a > 1) {
      const m = Math.floor((a + b) / 2);
      return [...await pull(a, m), ...await pull(m, b)];
    }
    return feats;
  }

  const feats = await pull(startY, endY);
  fetched = feats.length;
  for (let i = 0; i < feats.length; i += UPSERT_CHUNK) {
    const chunk = feats.slice(i, i + UPSERT_CHUNK);
    written += await upsertEvents(env, chunk.map(normalizeFeature), chunk);
  }

  await recordIngest(env, 'usgs-history', failedYears.length === 0, written).catch(() => {});
  console.log(`[history] ${years}y minMag≥${minMag}: fetched ${fetched}, upserted ${written}, failed spans ${failedYears.length}`);
  return { years, minMag, fetched, written, failedYears };
}

// One-time bootstrap (cron). On a FRESH/empty D1 the historical archive is
// blank until someone hits the manual trigger; this auto-populates it once.
// Runs in its own staggered cron invocation ('5 * * * *') so it gets a full
// subrequest budget. Idempotent + self-disabling via a KV flag:
//   - flag already set            → no-op (1 KV read)
//   - D1 already has the archive  → just set the flag (no fetch needed)
//   - otherwise                   → run the full backfill, set flag on success
const BOOTSTRAP_KEY = 'history:bootstrapped';
const FRESH_THRESHOLD = 500; // events already present ⇒ treat as populated

export async function bootstrapHistory(env: Env): Promise<Record<string, unknown>> {
  // Latch the KV flag and record the outcome to ingest_log so EVERY :05 tick is
  // observable (otherwise the no-op/already-populated branches leave no trace and
  // a swallowed KV-put failure is invisible). Returns whether the flag is set.
  const latch = async (note: string, count: number): Promise<boolean> => {
    let ok = true;
    try { await env.CACHE.put(BOOTSTRAP_KEY, String(Date.now())); }
    catch (e: any) { ok = false; note = `${note};kv-put-failed:${e?.message ?? e}`; }
    await recordIngest(env, 'history-bootstrap', ok, count, note).catch(() => {});
    return ok;
  };

  if (await env.CACHE.get(BOOTSTRAP_KEY).catch(() => null)) {
    await recordIngest(env, 'history-bootstrap', true, 0, 'skip:already-bootstrapped').catch(() => {});
    return { skipped: 'already-bootstrapped' };
  }

  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>().catch(() => null);
  const count = Number(row?.n ?? 0);
  if (count >= FRESH_THRESHOLD) {
    const latched = await latch('skip:already-populated', count);
    return { skipped: 'already-populated', count, latched };
  }

  const report = await backfillUsgsHistory(env, { years: 60, minMag: 0 });
  // Only latch the flag on a clean run so a partial/failed fetch retries next tick.
  const latched = report.failedYears.length === 0 ? await latch('bootstrapped', report.written) : false;
  return { bootstrapped: true, priorCount: count, latched, ...report };
}
