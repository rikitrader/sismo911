#!/usr/bin/env node
// Compute a TRUE perceptual hash (dHash) for personas photos and write it to
// remote D1. Unlike the SHA-256 photo_phash (byte-exact), dHash is robust to
// recompression/resize/minor edits, so the `dhash` dedupe collapses the SAME
// image re-encoded across sources — not just byte-identical files.
//
// Runs locally because Workers can't decode JPEG. Uses sharp: fetch → 9x8
// grayscale → row-difference hash → 64-bit → 16-hex. Idempotent/resumable
// (WHERE photo_dhash IS NULL); unreachable/undecodable rows get a unique
// 'dead:<id>' sentinel so they never re-select or form a false dup group.
//
// Usage: unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID && node scripts/dhash-photos-local.mjs [maxRows]

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const DB = 'sismo911';
const MAX = Number(process.argv[2]) || Infinity;
const BATCH = 400;
const CONC = 8;
const SEL = `SELECT id, foto FROM personas WHERE trim(coalesce(foto,'')) <> '' AND photo_dhash IS NULL LIMIT ${BATCH}`;

function d1json(sql) {
  const out = execSync(`npx wrangler d1 execute ${DB} --remote --json --command ${JSON.stringify(sql)}`,
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out)?.[0]?.results ?? [];
}
function d1exec(sql) {
  const f = join(tmpdir(), `ravdhash_${Date.now()}.sql`);
  writeFileSync(f, sql);
  execSync(`npx wrangler d1 execute ${DB} --remote --file ${JSON.stringify(f)}`, { stdio: ['ignore', 'ignore', 'ignore'] });
}
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// dHash: 9x8 grayscale, compare each pixel to its right neighbour → 64 bits.
async function dhash(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'follow' });
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) return null;
  const px = await sharp(buf).resize(9, 8, { fit: 'fill' }).grayscale().raw().toBuffer(); // 72 bytes
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i = y * 9 + x;
      bits = (bits << 1n) | (px[i] < px[i + 1] ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

async function mapPool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx]); } catch { out[idx] = null; } }
  }));
  return out;
}

let hashed = 0, dead = 0, processed = 0;
while (processed < MAX) {
  const rows = d1json(SEL);
  if (!rows.length) { console.log('No more rows to dHash.'); break; }
  const hs = await mapPool(rows, CONC, (r) => dhash(r.foto));
  const ups = rows.map((r, k) => hs[k]
    ? (hashed++, `UPDATE personas SET photo_dhash=${q(hs[k])} WHERE id=${q(r.id)};`)
    : (dead++, `UPDATE personas SET photo_dhash=${q('dead:' + r.id)} WHERE id=${q(r.id)};`));
  d1exec(ups.join('\n'));
  processed += rows.length;
  console.log(`round: ${rows.length} → dHashed ${hashed}, undecodable ${dead} (processed ${processed})`);
}
console.log(`DONE. dHashed=${hashed} undecodable=${dead}`);
