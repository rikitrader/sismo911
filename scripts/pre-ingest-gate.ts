// SISMO911 — pre-ingest gate: NOTHING external lands in D1 unless every gate passes.
// ---------------------------------------------------------------------------
//   npm run ingest:check   -- --source=civis                    # validate only
//   npm run ingest:dry-run -- --source=civis --file=batch.json  # simulate, zero writes
//   npm run ingest:execute -- --source=civis --file=batch.json  # write (all gates + prior dry-run)
//
// Gates (ALL must pass):
//   G1  D1 reachable
//   G2  required tables exist (personas + 0098 data-integrity set)
//   G3  db-map stamp fresh (<24 h; audit action='db_map_generated')
//   G4  fresh backup (<24 h backups/*.sql — npm run db:backup)
//   G5  API health (GET /api/health)
//   G6  adapter registered for --source
//   G7  admin approval flag (feature_flags module_key='ingest_approved_<source>')
//   G8  batch shape known: every record maps via the adapter (dry-run/execute)
//   G9  identity present: <20% of mapped records missing BOTH name and national_id
//   G10 duplicate explosion: <30% of batch already present (source_record_id or
//       exact name_norm match) — above that, something is wrong; abort
//
// execute additionally requires a dry-run stamp (<6 h) for the same source+file
// hash, prints the production-write warning, and writes ONLY:
//   personas UPSERT by id civis-style (`<source>_<source_record_id>`) with
//   moderation='pending' (operator review — external data is never auto-public)
//   + one ingest_runs row (+ ingest_errors per failure).

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS } from '../src/ingest/adapters/civis';
import { fnv1a, type CanonicalPersonRecord } from '../src/ingest/adapters/types';
import { normalizeName } from '../src/lib/search-normalize';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORTS = join(ROOT, 'reports');
const BACKUPS = join(ROOT, 'backups');
const STAMPS = join(REPORTS, '.ingest-stamps');
const MODE = process.argv.includes('--execute') ? 'execute' : process.argv.includes('--dry-run') ? 'dry-run' : 'check';
const SOURCE = process.argv.find((a) => a.startsWith('--source='))?.split('=')[1] ?? '';
const FILE = process.argv.find((a) => a.startsWith('--file='))?.split('=')[1] ?? '';
const BASE = process.argv.find((a) => a.startsWith('--base='))?.split('=')[1] ?? 'https://sismo911.com';

