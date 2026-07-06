// SISMO911 — D1 database mapper. MUST run (fresh) before any external ingest.
// ---------------------------------------------------------------------------
// Introspects the remote D1 in exactly TWO queries (a per-table PRAGMA sweep
// would be ~700 wrangler round-trips):
//   1. sqlite_master → every CREATE TABLE / CREATE INDEX statement, parsed
//      locally into columns, PKs, uniques, FKs.
//   2. one UNION ALL → row count per table.
// Classifies each table: PII columns, duplicate-candidate keys, timestamp /
// source / status columns, ingest-safe vs ingest-BLOCKED. Emits
// reports/db-map.json (local-only) + reports/db-map.md, and stamps the run in
// the `audit` table — the pre-ingest gate refuses to run on a stale (>24 h)
// or missing stamp.
//
//   npm run db:map                 # remote (default), writes reports + stamp
//   npm run db:map -- --local      # local D1 instead
//   npm run db:map -- --no-stamp   # skip the audit stamp row
//
// Read-only except the single optional audit stamp row (append-only log).

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORTS = join(ROOT, 'reports');
const REMOTE = !process.argv.includes('--local');
const STAMP = !process.argv.includes('--no-stamp');

// ---------------------------------------------------------------------------
// wrangler d1 plumbing — OAuth session only (never the env token).
function d1(sql: string): Array<Record<string, unknown>> {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_ACCOUNT_ID;
  const args = ['wrangler', 'd1', 'execute', 'sismo911', REMOTE ? '--remote' : '--local', '--env-file', '/dev/null', '--json', '--command', sql];
  const res = spawnSync('npx', args, { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error(
      `wrangler d1 failed (status=${res.status}, signal=${res.signal}, err=${res.error?.message ?? 'none'}):\nstderr: ${res.stderr?.slice(0, 800)}\nstdout: ${res.stdout?.slice(0, 400)}`,
    );
  }
  const parsed = JSON.parse(res.stdout) as Array<{ results?: Array<Record<string, unknown>> }>;
  return parsed[0]?.results ?? [];
}

// ---------------------------------------------------------------------------
// CREATE TABLE parser (best effort; raw SQL is preserved in the JSON output).
export interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  pk: boolean;
  unique: boolean;
  default: string | null;
}
export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  uniques: string[][];
  foreignKeys: Array<{ columns: string[]; refTable: string; refColumns: string[] }>;
  indexes: Array<{ name: string; unique: boolean; sql: string | null }>;
  rowCount: number | null;
  piiColumns: string[];
  dupKeyColumns: string[];
  timestampColumns: string[];
  sourceColumns: string[];
  statusColumns: string[];
  ingest: 'safe' | 'blocked';
  ingestReason: string;
}

/** Split a CREATE TABLE body on commas at parenthesis depth 0. */
function splitTop(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

const IDENT = String.raw`(?:"[^"]+"|\[[^\]]+\]|\x60[^\x60]+\x60|[A-Za-z_][A-Za-z0-9_]*)`;
const unq = (s: string): string => s.replace(/^["\[\x60]|["\]\x60]$/g, '');
const colList = (s: string): string[] => s.split(',').map((c) => unq(c.trim().split(/\s+/)[0]));

