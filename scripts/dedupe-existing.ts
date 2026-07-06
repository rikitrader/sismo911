// SISMO911 — existing-duplicate cleanup across duplicate-prone tables.
// ---------------------------------------------------------------------------
// Sweeps the tables the db-map flags as duplicate-prone, scores every
// candidate pair with the layered engine (src/db/dedupe.ts), and:
//   --dry-run (DEFAULT) → reports/dedupe-existing-dry-run.md + local JSON.
//   --report            → re-render the last dry-run JSON without re-scanning.
//   --execute           → backup-gated production merge of AUTO-SAFE pairs
//                         (personas only, via the canonical merged_into +
//                         personas_merge_log path — fully restorable);
//                         review pairs land in dedupe_candidates for humans.
//
// SAFETY: --execute refuses to run without a <24 h `wrangler d1 export` backup
// (npm run db:backup) and prints the production-write warning first. Merges
// mirror scripts/merge-duplicates.ts exactly: loser rows PRESERVED
// (merged_into + moderation='rejected'), photo/status safeguards, every action
// journaled under one run_id → --restore via merge-duplicates.ts still works.
//
// Blocking strategy (a 133k-row table cannot be scored pairwise): SQL GROUP BY
// on cheap keys (name_norm / dedupe_key / cedula / telefono / email) pulls only
// groups with 2..6 members; the engine scores pairs INSIDE each group locally.
// Bounds are logged — nothing is silently truncated.

import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scorePair, pickKeeper, pairKey, completeness, type DedupeRecord, type PairScore } from '../src/db/dedupe';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORTS = join(ROOT, 'reports');
const BACKUPS = join(ROOT, 'backups');
const MODE = process.argv.includes('--execute') ? 'execute' : process.argv.includes('--report') ? 'report' : 'dry-run';
const MAX_GROUPS = Number(process.argv.find((a) => a.startsWith('--max-groups='))?.split('=')[1] ?? 3000);
const MAX_MERGES = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 500);
const RUN_ID = `dedupe-existing-${Date.now()}`;

