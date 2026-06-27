#!/usr/bin/env node
// Hash RAV photos LOCALLY and write photo_phash to remote D1.
//
// Why: RAV hosts its photos on terremotovenezuela.app, which BLOCKS Cloudflare's
// network (datacenter egress) — same class as the USGS DNS poisoning. So the
// Worker's backfillPhashes can't fetch them and marks them phash_dead, leaving
// the SHA-256 content-hash empty → the `phash` dedupe can't collapse the
// theempire↔RAV same-photo duplicates (e.g. "Levy campero"). This Mac CAN reach
// terremotovenezuela.app, so we hash here and UPDATE D1 (wrangler --remote under
// the gmail OAuth session). Idempotent + resumable (WHERE photo_phash IS NULL).
//
// Usage: unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID && node scripts/hash-rav-photos-local.mjs [maxRows]

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB = 'sismo911';
const MAX = Number(process.argv[2]) || Infinity;
const BATCH = 400;          // rows fetched+hashed per round
const CONC = 8;             // concurrent photo fetches
const SEL = `SELECT id, foto FROM personas WHERE foto LIKE 'https://terremotovenezuela.app/%' AND (photo_phash IS NULL OR trim(photo_phash) = '') LIMIT ${BATCH}`;

function d1json(sql) {
  const out = execSync(`npx wrangler d1 execute ${DB} --remote --json --command ${JSON.stringify(sql)}`,
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out)?.[0]?.results ?? [];
}
function d1exec(sql) {
  const f = join(tmpdir(), `ravphash_${Date.now()}.sql`);
  writeFileSync(f, sql);
  execSync(`npx wrangler d1 execute ${DB} --remote --file ${JSON.stringify(f)}`, { stdio: ['ignore', 'ignore', 'ignore'] });
}
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

async function sha256(url) {
  const ctl = AbortSignal.timeout(15000);
  const r = await fetch(url, { signal: ctl, redirect: 'follow' });
  if (!r.ok) return null;
  const buf = new Uint8Array(await r.arrayBuffer());
  if (!buf.length) return null;
  return createHash('sha256').update(buf).digest('hex');
}

async function mapPool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx]); } catch { out[idx] = null; } }
  }));
  return out;
}

let totalHashed = 0, totalDead = 0, processed = 0;
while (processed < MAX) {
  const rows = d1json(SEL);
  if (!rows.length) { console.log('No more rows to hash.'); break; }
  const hashes = await mapPool(rows, CONC, (r) => sha256(r.foto));
  const ups = [];
  rows.forEach((r, k) => {
    if (hashes[k]) { ups.push(`UPDATE personas SET photo_phash=${q(hashes[k])} WHERE id=${q(r.id)};`); totalHashed++; }
    else { ups.push(`UPDATE personas SET photo_phash=${q('dead:' + r.id)} WHERE id=${q(r.id)};`); totalDead++; } // sentinel: unique per row, never groups, won't re-select
  });
  if (ups.length) d1exec(ups.join('\n'));
  processed += rows.length;
  console.log(`round: ${rows.length} rows → hashed ${totalHashed}, unreachable ${totalDead} (processed ${processed})`);
}
console.log(`DONE. hashed=${totalHashed} unreachable=${totalDead}`);
