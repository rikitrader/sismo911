// src/ingest/casualty-cron.ts
//
// Trailing casualty-figure poller. Runs on the :45 cron trigger but only does
// real work every 3 HOURS (UTC hour % 3 === 0) — the account is capped at 5 cron
// triggers (all in use), so we self-throttle inside an existing group instead of
// adding a sixth schedule.
//
// What it polls (machine-readable, no fabrication):
//   • USGS PAGER — the live alert color + magnitude for both events of the
//     24-Jun-2026 sequence → a transparent modeled "dead" floor (red = 1.000+).
//   • ReliefWeb / OCHA — reachability of the GLIDE disaster record (freshness
//     signal + live citation). ReliefWeb's disaster schema carries no death
//     count, so we record the source as reached but NEVER invent a number.
//
// Every candidate figure passes gateCasualty() (the in-memory ingestion filter:
// markup/spam/XSS on text + numeric/enum/timestamp sanity) BEFORE it touches D1.
// We only INSERT when a source's figure CHANGES, so the timeline stays meaningful
// and a 3-hourly poll never floods the table with identical rows.

import type { Env } from '../types';
import { uid, recordIngest } from '../lib/db';
import { gateCasualty, type CasualtyRowInput } from './casualty-gate';
import { logAgentActivity } from '../lib/agent-activity';

/** The active event the public dashboard defaults to. */
export const CURRENT_EVENT_ID = 've-eq-2026-06-24';

// USGS event ids for the twin earthquakes (verified live).
const USGS_EVENTS = [
  { id: 'us6000t7zp', label: 'Mw 7,5 — 28 km SE de Yumare' }, // mainshock
  { id: 'us6000t7zc', label: 'Mw 7,2 — 24 km ENE de San Felipe' }, // foreshock
];
const USGS_EVENT_API = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
const RELIEFWEB_DISASTER = 'https://api.reliefweb.int/v1/disasters?appname=sismo911&query[value]=eq-2026-000093-ven&limit=1';

// Alert color → transparent modeled fatality FLOOR (mirrors src/lib/pager.ts
// fatalitiesBand: red 1.000+, orange 100–999, yellow 1–99, green 0).
const ALERT_FLOOR: Record<string, number> = { red: 1000, orange: 100, yellow: 1, green: 0 };

const UA = 'SISMO911/1.0 (+https://sismo911.com; casualty-poller)';

async function fetchJson(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, accept: 'application/json' } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/** Latest stored figure for a source+metric (to decide whether anything changed). */
async function latestValue(
  env: Env, eventId: string, sourceKey: string, metric: string,
): Promise<{ value_min: number; value_max: number | null } | null> {
  return env.DB.prepare(
    `SELECT value_min, value_max FROM casualty_reports
     WHERE event_id = ? AND source_key = ? AND metric = ?
     ORDER BY as_of_ms DESC LIMIT 1`,
  ).bind(eventId, sourceKey, metric).first<{ value_min: number; value_max: number | null }>().catch(() => null);
}

/** Gate a candidate row and insert it only if the figure changed. Returns 1/0. */
async function recordIfChanged(env: Env, eventId: string, input: CasualtyRowInput): Promise<number> {
  const gated = gateCasualty(input);
  if (!gated.ok) {
    console.log(`[casualties] dropped ${input.source_key}/${input.metric}: ${gated.reason} ${gated.detail}`);
    return 0;
  }
  const r = gated.row;
  const prev = await latestValue(env, eventId, r.source_key, r.metric);
  if (prev && prev.value_min === r.value_min && (prev.value_max ?? null) === (r.value_max ?? null)) {
    return 0; // unchanged — don't flood the timeline
  }
  await env.DB.prepare(
    `INSERT INTO casualty_reports
       (id, event_id, source_key, metric, value_min, value_max, as_of_ms, confidence, citation_url, note, method, ingested_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'cron', ?)`,
  ).bind(
    uid('cas'), eventId, r.source_key, r.metric, r.value_min, r.value_max,
    r.as_of_ms, r.confidence, r.citation_url, r.note, Date.now(),
  ).run();
  return 1;
}

/**
 * Scheduled trailing poll. Self-throttles to every 3 hours. Never throws — a
 * failed external source is logged, the rest still run (No-Pre-Existing-Failure:
 * a real error is surfaced via recordIngest, not swallowed silently).
 */
export async function ingestCasualties(env: Env): Promise<{ skipped?: boolean; written: number; usgs: number; reliefweb: boolean }> {
  // 3-hour self-throttle (00:45, 03:45, 06:45 … UTC).
  if (new Date().getUTCHours() % 3 !== 0) {
    return { skipped: true, written: 0, usgs: 0, reliefweb: false };
  }

  let written = 0;
  let usgsOk = 0;
  let reliefweb = false;
  const now = Date.now();

  try {
    // ── USGS PAGER: live alert color → modeled fatality floor ────────────────
    let worstFloor = -1;
    let worstNote = '';
    let citation = 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000t7zp/pager';
    for (const ev of USGS_EVENTS) {
      const j = await fetchJson(`${USGS_EVENT_API}?eventid=${ev.id}&format=geojson`);
      const alert = String(j?.properties?.alert ?? '').toLowerCase();
      if (!(alert in ALERT_FLOOR)) continue;
      usgsOk++;
      const floor = ALERT_FLOOR[alert];
      if (floor > worstFloor) {
        worstFloor = floor;
        worstNote = `Alerta ${alert.toUpperCase()} PAGER (${ev.label}); banda modelada de fallecidos.`;
        if (j?.properties?.detail) citation = String(j.properties.detail);
      }
    }
    if (worstFloor >= 0) {
      written += await recordIfChanged(env, CURRENT_EVENT_ID, {
        source_key: 'usgs_pager', source_name: 'USGS PAGER', metric: 'dead',
        value_min: worstFloor, value_max: null, as_of_ms: now, confidence: 0.9,
        citation_url: citation, note: worstNote,
      });
    }

    // ── ReliefWeb / OCHA reachability (freshness signal; no fabricated figure) ─
    const rw = await fetchJson(RELIEFWEB_DISASTER);
    reliefweb = Array.isArray(rw?.data) && rw.data.length > 0;

    await recordIngest(env, 'casualties', true, written,
      reliefweb ? undefined : 'reliefweb_unreachable');
  } catch (err: any) {
    await recordIngest(env, 'casualties', false, written, String(err?.message ?? err));
    // Do not rethrow: a poll failure must not abort the rest of the :45 group.
  }

  // CRM tracking — official toll poll (runs only on the 3h tick reached here).
  await logAgentActivity(env, {
    source: 'casualties', action: 'poll', fetched: usgsOk, updated: written,
    summary: `🤖 Balance oficial — ${written} cifra(s) actualizada(s) (USGS PAGER ${usgsOk}; ReliefWeb ${reliefweb ? 'OK' : 'sin alcance'}).`,
  });
  return { written, usgs: usgsOk, reliefweb };
}
