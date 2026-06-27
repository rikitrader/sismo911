#!/usr/bin/env node
// SISMO911 — cross-source seismic de-duplication (live D1).
//
// USGS and FUNVISIS report the same physical quake under different ids, so they
// land as two rows / two markers. This marks the non-preferred row
// (`dup_of = <kept id>`); public reads filter `dup_of IS NULL`. NON-DESTRUCTIVE
// and idempotent — re-marking a re-ingested duplicate is a no-op, so nothing is
// ever lost and the hourly ingest can't resurrect a visible dup.
//
// The Worker already runs this every hour (src/ingest/funvisis-cron.ts →
// src/lib/dedupe-seismic.ts). This script is for on-demand / backfill runs and
// for INSPECTING what would be merged before trusting the automation. The match
// logic here mirrors src/lib/dedupe-seismic.ts exactly — keep them in sync.
//
// Usage:
//   node scripts/dedupe-cross-source.mjs                  # dry-run on REMOTE D1
//   node scripts/dedupe-cross-source.mjs --apply          # mark dups on REMOTE
//   node scripts/dedupe-cross-source.mjs --local --apply  # local D1
//   node scripts/dedupe-cross-source.mjs --days 30        # wider scan window
//   node scripts/dedupe-cross-source.mjs --window-sec 120 --dist-km 75 --mag-tol 2.5
//   node scripts/dedupe-cross-source.mjs --reset          # CLEAR all dup_of (unmark), then re-run
//
// Flags: --apply (default dry-run) · --local (default remote) · --reset ·
//        --days N · --window-sec N · --dist-km N · --mag-tol N · --diverge-mag N

import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
// Numeric flag reader. A non-numeric value (e.g. a shell that didn't word-split,
// so "90 60" arrives as one token → NaN) is a HARD error, never a silent
// fall-through: a NaN threshold would make `dt > NaN` false and disable the gate.
const val = (f, d) => {
  const i = args.indexOf(f);
  if (i < 0) return d;
  const n = Number(args[i + 1]);
  if (!Number.isFinite(n)) { console.error(`Bad value for ${f}: ${JSON.stringify(args[i + 1])} (expected a number)`); process.exit(2); }
  return n;
};

const APPLY = has('--apply');
const LOCAL = has('--local');
const RESET = has('--reset');
const DB = 'sismo911';
const SCOPE = LOCAL ? '--local' : '--remote';

// Defaults tuned against live data 2026-06-27 — see src/lib/dedupe-seismic.ts.
const WINDOW_MS = val('--window-sec', 150) * 1000;
const DIST_KM = val('--dist-km', 70);
const MAG_TOL = val('--mag-tol', 2.5);
const DIVERGE_MAG = val('--diverge-mag', 1.0);
const DAYS = val('--days', 7);
const PRIORITY = { usgs: 2, funvisis: 1 }; // higher = kept as canonical

function d1(sql) {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN; // force the gmail OAuth wrangler session
  delete env.CLOUDFLARE_ACCOUNT_ID;
  // Flatten to one line — embedded newlines survive JSON.stringify as literal
  // "\n" through the shell and reach SQLite as a stray backslash token.
  const flat = sql.replace(/\s+/g, ' ').trim();
  // `--env-file /dev/null`: wrangler v4 auto-loads the project .env, whose
  // Cloudflare token lacks D1 write scope and shadows the OAuth session even
  // after we drop it from the child env → D1 "permission" Error 7500 on writes.
  const out = execSync(
    `npx wrangler d1 execute ${DB} ${SCOPE} --env-file /dev/null --json --command ${JSON.stringify(flat)}`,
    { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }
  );
  const json = JSON.parse(out);
  const node = Array.isArray(json) ? json[0] : json;
  // Wrangler exits 0 even when the API rejects the query (returns {error}); a
  // write that silently no-ops here once made `--reset` "succeed" without
  // clearing anything. Treat any error node as a hard failure.
  if (node?.error) throw new Error(`D1 query failed: ${node.error.text ?? JSON.stringify(node.error)}`);
  return node?.results ?? [];
}

const R_KM = 6371, toRad = (d) => (d * Math.PI) / 180;
function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}
const prio = (s) => PRIORITY[String(s).toLowerCase()] ?? 0;

