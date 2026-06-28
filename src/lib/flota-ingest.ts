// Core GPS ingest pipeline — validates, enforces unit-active + speed-jump guards,
// stores the location, and audits. Pure enough to test with real SQL (the DO
// calls this, then broadcasts the returned location to admin subscribers).

import type { Env } from '../types';
import { uid } from './db';
import { audit } from './flota-audit';
import { validateGps, isImpossibleJump, MAX_STALE_MS, MAX_BACKFILL_MS, type GpsInput } from './flota-gps';

export interface IngestCtx { unitId: string; tokenId?: string | null; }

export interface StoredLocation {
  id: string;
  unitId: string;
  lat: number;
  lng: number;
  accuracy_m: number | null;
  heading: number | null;
  speed_mps: number | null;
  battery_pct: number | null;
  recorded_at: number;
  received_at: number;
}

export type IngestResult = { ok: true; location: StoredLocation } | { ok: false; error: string };

/** Ingest mode:
 *  - 'live'     real-time fix from the open WebSocket — 5-min staleness window,
 *               impossible-jump guard, source 'phone', broadcast to admins.
 *  - 'backfill' a buffered/offline fix flushed after reconnect — 24-h staleness
 *               window, NO jump guard (the device's own contiguous buffer is
 *               trusted), source 'buffered', NOT broadcast (it is historical). */
export type IngestMode = 'live' | 'backfill';

/** Validate + store one GPS fix for a unit. `now` is server time (unix-ms). */
export async function ingestGps(env: Env, ctx: IngestCtx, payload: GpsInput, now: number, mode: IngestMode = 'live'): Promise<IngestResult> {
  const actorId = `unit:${ctx.unitId}`;
  const backfill = mode === 'backfill';

  const v = validateGps(payload, now, backfill ? MAX_BACKFILL_MS : MAX_STALE_MS);
  if (!v.ok) {
    await audit(env, { actorId, unitId: ctx.unitId, action: 'gps.reject', meta: { reason: v.error, mode } });
    return { ok: false, error: v.error };
  }

  const unit = await env.DB.prepare(`SELECT status FROM flota_units WHERE id = ?`).bind(ctx.unitId)
    .first() as { status: string } | null;
  if (!unit) {
    await audit(env, { actorId, unitId: ctx.unitId, action: 'gps.reject', meta: { reason: 'unit_not_found', mode } });
    return { ok: false, error: 'unit_not_found' };
  }
  if (unit.status !== 'active') {
    await audit(env, { actorId, unitId: ctx.unitId, action: 'gps.reject', meta: { reason: 'unit_inactive', mode } });
    return { ok: false, error: 'unit_inactive' };
  }

  // The impossible-jump guard is a live anti-spoofing check against the latest
  // stored fix. It does NOT apply to backfill: buffered fixes are a contiguous
  // device-local track and may legitimately be far from a newer live fix.
  if (!backfill) {
    const prev = await env.DB.prepare(
      `SELECT lat, lng, recorded_at FROM flota_locations WHERE unit_id = ? ORDER BY recorded_at DESC LIMIT 1`
    ).bind(ctx.unitId).first() as { lat: number; lng: number; recorded_at: number } | null;
    if (isImpossibleJump(prev, v.value)) {
      await audit(env, { actorId, unitId: ctx.unitId, action: 'gps.reject', meta: { reason: 'impossible_jump', mode } });
      return { ok: false, error: 'impossible_jump' };
    }
  }

  const id = uid('loc');
  await env.DB.prepare(
    `INSERT INTO flota_locations
       (id, unit_id, lat, lng, accuracy_m, heading, speed_mps, battery_pct, source, recorded_at, received_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, ctx.unitId, v.value.lat, v.value.lng, v.value.accuracy_m, v.value.heading,
    v.value.speed_mps, v.value.battery_pct, backfill ? 'buffered' : 'phone', v.value.recorded_at, now,
  ).run();

  await audit(env, { actorId, unitId: ctx.unitId, action: 'gps.ingest', meta: { loc: id, accuracy: v.value.accuracy_m, mode } });

  return { ok: true, location: { id, unitId: ctx.unitId, ...v.value, received_at: now } };
}

export interface BackfillResult { accepted: number; rejected: { i: number; error: string }[]; }

/** Flush a batch of buffered/offline fixes (each ingested in 'backfill' mode).
 *  Per-fix errors are collected, not fatal — a bad fix never blocks the rest. */
export async function backfillBatch(env: Env, unitId: string, fixes: GpsInput[], now: number): Promise<BackfillResult> {
  const rejected: { i: number; error: string }[] = [];
  let accepted = 0;
  for (let i = 0; i < fixes.length; i++) {
    const r = await ingestGps(env, { unitId }, fixes[i] as GpsInput, now, 'backfill');
    if (r.ok) accepted++;
    else rejected.push({ i, error: r.error });
  }
  return { accepted, rejected };
}

/** Pure sliding-window rate-limit. Returns the kept timestamps + whether allowed. */
export function withinRate(recent: number[], now: number, limit: number, windowMs: number): { allowed: boolean; kept: number[] } {
  const kept = recent.filter((t) => t > now - windowMs);
  if (kept.length >= limit) return { allowed: false, kept };
  kept.push(now);
  return { allowed: true, kept };
}
