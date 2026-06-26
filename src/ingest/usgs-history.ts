import type { Env } from '../types';
import { normalizeFeature } from '../lib/usgs';
import { upsertEvents, recordIngest } from '../lib/db';

// Historical backfill of the Venezuela seismic archive. The hourly cron only
// sees the USGS 30-day summary feed; to populate years of history we query the
// FDSN event API (which supports arbitrary start/end + a bbox) one year at a
// time and upsert into the same `events` table. Upsert-by-id means it is
// idempotent and shares dedupe with the live feed. Runs server-side (Worker),
// where USGS DNS resolves correctly — do not expect it to work from the dev Mac.

// USGS FDSNWS path version is "1" — "1.0" returns 404 (every backfill year
// would silently land in failedYears and write 0).
const FDSN = 'https://earthquake.usgs.gov/fdsnws/event/1/query';

export interface BackfillReport { years: number; minMag: number; fetched: number; written: number; failedYears: number[]; }

export async function backfillUsgsHistory(env: Env, opts: { years?: number; minMag?: number } = {}): Promise<BackfillReport> {
  const years = Math.min(Math.max(opts.years ?? 25, 1), 60);
  const minMag = Math.max(0, opts.minMag ?? 3.5);
  const bbox =
    `&minlatitude=${env.USGS_MINLAT}&maxlatitude=${env.USGS_MAXLAT}` +
    `&minlongitude=${env.USGS_MINLON}&maxlongitude=${env.USGS_MAXLON}`;
  const nowY = new Date().getUTCFullYear();
  let fetched = 0, written = 0;
  const failedYears: number[] = [];

  for (let y = nowY; y > nowY - years; y--) {
    const url = `${FDSN}?format=geojson&starttime=${y}-01-01&endtime=${y + 1}-01-01` +
      `&minmagnitude=${minMag}${bbox}&orderby=time&limit=20000`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'SISMO911/0.1 (emergency monitoring)' },
        cf: { cacheTtl: 3600, cacheEverything: true },
      });
      if (!res.ok) { failedYears.push(y); continue; }
      const json: any = await res.json();
      const feats: any[] = json.features ?? [];
      fetched += feats.length;
      if (feats.length) written += await upsertEvents(env, feats.map(normalizeFeature), feats);
    } catch {
      failedYears.push(y);
    }
  }
  await recordIngest(env, 'usgs-history', failedYears.length < years, written).catch(() => {});
  console.log(`[history] ${years}y minMag≥${minMag}: fetched ${fetched}, upserted ${written}, failed years ${failedYears.length}`);
  return { years, minMag, fetched, written, failedYears };
}
