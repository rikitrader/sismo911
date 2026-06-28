#!/usr/bin/env node
// SISMO911 — cluster personas by FACE into the dup_cluster review queue.
//
// face-embed-local.py writes a 512-d L2-normalised ArcFace embedding per photo
// (personas.photo_face_vec, base64 float32). Because the vectors are unit-norm,
// cosine similarity == dot product. This loads every APPROVED, un-merged embedding,
// unions personas whose faces match above THRESH, and writes each multi-member
// cluster as 'pending' rows in dup_cluster for an operator to vet & merge.
//
// SAFETY: this NEVER deletes or merges anything — these are missing-person records
// where a wrong auto-merge is catastrophic. It only proposes. The operator decides
// in /admin/dup-review. Decisions are sticky: personas already in a 'merged' or
// 'dismissed' cluster row are excluded so a vetted verdict is never re-surfaced.
//
// Idempotent: clears existing 'pending' face rows and rewrites from current data.
//
// Usage: unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID && node scripts/face-cluster.mjs
//   THRESH=0.45  cosine threshold to link two faces (review-only → can be generous)
//   APPLY=1      write to D1 (default: dry-run, prints proposed clusters only)

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB = 'sismo911';
const THRESH = Number(process.env.THRESH) || 0.45;
const APPLY = process.env.APPLY === '1';
const DIM = 512;

const ENV = { ...process.env };
delete ENV.CLOUDFLARE_API_TOKEN;
delete ENV.CLOUDFLARE_ACCOUNT_ID;

function d1Json(sql) {
  // Collapse whitespace: JSON.stringify turns embedded newlines into literal "\n"
  // which the shell passes through to SQLite as a backslash token (Error 7500).
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  const out = execSync(`npx wrangler d1 execute ${DB} --remote --json --command ${JSON.stringify(oneLine)}`,
    { encoding: 'utf8', env: ENV, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  const j = JSON.parse(out);
  return (Array.isArray(j) ? j[0] : j)?.results ?? [];
}
function d1File(sqlText) {
  const f = join(tmpdir(), `face-cluster-${Date.now()}.sql`);
  writeFileSync(f, sqlText);
  execSync(`npx wrangler d1 execute ${DB} --remote --file=${JSON.stringify(f)}`,
    { encoding: 'utf8', env: ENV, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

function decodeVec(b64) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== DIM * 4) return null;             // not a real embedding (sentinel)
  return new Float32Array(buf.buffer, buf.byteOffset, DIM);
}
const dot = (a, b) => { let s = 0; for (let i = 0; i < DIM; i++) s += a[i] * b[i]; return s; };

// completeness: prefer the record that has a self-hosted photo + the most filled
// fields, then the oldest (smallest id) as a stable tiebreak. That row becomes the
// suggested keeper (anchor) operators merge the others into.
function completeness(r) {
  return (r.foto_r2 ? 8 : 0)
    + (r.descripcion ? 2 : 0) + (r.contacto ? 2 : 0)
    + (r.edad != null ? 1 : 0) + (r.ubicacion ? 1 : 0);
}

(async () => {
  console.log(`Face clustering — THRESH=${THRESH} — ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  // Personas already vetted (merged loser, or any merged/dismissed cluster member)
  // are excluded so a human verdict is never re-proposed.
  const resolved = new Set(
    d1Json(`SELECT DISTINCT persona_id AS id FROM dup_cluster WHERE status IN ('merged','dismissed')`).map((r) => r.id));

  const rows = d1Json(
    `SELECT id, nombre, edad, ubicacion, descripcion, contacto, foto_r2, photo_face_vec
       FROM personas
      WHERE moderation='approved' AND merged_into IS NULL
        AND photo_face_vec IS NOT NULL AND length(photo_face_vec) > 2000`);

  const people = [];
  for (const r of rows) {
    if (resolved.has(r.id)) continue;
    const v = decodeVec(r.photo_face_vec);
    if (v) people.push({ ...r, v });
  }
  console.log(`Loaded ${people.length} approved face vectors (excluded ${resolved.size} already-vetted).`);

  // Union-find over all pairs above threshold. O(n²) dot products — fine for the
  // approved registry (thousands). Move to Vectorize/ANN if the live set explodes.
  const parent = people.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      if (dot(people[i].v, people[j].v) >= THRESH) union(i, j);
    }
  }

  const groups = new Map();
  for (let i = 0; i < people.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }

  const now = Date.now();
  const stmts = [];
  let clusters = 0, dups = 0;
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    clusters++;
    const members = idxs.map((i) => people[i]);
    members.sort((a, b) => completeness(b) - completeness(a) || String(a.id).localeCompare(String(b.id)));
    const anchor = members[0];
    const clusterId = 'fc-' + [...members].map((m) => m.id).sort()[0];
    console.log(`\n  cluster ${clusterId} (${members.length}):`);
    for (const m of members) {
      const score = m === anchor ? 1 : Math.round(dot(m.v, anchor.v) * 1000) / 1000;
      console.log(`    ${m === anchor ? '★' : ' '} ${m.id}  ${String(m.nombre).slice(0, 28).padEnd(28)} ` +
        `edad=${m.edad ?? '-'}  cos=${score}  ${m.ubicacion ? String(m.ubicacion).slice(0, 30) : ''}`);
      stmts.push(
        `INSERT OR REPLACE INTO dup_cluster (cluster_id, persona_id, score, method, anchor, status, created_at) ` +
        `VALUES (${q(clusterId)}, ${q(m.id)}, ${score}, 'face', ${m === anchor ? 1 : 0}, 'pending', ${now});`);
      if (m !== anchor) dups++;
    }
  }

  console.log(`\n${clusters} clusters covering ${dups} likely-duplicate records.`);
  if (!APPLY) { console.log('DRY-RUN — re-run with APPLY=1 to write to dup_cluster.'); return; }

  d1File(`DELETE FROM dup_cluster WHERE method='face' AND status='pending';`);
  for (let i = 0; i < stmts.length; i += 200) d1File(stmts.slice(i, i + 200).join('\n'));
  console.log(`✓ wrote ${stmts.length} dup_cluster rows (pending). Vet them at /admin/dup-review.`);
})();