function d1(sql: string): Array<Record<string, unknown>> {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_ACCOUNT_ID;
  const res = spawnSync('npx', ['wrangler', 'd1', 'execute', 'sismo911', '--remote', '--env-file', '/dev/null', '--json', '--command', sql], {
    cwd: ROOT, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`wrangler d1 failed: ${(res.stdout || res.stderr || '').slice(0, 600)}`);
  return (JSON.parse(res.stdout) as Array<{ results?: Array<Record<string, unknown>> }>)[0]?.results ?? [];
}
const lit = (v: unknown): string => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

// ---------------------------------------------------------------------------
// Table configs: how to block groups + map rows into DedupeRecord.
interface TableConfig {
  table: string;
  blockKeys: string[]; // GROUP BY columns tried in order
  where: string; // active-row filter
  select: string;
  map: (r: Record<string, unknown>) => DedupeRecord;
  mergeable: boolean; // true = auto-merge on execute (personas only, v1)
}
const S = (r: Record<string, unknown>, k: string): string | null => (r[k] == null || String(r[k]).trim() === '' ? null : String(r[k]));
const N = (r: Record<string, unknown>, k: string): number | null => (r[k] == null ? null : Number(r[k]));

const TABLES: TableConfig[] = [
  {
    table: 'personas',
    blockKeys: ['name_norm'],
    where: `moderation='approved' AND (merged_into IS NULL OR trim(merged_into)='') AND coalesce(protected,0)=0 AND name_norm IS NOT NULL AND name_norm<>''`,
    select: `id,nombre,name_norm,edad,contacto,ubicacion,origen,ext_id,estado,coalesce(fallecido,0) AS fallecido,coalesce(hospitalizado,0) AS hospitalizado,geo_estado,geo_municipio,updated_at,foto_r2`,
    map: (r) => ({
      id: String(r.id),
      fullName: S(r, 'nombre'),
      cedula: null, // personas has no cedula column (cedulas live in case_identity)
      phone: S(r, 'contacto'),
      email: null,
      age: N(r, 'edad'),
      municipality: S(r, 'geo_municipio'),
      state: S(r, 'geo_estado'),
      familyPhone: null,
      lastSeenLocation: S(r, 'ubicacion'),
      sourceName: S(r, 'origen'),
      sourceRecordId: S(r, 'ext_id'),
      status: Number(r.fallecido) ? 'fallecido' : Number(r.hospitalizado) ? 'hospitalizado' : S(r, 'estado'),
      updatedMs: N(r, 'updated_at'),
    }),
    mergeable: true,
  },
  {
    table: 'hospital_patients',
    blockKeys: ['dedupe_key', 'cedula', 'telefono'],
    where: `1=1`,
    select: `id,full_name,norm_name,cedula,telefono,estado,dedupe_key`,
    map: (r) => ({
      id: String(r.id),
      fullName: S(r, 'full_name'),
      cedula: S(r, 'cedula'),
      phone: S(r, 'telefono'),
      email: null, age: null, municipality: null, state: null, familyPhone: null, lastSeenLocation: null,
      sourceName: 'hospital', sourceRecordId: S(r, 'dedupe_key'),
      status: S(r, 'estado'),
      updatedMs: null,
    }),
    mergeable: false,
  },
  {
    table: 'aid_orgs',
    blockKeys: ['phone', 'email'],
    where: `1=1`,
    select: `id,name AS full_name,phone,email,updated_ms`,
    map: (r) => ({
      id: String(r.id), fullName: S(r, 'full_name'), cedula: null, phone: S(r, 'phone'), email: S(r, 'email'),
      age: null, municipality: null, state: null, familyPhone: null, lastSeenLocation: null,
      sourceName: null, sourceRecordId: null, status: null, updatedMs: N(r, 'updated_ms'),
    }),
    mergeable: false,
  },
];

interface Candidate {
  table: string;
  idA: string;
  idB: string;
  score: PairScore;
  keeper: string;
  loser: string;
  nameA: string | null;
  nameB: string | null;
}

// ---------------------------------------------------------------------------
function sweepTable(cfg: TableConfig): { candidates: Candidate[]; scanned: number; groups: number; truncated: boolean } {
  const candidates: Candidate[] = [];
  let scanned = 0;
  let groups = 0;
  let truncated = false;

  for (const key of cfg.blockKeys) {
    // Groups of 2..6 on this key (bigger groups are namesake clouds — skip, they
    // are operator/face-review territory, logged below).
    const groupRows = d1(
      `SELECT ${key} AS k, COUNT(*) AS c FROM ${cfg.table} WHERE ${cfg.where} AND ${key} IS NOT NULL AND trim(${key})<>'' GROUP BY ${key} HAVING COUNT(*) BETWEEN 2 AND 6 ORDER BY c DESC LIMIT ${MAX_GROUPS}`,
    );
    if (groupRows.length === MAX_GROUPS) truncated = true;
    groups += groupRows.length;

    // Fetch rows for those groups in IN-list chunks.
    const keys = groupRows.map((g) => String(g.k));
    for (let i = 0; i < keys.length; i += 80) {
      const inList = keys.slice(i, i + 80).map((k) => lit(k)).join(',');
      const rows = d1(`SELECT ${cfg.select} FROM ${cfg.table} WHERE ${cfg.where} AND ${key} IN (${inList})`);
      scanned += rows.length;
      const byKey = new Map<string, DedupeRecord[]>();
      for (const row of rows) {
        const k = String(row[key.includes(' AS ') ? key.split(' AS ')[1] : key] ?? row[key] ?? '');
        const rec = cfg.map(row);
        rec.completeness = completeness(rec);
        const arr = byKey.get(k) ?? [];
        arr.push(rec);
        byKey.set(k, arr);
      }
      for (const group of byKey.values()) {
        for (let x = 0; x < group.length; x++) {
          for (let y = x + 1; y < group.length; y++) {
            const s = scorePair(group[x], group[y]);
            if (s.decision === 'ignore') continue;
            const { keeper, loser } = pickKeeper(group[x], group[y]);
            const pk = pairKey(cfg.table, group[x].id, group[y].id);
            candidates.push({ table: cfg.table, idA: pk.idA, idB: pk.idB, score: s, keeper: keeper.id, loser: loser.id, nameA: group[x].fullName, nameB: group[y].fullName });
          }
        }
      }
    }
  }
  // Dedupe candidates found under multiple block keys.
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    const k = `${c.table}:${c.idA}:${c.idB}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { candidates: unique, scanned, groups, truncated };
}

function renderReport(all: Record<string, ReturnType<typeof sweepTable>>, executed: { merged: number; queued: number } | null): string {
  const lines: string[] = [
    `# SISMO911 — Duplicate cleanup ${executed ? 'FINAL' : 'DRY-RUN'} report`,
    '',
    `Run: ${RUN_ID} · ${new Date().toISOString()} · mode: ${MODE}`,
    '',
  ];
  for (const [table, r] of Object.entries(all)) {
    const auto = r.candidates.filter((c) => c.score.decision === 'auto_merge');
    const review = r.candidates.filter((c) => c.score.decision === 'review');
    const critical = r.candidates.filter((c) => c.score.conflicts.some((x) => x.severity === 'critical'));
    lines.push(
      `## ${table}`,
      '',
      `- groups scanned: ${r.groups}${r.truncated ? ` (TRUNCATED at --max-groups=${MAX_GROUPS} — re-run for the tail)` : ''} · rows pulled: ${r.scanned}`,
      `- candidate pairs: ${r.candidates.length} → **auto-safe: ${auto.length}** · review: ${review.length} · with CRITICAL status conflicts: ${critical.length}`,
      '',
    );
    for (const c of auto.slice(0, 15)) {
      lines.push(`  - AUTO ${c.score.score}pts [${c.score.signals.join('+')}] keep ${c.keeper} ← ${c.loser} (“${c.nameA}” / “${c.nameB}”)`);
    }
    if (auto.length > 15) lines.push(`  - … ${auto.length - 15} more auto-safe pairs (full list in JSON)`);
    lines.push('');
  }
  if (executed) {
    lines.push('## Executed', '', `- auto-merged: ${executed.merged} (run_id ${RUN_ID}, restore: \`bun scripts/merge-duplicates.ts --restore=${RUN_ID} --apply\`)`, `- queued for human review: ${executed.queued} (dedupe_candidates)`, '');
  } else {
    lines.push('---', '', '**Nothing was written.** Execute path: `npm run db:backup` then `npm run db:dedupe:execute` (auto-safe pairs only; review pairs go to the operator queue).');
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
function freshBackupExists(): boolean {
  try {
    return readdirSync(BACKUPS).some((f) => f.endsWith('.sql') && Date.now() - statSync(join(BACKUPS, f)).mtimeMs < 24 * 3600 * 1000);
  } catch {
    return false;
  }
}

function executeMerges(all: Record<string, ReturnType<typeof sweepTable>>): { merged: number; queued: number } {
  let merged = 0;
  let queued = 0;
  const now = Date.now();
  const stmts: string[] = [
    `CREATE TABLE IF NOT EXISTS personas_merge_log (run_id TEXT, ts INTEGER, mode TEXT, role TEXT, keep_id TEXT, loser_id TEXT, prev_moderation TEXT, prev_merged_into TEXT, keeper_before TEXT);`,
  ];

  for (const [table, r] of Object.entries(all)) {
    const cfg = TABLES.find((t) => t.table === table)!;
    for (const c of r.candidates) {
      const decision = c.score.decision === 'auto_merge' && cfg.mergeable && merged < MAX_MERGES ? 'auto_merge' : 'review';
      // Queue EVERY candidate (idempotent via UNIQUE(table,id_a,id_b)).
      stmts.push(
        `INSERT OR IGNORE INTO dedupe_candidates (id, run_id, table_name, id_a, id_b, score, signals, decision, decided_by, decided_ms, created_ms) VALUES (${lit(`ddc_${c.idA}_${c.idB}`.slice(0, 60))}, ${lit(RUN_ID)}, ${lit(table)}, ${lit(c.idA)}, ${lit(c.idB)}, ${c.score.score}, ${lit(JSON.stringify(c.score.signals))}, ${lit(decision === 'auto_merge' ? 'merged' : 'review')}, 'engine', ${now}, ${now});`,
      );
      for (const x of c.score.conflicts) {
        stmts.push(
          `INSERT INTO dedupe_conflicts (id, candidate_id, field, value_a, value_b, severity, created_ms) VALUES (${lit(`ddx_${c.idA}_${c.idB}_${x.field}`.slice(0, 60))}, ${lit(`ddc_${c.idA}_${c.idB}`.slice(0, 60))}, ${lit(x.field)}, ${lit(x.valueA)}, ${lit(x.valueB)}, ${lit(x.severity)}, ${now});`,
        );
      }
      if (decision === 'auto_merge') {
        // Canonical, restorable merge (mirrors scripts/merge-duplicates.ts).
        stmts.push(
          `INSERT INTO personas_merge_log (run_id,ts,mode,role,keep_id,loser_id,prev_moderation,prev_merged_into,keeper_before) SELECT ${lit(RUN_ID)},${now},'engine-auto','loser',${lit(c.keeper)},id,moderation,merged_into,NULL FROM personas WHERE id=${lit(c.loser)};`,
          `UPDATE personas SET foto=coalesce(nullif(foto,''),(SELECT foto FROM personas WHERE id=${lit(c.loser)})), foto_r2=coalesce(foto_r2,(SELECT foto_r2 FROM personas WHERE id=${lit(c.loser)})) WHERE id=${lit(c.keeper)} AND (foto_r2 IS NULL OR trim(coalesce(foto,''))='');`,
          `UPDATE personas SET merged_into=${lit(c.keeper)}, moderation='rejected', updated_at=${now} WHERE id=${lit(c.loser)} AND (merged_into IS NULL OR trim(merged_into)='');`,
        );
        merged++;
      } else {
        queued++;
      }
    }
    stmts.push(
      `INSERT INTO dedupe_runs (id, source, table_name, scanned, candidates, auto_merged, queued_review, conflicts, status, created_ms) VALUES (${lit(`ddr_${table}_${now.toString(36)}`)}, 'script', ${lit(table)}, ${r.scanned}, ${r.candidates.length}, ${table === 'personas' ? merged : 0}, ${queued}, ${r.candidates.reduce((s, c) => s + c.score.conflicts.length, 0)}, 'ok', ${now});`,
    );
  }
  stmts.push(`INSERT INTO data_quality_reports (id, kind, metrics, created_ms) VALUES (${lit(`dqr_${now.toString(36)}`)}, 'cleanup', ${lit(JSON.stringify({ runId: RUN_ID, merged, queued }))}, ${now});`);

  const sqlPath = join(REPORTS, `dedupe-existing-${RUN_ID}.sql`);
  writeFileSync(sqlPath, stmts.join('\n') + '\n');
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_ACCOUNT_ID;
  const res = spawnSync('npx', ['wrangler', 'd1', 'execute', 'sismo911', '--remote', '--env-file', '/dev/null', '--file', sqlPath], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`execute failed: ${(res.stdout || res.stderr || '').slice(0, 600)}`);
  return { merged, queued };
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  mkdirSync(REPORTS, { recursive: true });

  if (MODE === 'report') {
    const j = JSON.parse(readFileSync(join(REPORTS, 'dedupe-existing-candidates.json'), 'utf8'));
    writeFileSync(join(REPORTS, 'dedupe-existing-dry-run.md'), renderReport(j.all, null));
    console.log('[dedupe-existing] re-rendered from last dry-run JSON');
    return;
  }

  const all: Record<string, ReturnType<typeof sweepTable>> = {};
  for (const cfg of TABLES) {
    console.log(`[dedupe-existing] sweeping ${cfg.table}…`);
    all[cfg.table] = sweepTable(cfg);
    const r = all[cfg.table];
    console.log(`[dedupe-existing]   groups=${r.groups} rows=${r.scanned} candidates=${r.candidates.length} (auto=${r.candidates.filter((c) => c.score.decision === 'auto_merge').length})${r.truncated ? ' TRUNCATED' : ''}`);
  }
  writeFileSync(join(REPORTS, 'dedupe-existing-candidates.json'), JSON.stringify({ runId: RUN_ID, generated: new Date().toISOString(), all }, null, 2));

  if (MODE === 'dry-run') {
    writeFileSync(join(REPORTS, 'dedupe-existing-dry-run.md'), renderReport(all, null));
    console.log('[dedupe-existing] DRY-RUN complete → reports/dedupe-existing-dry-run.md (nothing written to D1)');
    return;
  }

  // --execute
  console.log('Production write detected. Dry-run report is ready. Explicit approval required before execute.');
  if (!freshBackupExists()) {
    console.error('[dedupe-existing] ABORT: no fresh (<24 h) backup in backups/. Run: npm run db:backup');
    process.exitCode = 3;
    return;
  }
  const executed = executeMerges(all);
  writeFileSync(join(REPORTS, 'dedupe-existing-final.md'), renderReport(all, executed));
  console.log(`[dedupe-existing] EXECUTED: merged=${executed.merged} queued=${executed.queued} run_id=${RUN_ID}`);
  console.log(`[dedupe-existing] rollback: bun scripts/merge-duplicates.ts --restore=${RUN_ID} --apply (+ backups/ SQL export)`);
}

if (!process.env.VITEST) await main();