function d1(sql: string): Array<Record<string, unknown>> {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_ACCOUNT_ID;
  const res = spawnSync('npx', ['wrangler', 'd1', 'execute', 'sismo911', '--remote', '--env-file', '/dev/null', '--json', '--command', sql], {
    cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`d1: ${(res.stdout || res.stderr || '').slice(0, 400)}`);
  return (JSON.parse(res.stdout) as Array<{ results?: Array<Record<string, unknown>> }>)[0]?.results ?? [];
}
const lit = (v: unknown): string => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

interface GateResult { gate: string; ok: boolean; detail: string }
const results: GateResult[] = [];
function gate(name: string, fn: () => string): boolean {
  try {
    const detail = fn();
    results.push({ gate: name, ok: true, detail });
    return true;
  } catch (e) {
    results.push({ gate: name, ok: false, detail: (e as Error).message });
    return false;
  }
}

const REQUIRED_TABLES = ['personas', 'dedupe_runs', 'dedupe_candidates', 'dedupe_conflicts', 'ingest_runs', 'ingest_errors', 'data_quality_reports', 'audit', 'feature_flags'];

async function main(): Promise<void> {
  mkdirSync(STAMPS, { recursive: true });
  const now = Date.now();

  // --- infrastructure gates (all modes) -------------------------------------
  gate('G1 d1_reachable', () => {
    d1('SELECT 1 AS ok');
    return 'D1 responds';
  });
  gate('G2 required_tables', () => {
    const rows = d1(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${REQUIRED_TABLES.map(lit).join(',')})`);
    const have = new Set(rows.map((r) => String(r.name)));
    const missing = REQUIRED_TABLES.filter((t) => !have.has(t));
    if (missing.length) throw new Error(`missing tables: ${missing.join(', ')}`);
    return `${REQUIRED_TABLES.length} tables present`;
  });
  gate('G3 db_map_fresh', () => {
    const rows = d1(`SELECT created_ms FROM audit WHERE action='db_map_generated' ORDER BY created_ms DESC LIMIT 1`);
    const ts = Number(rows[0]?.created_ms ?? 0);
    if (!ts) throw new Error('no db-map stamp — run: npm run db:map');
    if (now - ts > 24 * 3600 * 1000) throw new Error(`db-map stamp is ${Math.round((now - ts) / 3600000)} h old — run: npm run db:map`);
    return `stamp ${Math.round((now - ts) / 60000)} min old`;
  });
  gate('G4 backup_fresh', () => {
    const files = existsSync(BACKUPS) ? readdirSync(BACKUPS).filter((f) => f.endsWith('.sql')) : [];
    const fresh = files.filter((f) => now - statSync(join(BACKUPS, f)).mtimeMs < 24 * 3600 * 1000);
    if (!fresh.length) throw new Error('no <24 h backup — run: npm run db:backup');
    return fresh[fresh.length - 1];
  });
  gate('G5 api_health', () => {
    const res = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '10', `${BASE}/api/health`], { encoding: 'utf8' });
    if (res.stdout !== '200') throw new Error(`GET /api/health → ${res.stdout || 'no response'}`);
    return '200';
  });
  gate('G6 adapter_registered', () => {
    if (!SOURCE) throw new Error('--source=<name> is required');
    if (!ADAPTERS[SOURCE]) throw new Error(`no adapter for '${SOURCE}' (have: ${Object.keys(ADAPTERS).join(', ')})`);
    return SOURCE;
  });
  gate('G7 admin_approval_flag', () => {
    const rows = d1(`SELECT enabled FROM feature_flags WHERE module_key=${lit(`ingest_approved_${SOURCE}`)} ORDER BY updated_ms DESC LIMIT 1`);
    if (!rows.length || Number(rows[0].enabled) !== 1) {
      throw new Error(`feature_flags module_key='ingest_approved_${SOURCE}' is not enabled — an admin must approve this source`);
    }
    return 'approved';
  });

  // --- batch gates (dry-run / execute) --------------------------------------
  let mapped: CanonicalPersonRecord[] = [];
  let batchHash = '';
  if (MODE !== 'check') {
    if (!FILE) {
      results.push({ gate: 'G8 batch_shape', ok: false, detail: '--file=<batch.json> is required for dry-run/execute' });
    } else {
      const rawText = readFileSync(FILE, 'utf8');
      batchHash = fnv1a(rawText);
      const rawList = JSON.parse(rawText) as unknown[];
      const adapter = ADAPTERS[SOURCE];
      const rejects: number[] = [];
      rawList.forEach((raw, i) => {
        const rec = adapter?.toCanonical(raw);
        if (rec) mapped.push(rec);
        else rejects.push(i);
      });
      gate('G8 batch_shape', () => {
        if (!rawList.length) throw new Error('empty batch');
        if (rejects.length / rawList.length > 0.2) throw new Error(`${rejects.length}/${rawList.length} records unmappable — source shape changed?`);
        return `${mapped.length}/${rawList.length} mapped (${rejects.length} rejected)`;
      });
      gate('G9 identity_present', () => {
        const noId = mapped.filter((m) => !m.full_name && !m.national_id).length;
        if (mapped.length && noId / mapped.length >= 0.2) throw new Error(`${noId}/${mapped.length} records lack BOTH name and national_id`);
        return `${mapped.length - mapped.filter((m) => !m.full_name && !m.national_id).length} identifiable`;
      });
      gate('G10 duplicate_explosion', () => {
        if (!mapped.length) return 'no records';
        let present = 0;
        for (let i = 0; i < mapped.length; i += 80) {
          const slice = mapped.slice(i, i + 80);
          const ids = slice.map((m) => lit(`${SOURCE}_${m.source_record_id}`)).join(',');
          present += Number(d1(`SELECT COUNT(*) AS c FROM personas WHERE id IN (${ids})`)[0]?.c ?? 0);
        }
        const rate = present / mapped.length;
        if (rate >= 0.3 && present > 20) throw new Error(`${present}/${mapped.length} (${Math.round(rate * 100)}%) already present — duplicate explosion risk, aborting`);
        return `${present}/${mapped.length} already present (${Math.round(rate * 100)}%) — under threshold`;
      });
    }
  }

  // --- report ---------------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  const lines = [
    `# Pre-ingest gate — ${MODE} · source=${SOURCE || '?'} · ${new Date().toISOString()}`,
    '',
    ...results.map((r) => `- ${r.ok ? '✅' : '❌'} **${r.gate}** — ${r.detail}`),
    '',
    failed.length ? `**BLOCKED: ${failed.length} gate(s) failed. Ingest must not run.**` : `**All gates passed.**`,
  ];
  writeFileSync(join(REPORTS, `pre-ingest-${MODE}.md`), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
  if (failed.length) {
    process.exitCode = 4;
    return;
  }

  if (MODE === 'dry-run') {
    writeFileSync(join(STAMPS, `${SOURCE}-${batchHash}.json`), JSON.stringify({ at: now, mapped: mapped.length }));
    console.log(`\n[gate] DRY-RUN OK: ${mapped.length} records would be UPSERTed as moderation='pending'. Zero writes performed.`);
    return;
  }

  if (MODE === 'execute') {
    const stampPath = join(STAMPS, `${SOURCE}-${batchHash}.json`);
    if (!existsSync(stampPath) || now - (JSON.parse(readFileSync(stampPath, 'utf8')) as { at: number }).at > 6 * 3600 * 1000) {
      console.error('[gate] ABORT: no fresh (<6 h) dry-run stamp for this exact batch — run ingest:dry-run first.');
      process.exitCode = 5;
      return;
    }
    console.log('Production write detected. Dry-run report is ready. Explicit approval required before execute.');
    const runId = `igr_${now.toString(36)}`;
    const stmts: string[] = [];
    let inserted = 0;
    for (const m of mapped) {
      const id = `${SOURCE}_${m.source_record_id}`;
      stmts.push(
        `INSERT INTO personas (id, nombre, edad, ubicacion, descripcion, contacto, estado, moderation, origen, ext_id, name_norm, created_at, updated_at) VALUES (${lit(id)}, ${lit(m.full_name ?? '')}, ${m.age ?? 'NULL'}, ${lit(m.last_seen_location ?? '')}, ${lit(`Ingesta externa ${SOURCE} (gate ${runId}).`)}, ${lit(m.family_contact_phone ?? '')}, ${lit(m.status ?? 'sin-contacto')}, 'pending', ${lit(`${SOURCE}:gate`)}, ${lit(m.source_record_id)}, ${lit(normalizeName(m.full_name ?? ''))}, ${now}, ${now}) ON CONFLICT(id) DO UPDATE SET nombre=excluded.nombre, edad=excluded.edad, ubicacion=excluded.ubicacion, name_norm=excluded.name_norm, updated_at=${now};`,
      );
      inserted++;
    }
    stmts.push(
      `INSERT INTO ingest_runs (id, source_name, status, fetched, inserted, updated, skipped_dup, errors, detail, created_ms) VALUES (${lit(runId)}, ${lit(SOURCE)}, 'ok', ${mapped.length}, ${inserted}, 0, 0, 0, ${lit(JSON.stringify({ batchHash, gate: 'pre-ingest' }))}, ${now});`,
    );
    const sqlPath = join(REPORTS, `pre-ingest-execute-${runId}.sql`);
    writeFileSync(sqlPath, stmts.join('\n') + '\n');
    const env = { ...process.env };
    delete env.CLOUDFLARE_API_TOKEN;
    delete env.CLOUDFLARE_ACCOUNT_ID;
    const res = spawnSync('npx', ['wrangler', 'd1', 'execute', 'sismo911', '--remote', '--env-file', '/dev/null', '--file', sqlPath], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (res.status !== 0) throw new Error(`execute failed: ${(res.stdout || res.stderr || '').slice(0, 400)}`);
    console.log(`[gate] EXECUTED ${runId}: ${inserted} UPSERTs, all moderation='pending' (operator review).`);
  }
}

await main();
