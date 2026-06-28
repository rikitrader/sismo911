#!/usr/bin/env node
// SISMO911 — pull the missing-persons (Familia) registry from the public API
// into the DESAP `personas` D1 database.
//
// DEDUPE BY CONSTRUCTION: rows are keyed on the API's own stable id (e.g.
// "p9d9170b99930"), which is also personas.id. The write is an UPSERT
// (INSERT … ON CONFLICT(id) DO UPDATE), so re-running this REFRESHES existing
// rows instead of creating duplicates. moderation + foto_r2 are never touched
// (admin-owned columns); created_at is preserved on conflict.
//
// DRY-RUN BY DEFAULT: fetches + reports new vs. existing and writes NOTHING.
// Pass --apply to upsert into the remote D1.
//
// Usage:
//   node scripts/pull-familia.mjs            # dry-run (counts only)
//   node scripts/pull-familia.mjs --apply    # upsert into remote D1
//
// Env: FAMILIA_SOURCE_URL overrides the default API base.

import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APPLY = process.argv.includes('--apply');
const CLEAN = process.argv.includes('--clean');       // also flag junk + dedupe after pull
const NO_PULL = process.argv.includes('--no-pull');   // clean-only (skip fetching the API)
const BASE = process.env.FAMILIA_SOURCE_URL || 'https://desaparecidos-terremoto-api.theempire.tech/api/personas';
const DB = 'sismo911';   // single source of truth — the DB the live app reads/writes
const PAGE_SIZE = 100;          // API caps pageSize at 100
const STMT_ROWS = 50;           // rows per INSERT statement (D1 has a per-statement size cap)
const STMTS_PER_FILE = 40;      // → 2000 rows per wrangler execute file

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const nz = (v) => (v == null || v === '' ? 'NULL' : null);
const txt = (v) => nz(v) ?? q(String(v));      // nullable text → NULL when empty
const txtNN = (v) => q(String(v ?? ''));        // NOT NULL text → '' when empty
const int = (v) => { if (v == null || v === '') return 'NULL'; const n = Number(v); return Number.isFinite(n) ? String(Math.trunc(n)) : 'NULL'; };

