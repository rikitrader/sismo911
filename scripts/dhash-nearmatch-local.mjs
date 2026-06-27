#!/usr/bin/env node
// Fuzzy perceptual-hash dedupe: collapse personas whose photos are NEAR-identical
// (dHash Hamming distance <= N), catching cropped/filtered/re-encoded copies that
// the EXACT-dHash dedupe (Hamming 0) misses.
//
// WHY LOCAL: needs an all-pairs scan over photo_dhash + union-find — not a SQL
// GROUP BY, and Workers can't hold/scan the whole set efficiently. Runs here,
// deletes via wrangler --remote (OAuth session). Idempotent.
//
// SAFETY (this is a missing-persons DB — a wrong merge erases a real person):
//   1. CORROBORATION GATE — a near-match pair is only merged if the two rows ALSO
//      share a real name token (>=4 chars, accent/!case-folded) OR the same phone
//      (>=7 digits). Visual similarity ALONE never deletes anything. (Two different
//      people with lookalike photos won't share a name, so they're left apart.)
//   2. Small clusters only — a merged cluster above --max-cluster (default 4) is
//      abandoned (likely a shared template/placeholder leaking through).
//   3. Degenerate hashes (all-0 / all-f) and dead:/empty are excluded.
//   4. DRY-RUN by default — prints what it WOULD merge; --apply to delete.
//
// Banding: with Hamming<=N, splitting the 64-bit hash into N+1 bands guarantees
// >=1 band is identical (pigeonhole), so we only compare rows that share a band.
//
// Usage:
//   node scripts/dhash-nearmatch-local.mjs                 # dry-run, N=6
//   node scripts/dhash-nearmatch-local.mjs --hamming 5     # tighter
//   node scripts/dhash-nearmatch-local.mjs --apply         # delete the extras

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const N = Math.max(1, Math.min(Number(argv[argv.indexOf('--hamming') + 1]) || 6, 12));
const MAX_CLUSTER = Math.max(2, Number(argv[argv.indexOf('--max-cluster') + 1]) || 4);
const DUMP = argv.includes('--dump') ? (argv[argv.indexOf('--dump') + 1] || '') : null;
const DB = 'sismo911';
const BANDS = N + 1;

function d1json(sql) {
  sql = sql.replace(/\s+/g, ' ').trim();   // single-line: literal \n in --command breaks the shell-escaped arg
  const out = execSync(`npx wrangler d1 execute ${DB} --remote --json --command ${JSON.stringify(sql)}`,
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out)?.[0]?.results ?? [];
}
function d1exec(sql) {
  const f = join(tmpdir(), `nearmatch_${Date.now()}_${Math.floor(performance.now())}.sql`);
  writeFileSync(f, sql);
  execSync(`npx wrangler d1 execute ${DB} --remote --file ${JSON.stringify(f)}`, { stdio: ['ignore', 'ignore', 'ignore'] });
}
const qs = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// --- popcount over a 16-hex (64-bit) value, as two 32-bit halves ---
function pc32(x) { x = x - ((x >>> 1) & 0x55555555); x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; }
function hamming(aHi, aLo, bHi, bLo) { return pc32((aHi ^ bHi) >>> 0) + pc32((aLo ^ bLo) >>> 0); }

// band boundaries: split 16 hex chars into BANDS near-equal chunks
function bandSlices() {
  const slices = []; let start = 0;
  for (let b = 0; b < BANDS; b++) { const len = Math.floor((16 - start) / (BANDS - b)); slices.push([start, start + len]); start += len; }
  return slices;
}

// accent/!case-folded name tokens >= 4 chars (the corroboration signal)
function nameTokens(name) {
  const s = String(name || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ');
  return new Set(s.split(/\s+/).filter((t) => t.length >= 4));
}
const phoneDigits = (c) => { const d = String(c || '').replace(/\D/g, ''); return d.length >= 7 ? d.slice(-10) : null; };
const completeness = (r) => (r.foto_r2 || r.foto ? 1 : 0) + (r.contacto ? 1 : 0) + (r.descripcion ? 1 : 0) + (r.ubicacion ? 1 : 0);

function corroborated(a, b) {
  const pa = phoneDigits(a.contacto), pb = phoneDigits(b.contacto);
  if (pa && pb && pa === pb) return true;
  for (const t of a._tok) if (b._tok.has(t)) return true;
  return false;
}

// --- pull all eligible rows ---
console.log(`Loading eligible dhash rows… (Hamming<=${N}, max-cluster ${MAX_CLUSTER}, ${APPLY ? 'APPLY' : 'dry-run'})`);
const rows = [];
let off = 0;
for (;;) {
  const page = d1json(
    `SELECT id, photo_dhash, nombre, contacto, descripcion, ubicacion, foto, foto_r2, updated_at, estado, moderation
     FROM personas
     WHERE trim(coalesce(photo_dhash,'')) <> '' AND photo_dhash NOT LIKE 'dead:%'
       AND photo_dhash NOT IN ('0000000000000000','ffffffffffffffff')
     ORDER BY id LIMIT 5000 OFFSET ${off}`);
  if (!page.length) break;
  rows.push(...page); off += page.length;
  process.stdout.write(`\r  loaded ${rows.length}`);
}
console.log(`\n  ${rows.length} rows`);

for (const r of rows) {
  r._hi = parseInt(r.photo_dhash.slice(0, 8), 16) >>> 0;
  r._lo = parseInt(r.photo_dhash.slice(8, 16), 16) >>> 0;
  r._tok = nameTokens(r.nombre);
}

// --- band index → candidate pairs ---
const slices = bandSlices();
const buckets = new Map(); // key `${b}:${substr}` -> [idx...]
rows.forEach((r, i) => {
  slices.forEach(([s, e], b) => {
    const k = b + ':' + r.photo_dhash.slice(s, e);
    let arr = buckets.get(k); if (!arr) buckets.set(k, arr = []); arr.push(i);
  });
});

// --- union-find over corroborated near-matches ---
const parent = rows.map((_, i) => i);
function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }

