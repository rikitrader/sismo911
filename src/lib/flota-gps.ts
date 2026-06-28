// GPS payload validation + sanity guards for live unit tracking. Pure functions
// (no I/O) so they are fully unit-testable with real inputs. The DO ingest path
// calls validateGps() then speedJumpMps() against the unit's previous fix.

export interface GpsInput {
  lat?: unknown;
  lng?: unknown;
  accuracy?: unknown;
  heading?: unknown;
  speed?: unknown;
  battery?: unknown;
  recordedAt?: unknown;
}

export interface GpsClean {
  lat: number;
  lng: number;
  accuracy_m: number | null;
  heading: number | null;
  speed_mps: number | null;
  battery_pct: number | null;
  recorded_at: number; // unix-ms
}

export type GpsResult = { ok: true; value: GpsClean } | { ok: false; error: string };

// Tunables.
export const MAX_ACCURACY_M = 2000;      // reject wildly imprecise fixes
export const MAX_FUTURE_MS = 60_000;     // tolerate ≤1 min device clock skew ahead
export const MAX_STALE_MS = 5 * 60_000;  // older than 5 min → stale, reject (live)
export const MAX_BACKFILL_MS = 24 * 60 * 60_000; // buffered/offline fixes: accept up to 24h old
export const MAX_JUMP_MPS = 130;         // ~468 km/h: above this between two fixes = impossible jump

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Parse a device clock value (ISO string or unix-ms number) to unix-ms. */
function parseRecordedAt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** Validate + normalize a raw GPS payload. `now` is the server time (unix-ms).
 *  `maxStaleMs` bounds how old `recordedAt` may be — MAX_STALE_MS for live,
 *  MAX_BACKFILL_MS for buffered/offline uploads. Future timestamps are always
 *  bounded by MAX_FUTURE_MS (clock-skew). */
export function validateGps(input: GpsInput, now: number, maxStaleMs: number = MAX_STALE_MS): GpsResult {
  if (input == null || typeof input !== 'object') return { ok: false, error: 'malformed_payload' };

  const lat = num(input.lat);
  const lng = num(input.lng);
  if (lat == null || lng == null) return { ok: false, error: 'missing_coords' };
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return { ok: false, error: 'coords_out_of_range' };

  const accuracy_m = num(input.accuracy);
  if (accuracy_m != null && (accuracy_m < 0 || accuracy_m > MAX_ACCURACY_M)) {
    return { ok: false, error: 'accuracy_insane' };
  }

  const recorded_at = parseRecordedAt(input.recordedAt);
  if (recorded_at == null) return { ok: false, error: 'bad_timestamp' };
  if (recorded_at > now + MAX_FUTURE_MS) return { ok: false, error: 'timestamp_future' };
  if (recorded_at < now - maxStaleMs) return { ok: false, error: 'timestamp_stale' };

  let heading = num(input.heading);
  if (heading != null) heading = ((heading % 360) + 360) % 360;

  let speed_mps = num(input.speed);
  if (speed_mps != null && speed_mps < 0) speed_mps = null;

  let battery_pct = num(input.battery);
  if (battery_pct != null) battery_pct = Math.max(0, Math.min(100, Math.round(battery_pct)));

  return { ok: true, value: { lat, lng, accuracy_m, heading, speed_mps, battery_pct, recorded_at } };
}

/** Great-circle distance in metres. */
export function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Implied speed (m/s) between the previous fix and the new one. null if not
 *  computable (no prev, or non-positive dt). Used to reject impossible jumps. */
export function impliedSpeedMps(
  prev: { lat: number; lng: number; recorded_at: number } | null,
  next: { lat: number; lng: number; recorded_at: number },
): number | null {
  if (!prev) return null;
  const dt = (next.recorded_at - prev.recorded_at) / 1000;
  if (dt <= 0) return null; // out-of-order / duplicate timestamp; handled separately
  const dist = haversineMeters(prev.lat, prev.lng, next.lat, next.lng);
  return dist / dt;
}

/** True if the move from prev→next is physically impossible. */
export function isImpossibleJump(
  prev: { lat: number; lng: number; recorded_at: number } | null,
  next: { lat: number; lng: number; recorded_at: number },
): boolean {
  const v = impliedSpeedMps(prev, next);
  return v != null && v > MAX_JUMP_MPS;
}