export function parseCreateTable(sql: string): Pick<TableInfo, 'columns' | 'primaryKey' | 'uniques' | 'foreignKeys'> {
  const open = sql.indexOf('(');
  const close = sql.lastIndexOf(')');
  const body = sql.slice(open + 1, close);
  const columns: ColumnInfo[] = [];
  const primaryKey: string[] = [];
  const uniques: string[][] = [];
  const foreignKeys: TableInfo['foreignKeys'] = [];

  for (const part of splitTop(body)) {
    const up = part.toUpperCase();
    if (up.startsWith('PRIMARY KEY')) {
      const m = part.match(/\(([^)]+)\)/);
      if (m) primaryKey.push(...colList(m[1]));
      continue;
    }
    if (up.startsWith('UNIQUE')) {
      const m = part.match(/\(([^)]+)\)/);
      if (m) uniques.push(colList(m[1]));
      continue;
    }
    if (up.startsWith('FOREIGN KEY')) {
      const m = part.match(new RegExp(String.raw`FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s*(${IDENT})\s*(?:\(([^)]+)\))?`, 'i'));
      if (m) foreignKeys.push({ columns: colList(m[1]), refTable: unq(m[2]), refColumns: m[3] ? colList(m[3]) : [] });
      continue;
    }
    if (up.startsWith('CHECK') || up.startsWith('CONSTRAINT')) {
      const fk = part.match(new RegExp(String.raw`FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s*(${IDENT})\s*(?:\(([^)]+)\))?`, 'i'));
      if (fk) foreignKeys.push({ columns: colList(fk[1]), refTable: unq(fk[2]), refColumns: fk[3] ? colList(fk[3]) : [] });
      continue;
    }
    const m = part.match(new RegExp(String.raw`^(${IDENT})\s*([A-Za-z]+(?:\([^)]*\))?)?`, ''));
    if (!m) continue;
    const name = unq(m[1]);
    const inlinePk = /\bPRIMARY\s+KEY\b/i.test(part);
    const col: ColumnInfo = {
      name,
      type: (m[2] ?? '').toUpperCase(),
      notNull: /\bNOT\s+NULL\b/i.test(part),
      pk: inlinePk,
      unique: /\bUNIQUE\b/i.test(part),
      default: part.match(/\bDEFAULT\s+((?:'[^']*')|[^\s,]+)/i)?.[1] ?? null,
    };
    if (inlinePk) primaryKey.push(name);
    columns.push(col);
  }
  return { columns, primaryKey, uniques, foreignKeys };
}

// ---------------------------------------------------------------------------
// Classification heuristics.
const PII_RE = /(nombre|name(?!_norm)|cedula|apellido|phone|telefono|tel\b|contacto|contact|email|correo|direccion|address|dob|nacimiento|birth|pasaporte|passport|face|foto|photo)/i;
const DUPKEY_RE = /^(name_norm|norm_name|cedula|phone|telefono|email|ext_id|external_id|source_record_id|dedupe_key|raw_payload_hash|photo_phash|photo_dhash)$/i;
const TS_RE = /(_at|_ms|_time|fecha|timestamp)$/i;
const SOURCE_RE = /^(origen|source|fuente|source_name|source_url|channel|canal)$/i;
const STATUS_RE = /^(estado|status|outcome|moderation|verification_status|confidence|match_score)$/i;

// Person-identity tables are BLOCKED for direct ingest — external data reaches
// them only through an adapter + the pre-ingest gate (Increment 4).
const BLOCKED_EXPLICIT = new Set(['personas', 'hospital_patients', 'casualties', 'case_intel', 'case_identity', 'intake_submissions', 'users', 'sessions']);