// Greedy nearest-first cross-source matching (mirrors src/lib/dedupe-seismic.ts).
function findPairs(events) {
  const cands = [];
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i], b = events[j];
      if (String(a.source).toLowerCase() === String(b.source).toLowerCase()) continue;
      const dt = Math.abs(a.time_ms - b.time_ms);
      if (dt > WINDOW_MS) continue;
      const dist = haversineKm(a, b);
      if (dist > DIST_KM) continue;
      if (a.mag != null && b.mag != null && Math.abs(a.mag - b.mag) > MAG_TOL) continue;
      cands.push({ a, b, dt, dist, score: dt / WINDOW_MS + dist / DIST_KM });
    }
  }
  cands.sort((x, y) => x.score - y.score);
  const used = new Set(), pairs = [];
  for (const { a, b, dt, dist } of cands) {
    if (used.has(a.id) || used.has(b.id)) continue;
    used.add(a.id); used.add(b.id);
    const aWins = prio(a.source) > prio(b.source) || (prio(a.source) === prio(b.source) && a.id <= b.id);
    const keep = aWins ? a : b, drop = aWins ? b : a;
    const dMag = keep.mag != null && drop.mag != null ? Math.abs(keep.mag - drop.mag) : null;
    pairs.push({
      keepId: keep.id, dropId: drop.id, keepSource: keep.source, dropSource: drop.source,
      dtSec: Math.round(dt / 1000), distKm: Math.round(dist * 10) / 10,
      dMag: dMag == null ? null : Math.round(dMag * 100) / 100,
      diverges: dMag != null && dMag >= DIVERGE_MAG,
      keepMag: keep.mag, dropMag: drop.mag,
    });
  }
  return pairs;
}

function main() {
  console.log(`SISMO911 cross-source dedup — ${SCOPE}, ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`  window=${WINDOW_MS / 1000}s  dist=${DIST_KM}km  mag-tol=${MAG_TOL}  scan=${DAYS}d\n`);

  if (RESET) {
    const before = d1(`SELECT COUNT(*) AS n FROM events WHERE dup_of IS NOT NULL`)[0]?.n ?? 0;
    if (APPLY) { d1(`UPDATE events SET dup_of = NULL WHERE dup_of IS NOT NULL`); console.log(`RESET: cleared ${before} dup_of marks.\n`); }
    else console.log(`RESET (dry-run): would clear ${before} dup_of marks. Re-run with --apply.\n`);
  }

  const since = Date.now() - DAYS * 86_400_000;
  const events = d1(
    `SELECT id, source, mag, time_ms, lat, lon FROM events
     WHERE dup_of IS NULL AND lat IS NOT NULL AND lon IS NOT NULL AND time_ms >= ${since}
     ORDER BY time_ms DESC LIMIT 1000`
  ).map((e) => ({ ...e, mag: e.mag == null ? null : Number(e.mag), time_ms: Number(e.time_ms), lat: Number(e.lat), lon: Number(e.lon) }));

  const pairs = findPairs(events);
  console.log(`Scanned ${events.length} canonical events → ${pairs.length} cross-source duplicate pair(s).\n`);
  for (const p of pairs) {
    const flag = p.diverges ? '  ⚠ MAG DIVERGENCE' : '';
    console.log(`  KEEP ${p.keepSource}:${p.keepId} (M${p.keepMag})  ⟵  DROP ${p.dropSource}:${p.dropId} (M${p.dropMag})  Δt=${p.dtSec}s Δd=${p.distKm}km Δmag=${p.dMag}${flag}`);
  }
  const diverge = pairs.filter((p) => p.diverges);
  if (diverge.length) console.log(`\n${diverge.length} pair(s) where the agencies disagree on magnitude by ≥${DIVERGE_MAG}.`);

  if (!pairs.length) { console.log('\nNothing to do.'); return; }

  if (APPLY) {
    const sql = pairs.map((p) => `UPDATE events SET dup_of='${p.keepId.replace(/'/g, "''")}' WHERE id='${p.dropId.replace(/'/g, "''")}' AND dup_of IS NULL;`).join('\n');
    d1(sql);
    console.log(`\n✓ Marked ${pairs.length} row(s) as duplicates (dup_of). Public feeds now show one marker per quake.`);
  } else {
    console.log(`\nDRY-RUN — nothing written. Re-run with --apply to mark these ${pairs.length} duplicate(s).`);
  }
}

main();
