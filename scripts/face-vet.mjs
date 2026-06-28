#!/usr/bin/env node
// SISMO911 — vet suspected duplicate missing-person records by FACE, on demand.
//
// The full embedding backfill is intentionally NOT run as a bulk job; instead we
// embed + cluster a TARGETED slice the moment a duplicate is suspected (a name
// that looks re-submitted, or a specific set of ids). This wrapper does the whole
// pipeline in one command:
//   1. resolve the personas to vet (by name substring, or explicit --ids)
//   2. embed only the ones missing a face vector (local InsightFace, idempotent)
//   3. re-cluster the embedded set into the dup_cluster review queue (APPLY)
//   4. print the cluster + the /admin/dup-review link
//
// Usage (unset CF tokens first so wrangler uses the gmail OAuth session):
//   unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
//   node scripts/face-vet.mjs "anaileth veliz"      # vet everyone matching this name
//   node scripts/face-vet.mjs --ids p9d9..,pf94..   # vet these specific records
//   node scripts/face-vet.mjs "anaileth" --no-cluster  # embed only, skip clustering

import { execSync, spawnSync } from 'node:child_process';

const DB = 'sismo911';
const ENV = { ...process.env };
delete ENV.CLOUDFLARE_API_TOKEN;     // force gmail OAuth wrangler session
delete ENV.CLOUDFLARE_ACCOUNT_ID;

const args = process.argv.slice(2);
const NO_CLUSTER = args.includes('--no-cluster');
const idsFlag = args.indexOf('--ids');
let ids = [];
let nameQuery = '';
if (idsFlag !== -1 && args[idsFlag + 1]) {
  ids = args[idsFlag + 1].split(',').map((s) => s.trim()).filter(Boolean);
} else {
  nameQuery = args.filter((a) => !a.startsWith('--')).join(' ').trim();
}
if (!ids.length && !nameQuery) {
  console.error('Usage: node scripts/face-vet.mjs "<name>"  |  --ids id1,id2  [--no-cluster]');
  process.exit(1);
}

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
function d1Json(sql) {
  const oneLine = sql.replace(/\s+/g, ' ').trim();   // newlines → Error 7500 via --command
  const out = execSync(`npx wrangler d1 execute ${DB} --remote --json --command ${JSON.stringify(oneLine)}`,
    { encoding: 'utf8', env: ENV, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  const j = JSON.parse(out);
  return (Array.isArray(j) ? j[0] : j)?.results ?? [];
}

// 1. Resolve the records to vet.
let where;
if (ids.length) {
  where = `id IN (${ids.map(q).join(',')})`;
} else {
  // accent-insensitive-ish: match the raw substring; operators type what they see.
  where = `lower(nombre) LIKE ${q('%' + nameQuery.toLowerCase() + '%')} AND moderation='approved'`;
}
const rows = d1Json(
  `SELECT id, nombre, edad,
          CASE WHEN photo_face_vec IS NULL THEN 1 ELSE 0 END AS need,
          CASE WHEN trim(coalesce(foto,''))<>'' OR trim(coalesce(foto_r2,''))<>'' THEN 1 ELSE 0 END AS hasphoto
     FROM personas WHERE ${where}`);

if (!rows.length) { console.log(`No personas match ${ids.length ? 'those ids' : `"${nameQuery}"`}.`); process.exit(0); }

const needIds = rows.filter((r) => r.need && r.hasphoto).map((r) => r.id);
console.log(`Matched ${rows.length} record(s); ${rows.filter((r) => !r.need).length} already embedded, ` +
  `${needIds.length} need embedding, ${rows.filter((r) => r.need && !r.hasphoto).length} have no photo.`);
for (const r of rows) console.log(`  ${r.need ? '·' : '✓'} ${r.id}  ${String(r.nombre).slice(0, 40)}  (edad ${r.edad ?? '-'})`);

// 2. Embed only the missing ones (local InsightFace; idempotent).
if (needIds.length) {
  console.log(`\nEmbedding ${needIds.length} photo(s) with InsightFace…`);
  const r = spawnSync('uv', ['run', 'scripts/face-embed-local.py'],
    { env: { ...ENV, IDS: needIds.join(',') }, stdio: 'inherit' });
  if (r.status !== 0) { console.error('Embedding failed.'); process.exit(1); }
} else {
  console.log('\nAll matched records already embedded — nothing to embed.');
}

// 3. Re-cluster the embedded set into the review queue.
if (NO_CLUSTER) { console.log('\n--no-cluster: skipping clustering.'); process.exit(0); }
console.log('\nClustering by face → dup_cluster (review queue)…');
const c = spawnSync('node', ['scripts/face-cluster.mjs'], { env: { ...ENV, APPLY: '1' }, stdio: 'inherit' });
if (c.status !== 0) { console.error('Clustering failed.'); process.exit(1); }

console.log('\n✓ Done. Vet the proposed merges at https://sismo911.com/admin/dup-review');