function classify(t: TableInfo): void {
  const cols = t.columns.map((c) => c.name);
  t.piiColumns = cols.filter((c) => PII_RE.test(c));
  t.dupKeyColumns = cols.filter((c) => DUPKEY_RE.test(c));
  t.timestampColumns = cols.filter((c) => TS_RE.test(c));
  t.sourceColumns = cols.filter((c) => SOURCE_RE.test(c));
  t.statusColumns = cols.filter((c) => STATUS_RE.test(c));
  if (BLOCKED_EXPLICIT.has(t.name) || t.piiColumns.length >= 2) {
    t.ingest = 'blocked';
    t.ingestReason = BLOCKED_EXPLICIT.has(t.name) ? 'person-identity table — adapter + pre-ingest gate only' : `${t.piiColumns.length} PII columns — adapter + gate only`;
  } else {
    t.ingest = 'safe';
    t.ingestReason = 'no/low PII — still prefer gated ingest';
  }
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  mkdirSync(REPORTS, { recursive: true });
  const started = new Date().toISOString();

  const master = d1(`SELECT name, type, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type DESC, name`);
  const tables = new Map<string, TableInfo>();
  for (const row of master) {
    if (row.type !== 'table' || !row.sql) continue;
    const name = String(row.name);
    const parsed = parseCreateTable(String(row.sql));
    tables.set(name, {
      name,
      ...parsed,
      indexes: [],
      rowCount: null,
      piiColumns: [],
      dupKeyColumns: [],
      timestampColumns: [],
      sourceColumns: [],
      statusColumns: [],
      ingest: 'safe',
      ingestReason: '',
    });
  }
  for (const row of master) {
    if (row.type !== 'index') continue;
    const t = tables.get(String(row.tbl_name));
    if (t) t.indexes.push({ name: String(row.name), unique: /CREATE\s+UNIQUE/i.test(String(row.sql ?? '')), sql: row.sql ? String(row.sql) : null });
  }

  // Row counts in UNION ALL batches. D1's compound-SELECT term cap is tiny
  // (empirically: 5 works, 10 throws SQLITE_ERROR 7500 "too many terms").
  const names = [...tables.keys()];
  for (let i = 0; i < names.length; i += 5) {
    const slice = names.slice(i, i + 5);
    const union = slice.map((n) => `SELECT '${n}' AS t, COUNT(*) AS c FROM "${n}"`).join(' UNION ALL ');
    for (const row of d1(union)) {
      const t = tables.get(String(row.t));
      if (t) t.rowCount = Number(row.c);
    }
  }

  for (const t of tables.values()) classify(t);

  const list = [...tables.values()].sort((a, b) => (b.rowCount ?? 0) - (a.rowCount ?? 0));
  const dupProne = list.filter((t) => t.dupKeyColumns.length > 0 && (t.rowCount ?? 0) > 0);
  const totalRows = list.reduce((s, t) => s + (t.rowCount ?? 0), 0);

  const json = { generated: started, remote: REMOTE, tableCount: list.length, totalRows, tables: list };
  writeFileSync(join(REPORTS, 'db-map.json'), JSON.stringify(json, null, 2));

  const md: string[] = [
    '# SISMO911 — D1 Database Map',
    '',
    `Generated: ${started} · ${REMOTE ? 'REMOTE' : 'local'} · ${list.length} tables · ${totalRows.toLocaleString()} rows`,
    '',
    '## Tables (by row count)',
    '',
    '| table | rows | PK | PII cols | dup-key cols | source cols | ingest |',
    '|---|---|---|---|---|---|---|',
    ...list.map((t) => `| ${t.name} | ${t.rowCount?.toLocaleString() ?? '?'} | ${t.primaryKey.join('+') || '—'} | ${t.piiColumns.length} | ${t.dupKeyColumns.join(' ') || '—'} | ${t.sourceColumns.join(' ') || '—'} | ${t.ingest === 'blocked' ? '**BLOCKED**' : 'safe'} |`),
    '',
    '## Duplicate-prone tables (have dedupe-key columns + rows) — Increment 5 targets',
    '',
    ...dupProne.map((t) => `- **${t.name}** (${t.rowCount?.toLocaleString()}): keys ${t.dupKeyColumns.join(', ')}${t.uniques.length ? ` · uniques: ${t.uniques.map((u) => u.join('+')).join('; ')}` : ''}`),
    '',
    '## Ingest-blocked tables (adapter + pre-ingest gate ONLY)',
    '',
    ...list.filter((t) => t.ingest === 'blocked').map((t) => `- **${t.name}** — ${t.ingestReason}`),
    '',
    `_Column-level detail (types, nullability, FKs, indexes) in db-map.json (local-only — PII-adjacent)._`,
  ];
  writeFileSync(join(REPORTS, 'db-map.md'), md.join('\n') + '\n');

  if (STAMP) {
    const detail = JSON.stringify({ tables: list.length, rows: totalRows, remote: REMOTE }).replace(/'/g, "''");
    d1(`INSERT INTO audit (id, actor, action, detail, created_ms) VALUES ('dbmap_${Date.now().toString(36)}', 'db-map-script', 'db_map_generated', '${detail}', ${Date.now()})`);
  }

  console.log(`[db-map] tables=${list.length} rows=${totalRows} dupProne=${dupProne.length} blocked=${list.filter((t) => t.ingest === 'blocked').length} stamp=${STAMP}`);
  console.log('[db-map] wrote reports/db-map.json (local) + reports/db-map.md');
}

// Allow unit tests to import parseCreateTable without executing the mapper.
if (!process.env.VITEST) await main();