function mapEstado(v) {
  const s = String(v ?? '').toLowerCase();
  if (/localiz|encontrad|safe|a salvo|vivo/.test(s)) return 'localizado';
  if (/fallec|muert|decease|dead/.test(s)) return 'fallecido';
  return 'sin-contacto';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE_DELAY = 350;   // polite gap between page fetches (ms)

async function getPage(page) {
  const url = `${BASE}?page=${page}&pageSize=${PAGE_SIZE}`;
  for (let attempt = 1; attempt <= 7; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (res.status === 429) { await sleep(Math.min(2000 * attempt, 12000)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt === 7) throw e;
      await sleep(Math.min(1000 * attempt, 8000));
    }
  }
  throw new Error(`page ${page}: exhausted retries`);
}

function d1File(sqlText) {
  const dir = mkdtempSync(join(tmpdir(), 'familia-'));
  const f = join(dir, 'batch.sql');
  writeFileSync(f, sqlText);
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;   // force gmail OAuth wrangler session
  delete env.CLOUDFLARE_ACCOUNT_ID;
  execSync(`npx wrangler d1 execute ${DB} --remote --file=${JSON.stringify(f)}`, {
    encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
}

function d1Query(sql) {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_ACCOUNT_ID;
  const out = execSync(`npx wrangler d1 execute ${DB} --remote --json --command ${JSON.stringify(sql)}`, {
    encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
  });
  const j = JSON.parse(out);
  return (Array.isArray(j) ? j[0] : j)?.results ?? [];
}

const COLS = [
  'id', 'nombre', 'edad', 'ubicacion', 'fecha', 'descripcion', 'contacto', 'foto', 'estado',
  'localizado_por', 'localizado_contacto', 'localizado_relacion', 'localizado_nota',
  'reportada', 'reportes', 'reportada_at', 'created_at', 'updated_at', 'pulled_at',
];
// On conflict refresh bio fields only. NEVER overwrite app-owned status columns —
// estado / localizado_* / reportada* are set by families through the live app and
// the upstream scrape doesn't know about them; refreshing them would revert real
// "found safe / deceased" reports. (moderation + foto_r2 are also app-owned and
// aren't in COLS, so they're already preserved; id + created_at stay too.)
const APP_OWNED = new Set([
  'id', 'created_at',
  'estado', 'localizado_por', 'localizado_contacto', 'localizado_relacion',
  'localizado_nota', 'reportada', 'reportada_at',
]);
const UPDATE_SET = COLS.filter((c) => !APP_OWNED.has(c))
  .map((c) => `${c}=excluded.${c}`).join(', ');

function rowValues(o, nowIso) {
  return '(' + [
    txtNN(o.id), txtNN(String(o.nombre ?? '').slice(0, 120)), int(o.edad),
    txtNN(String(o.ubicacion ?? '').slice(0, 200)), txt(o.fecha), txtNN(String(o.descripcion ?? '').slice(0, 2000)),
    txtNN(String(o.contacto ?? '').slice(0, 80)), txtNN(String(o.foto ?? '').slice(0, 500)), q(mapEstado(o.estado)),
    txt(o.localizadoPor), txt(o.localizadoContacto), txt(o.localizadoRelacion), txt(o.localizadoNota),
    o.reportada ? '1' : '0', int(o.reportes), int(o.reportadaAt),
    int(o.createdAt), int(o.updatedAt), q(nowIso),
  ].join(',') + ')';
}

// ---- cleaning: junk/fake flag + name/photo/exact dedupe (mirrors src/lib) ----
const JUNK_NAMES = ['test', 'testing', 'prueba', 'pruebas', 'asdf', 'asdfgh', 'qwerty', 'abc', 'abcd',
  'nombre', 'sin nombre', 'desconocido', 'desconocida', 'n/a', 'na', 'none', 'null',
  'xxx', 'xxxx', 'aaa', 'aaaa', 'ninguno', 'ninguna', '.', '..', '...', '-', '--'];
function junkWhere(col = 'nombre') {
  const list = JUNK_NAMES.map((n) => "'" + n.replace(/'/g, "''") + "'").join(', ');
  return [
    `trim(${col}) = ''`,
    `length(trim(${col})) < 3`,
    `${col} NOT GLOB '*[A-Za-zÀ-ÿ]*'`,
    `lower(trim(${col})) IN (${list})`,
    `length(replace(trim(${col}), substr(trim(${col}), 1, 1), '')) = 0`,
  ].map((c) => `(${c})`).join(' OR ');
}
// keeper: row WITH foto_r2, then most-recent, then smallest id. Dedupe deletes
// only the extras (rows w/o foto_r2 win-loss → no orphaned R2 objects).
const DEDUPE = {
  exact: { part: `lower(trim(nombre)), coalesce(edad,-1), lower(trim(coalesce(ubicacion,''))), lower(trim(coalesce(descripcion,''))), lower(trim(coalesce(contacto,'')))`, scope: '' },
  photo: { part: `lower(trim(foto))`, scope: `WHERE trim(coalesce(foto,'')) != ''` },
  name:  { part: `lower(trim(nombre)), lower(trim(coalesce(ubicacion,'')))`, scope: '' },
};
function dupCount(mode) {
  const d = DEDUPE[mode];
  return d1Query(`SELECT COUNT(*) AS n FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY ${d.part} ORDER BY (CASE WHEN foto_r2 IS NOT NULL THEN 0 ELSE 1 END), updated_at DESC, id ASC) rn FROM personas ${d.scope}) WHERE rn > 1`)[0]?.n ?? 0;
}
function dedupeApply(mode) {
  const d = DEDUPE[mode];
  d1File(`DELETE FROM personas WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY ${d.part} ORDER BY (CASE WHEN foto_r2 IS NOT NULL THEN 0 ELSE 1 END), updated_at DESC, id ASC) rn FROM personas ${d.scope}) WHERE rn > 1);`);
}
function runClean() {
  console.log(`\n${'='.repeat(64)}\nCLEAN — ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  const junk = d1Query(`SELECT COUNT(*) AS n FROM personas WHERE moderation='approved' AND (${junkWhere()})`)[0]?.n ?? 0;
  console.log(`  junk/fake names (→reject): ${junk}`);
  if (APPLY && junk) d1File(`UPDATE personas SET moderation='rejected' WHERE moderation='approved' AND (${junkWhere()});`);
  for (const mode of ['exact', 'photo', 'name']) {
    const n = dupCount(mode);
    const auto = mode !== 'name';   // name (namesakes) is reported but not auto-applied
    console.log(`  dup [${mode}]: ${n}${auto ? '' : '  (review-only — not auto-deleted)'}`);
    if (APPLY && auto && n) dedupeApply(mode);
  }
  // String/byte modes above can't catch the same person re-submitted with a
  // different name spelling / age typo / re-cropped photo — only the FACE is
  // invariant. scripts/face-embed-local.py + face-cluster.mjs propose those into
  // dup_cluster; an operator vets each at /admin/dup-review. Surface the backlog
  // here so a pull never silently leaves face-duplicates unreviewed. (dup_cluster
  // may not exist on a DB that predates migration 0050 — degrade gracefully.)
  try {
    const fp = d1Query(`SELECT COUNT(DISTINCT cluster_id) AS c, COUNT(*) AS n FROM dup_cluster WHERE status='pending' AND method='face'`)[0] ?? { c: 0, n: 0 };
    const noVec = d1Query(`SELECT COUNT(*) AS n FROM personas WHERE moderation='approved' AND photo_face_vec IS NULL AND (trim(coalesce(foto,''))<>'' OR trim(coalesce(foto_r2,''))<>'')`)[0]?.n ?? 0;
    console.log(`  face-clusters pending review: ${fp.c} (${fp.n} records)  → /admin/dup-review  (review-only — never auto-merged)`);
    if (noVec) console.log(`  photos awaiting face-embedding: ${noVec}  → run scripts/face-embed-local.py then face-cluster.mjs`);
  } catch { /* pre-0050 schema: face vetting not provisioned yet */ }
  if (APPLY) {
    const pk = d1Query(`SELECT COUNT(*) AS g FROM (SELECT id FROM personas GROUP BY id HAVING COUNT(*)>1)`)[0]?.g ?? 0;
    const live = d1Query(`SELECT COUNT(*) AS n FROM personas WHERE moderation='approved'`)[0]?.n ?? 0;
    console.log(`  ✓ cleaned. live(approved)=${live}, PK-dup id groups=${pk} (must be 0).`);
  } else {
    console.log('  Re-run with --apply to clean.');
  }
}

(async () => {
  console.log(`\nSISMO911 Familia pull — ${APPLY ? 'APPLY (upserting)' : 'DRY-RUN (no writes)'}`);
  console.log(`Source: ${BASE}\n${'='.repeat(64)}`);

  if (NO_PULL) {
    console.log('--no-pull: skipping fetch, cleaning existing DB only.');
    runClean();
    return;
  }

  const first = await getPage(1);
  const total = first.total ?? 0;
  const totalPages = first.totalPages ?? Math.ceil((first.items?.length ?? 0) / PAGE_SIZE);
  console.log(`API reports ${total} records across ${totalPages} pages (pageSize ${PAGE_SIZE}).`);

  const items = [...(first.items ?? [])];
  for (let p = 2; p <= totalPages; p++) {
    await sleep(PAGE_DELAY);
    const j = await getPage(p);
    if (j?.items?.length) items.push(...j.items);
    if (p % 25 === 0 || p === totalPages) process.stdout.write(`  fetched page ${p}/${totalPages} (${items.length} rows)\r`);
  }
  console.log(`\nFetched ${items.length} records.`);

  // De-dupe within the API payload itself (by id), keeping the last seen.
  const byId = new Map();
  for (const it of items) if (it?.id) byId.set(it.id, it);
  const rows = [...byId.values()];
  if (rows.length !== items.length) console.log(`  (collapsed ${items.length - rows.length} in-payload id duplicates)`);

  const before = d1Query('SELECT COUNT(*) AS n FROM personas')[0]?.n ?? 0;
  console.log(`DB currently holds ${before} rows.`);

  if (!APPLY) {
    console.log(`\nDRY-RUN: would upsert ${rows.length} rows (≈${Math.max(0, rows.length - before)} new + refresh of existing).`);
    console.log('Re-run with --apply to write. Keyed on personas.id → no duplicates possible.');
    if (CLEAN) runClean();
    return;
  }

  const nowIso = new Date().toISOString();
  const upsert = (chunk) =>
    `INSERT INTO personas (${COLS.join(', ')}) VALUES\n` +
    chunk.map((o) => rowValues(o, nowIso)).join(',\n') +
    `\nON CONFLICT(id) DO UPDATE SET ${UPDATE_SET};`;
  const FILE_ROWS = STMT_ROWS * STMTS_PER_FILE;
  let written = 0;
  for (let i = 0; i < rows.length; i += FILE_ROWS) {
    const fileRows = rows.slice(i, i + FILE_ROWS);
    const stmts = [];
    for (let j = 0; j < fileRows.length; j += STMT_ROWS) stmts.push(upsert(fileRows.slice(j, j + STMT_ROWS)));
    d1File(stmts.join('\n'));
    written += fileRows.length;
    process.stdout.write(`  upserted ${written}/${rows.length}\r`);
  }

  const after = d1Query('SELECT COUNT(*) AS n FROM personas')[0]?.n ?? 0;
  const dupGroups = d1Query(
    `SELECT COUNT(*) AS g FROM (SELECT id FROM personas GROUP BY id HAVING COUNT(*) > 1)`
  )[0]?.g ?? 0;
  console.log(`\n\nDone. Upserted ${written} rows. DB: ${before} → ${after} (${after - before} net new).`);
  console.log(`PK-duplicate id groups: ${dupGroups} (must be 0).`);

  if (CLEAN) runClean();
})().catch((e) => { console.error('\nFAILED:', e?.message ?? e); process.exit(1); });