// No global pair-dedup Set (it overflows at ~16M): union-find is idempotent, so
// re-examining a pair already in the same set is harmless. We early-skip pairs
// already unioned to save the hamming compute.
let pairsHam = 0, pairsCorr = 0;
for (const arr of buckets.values()) {
  if (arr.length < 2 || arr.length > 4000) continue; // skip huge buckets (placeholder-ish bands)
  for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
    const a = arr[i], b = arr[j];
    if (find(a) === find(b)) continue;
    const ra = rows[a], rb = rows[b];
    const h = hamming(ra._hi, ra._lo, rb._hi, rb._lo);
    if (h > N) continue; pairsHam++;
    if (!corroborated(ra, rb)) continue; pairsCorr++;
    union(a, b);
  }
}

// --- assemble clusters ---
const clusters = new Map();
rows.forEach((_, i) => { const root = find(i); let c = clusters.get(root); if (!c) clusters.set(root, c = []); c.push(i); });

let toDelete = [], merged = 0, skippedBig = 0;
const samples = [];
const dumpLines = [];
for (const idxs of clusters.values()) {
  if (idxs.length < 2) continue;
  if (idxs.length > MAX_CLUSTER) { skippedBig++; continue; }
  // keeper = most complete, then has foto_r2, then newest, then smallest id
  const sorted = idxs.map((i) => rows[i]).sort((x, y) =>
    completeness(y) - completeness(x) ||
    ((y.foto_r2 ? 1 : 0) - (x.foto_r2 ? 1 : 0)) ||
    (Number(y.updated_at || 0) - Number(x.updated_at || 0)) ||
    (x.id < y.id ? -1 : 1));
  const keep = sorted[0], drop = sorted.slice(1);
  merged++;
  if (samples.length < 12) samples.push({ keep: keep.nombre, drop: drop.map((d) => d.nombre) });
  for (const d of drop) toDelete.push(d);
  if (DUMP !== null) {
    dumpLines.push(`KEEP  ${keep.id}  dhash=${keep.photo_dhash}  estado=${keep.estado||''}  "${keep.nombre}"`);
    for (const d of drop) dumpLines.push(`  DROP ${d.id}  dhash=${d.photo_dhash}  H=${hamming(keep._hi,keep._lo,d._hi,d._lo)}  estado=${d.estado||''}  "${d.nombre}"  foto=${d.foto||d.foto_r2||''}`);
    dumpLines.push('');
  }
}
if (DUMP !== null) {
  const path = DUMP || join(tmpdir(), `dhash-nearmatch-H${N}.txt`);
  writeFileSync(path, `# dHash near-match merge plan — Hamming<=${N}, max-cluster ${MAX_CLUSTER}\n` +
    `# clusters: ${merged}, rows to delete: ${toDelete.length}, oversized skipped: ${skippedBig}\n\n` + dumpLines.join('\n'));
  console.log(`\nFull merge list written to: ${path}`);
}

console.log(`\nnew pairs within Hamming<=${N}: ${pairsHam} → corroborated (name/phone): ${pairsCorr}`);
console.log(`clusters to merge: ${merged} (rows to delete: ${toDelete.length}); skipped oversized clusters: ${skippedBig}`);
console.log('\nsample merges (keeper ← dropped):');
for (const s of samples) console.log(`  "${s.keep}"  ←  ${s.drop.map((d) => '"' + d + '"').join(', ')}`);

if (!APPLY) { console.log('\nDRY-RUN — no rows deleted. Re-run with --apply to merge.'); process.exit(0); }

// delete the extras (chunked); skip any that are family-edited/located (safety)
const del = toDelete.filter((r) => !/localiz|fallec/i.test(r.estado || '')).map((r) => r.id);
console.log(`\nApplying: deleting ${del.length} rows (${toDelete.length - del.length} kept back as located/edited)…`);
for (let i = 0; i < del.length; i += 200) {
  const chunk = del.slice(i, i + 200);
  d1exec(`DELETE FROM personas WHERE id IN (${chunk.map(qs).join(',')});`);
  process.stdout.write(`\r  deleted ${Math.min(i + 200, del.length)}/${del.length}`);
}
console.log(`\nDONE. merged ${merged} clusters, deleted ${del.length} near-duplicate rows.`);
