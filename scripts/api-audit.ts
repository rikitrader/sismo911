// SISMO911 — API audit: authoritative route inventory + safe live probe.
// ---------------------------------------------------------------------------
// Enumerates EVERY route from Hono's own route table (the same source of truth
// test/api-route-coverage.test.ts enforces), classifies each with the real
// evaluateGate(), statically maps the D1 tables + external hosts each route
// file touches, then live-probes ONLY safe endpoints (public, GET, param-less)
// against production and reports failures with a fix recommendation.
//
//   npm run api:audit                 # writes reports/api-debug-audit.md (+ json)
//   npm run api:audit -- --no-probe   # inventory only, zero network calls
//   npm run api:audit -- --base=https://staging.example.com
//
// Read-only by design: never POSTs, never sends data, never touches D1.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from '../src/index';
import { evaluateGate } from '../src/rbac/route-policy';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORTS = join(ROOT, 'reports');
const BASE = process.argv.find((a) => a.startsWith('--base='))?.slice(7) ?? 'https://sismo911.com';
const PROBE = !process.argv.includes('--no-probe');
const PROBE_TIMEOUT_MS = 10000;
const PROBE_CONCURRENCY = 5;

interface RouteInfo {
  method: string;
  path: string;
  gate: string; // open | login | perm:<p> | page | deny
  file: string | null; // src/routes file that owns the mount (best effort)
  tables: string[];
  externals: string[];
}

// ---------------------------------------------------------------------------
// 1. Route inventory from Hono's route table.
const rawRoutes: Array<{ method: string; path: string }> = [
  ...new Map(
    (app as unknown as { routes: Array<{ method: string; path: string }> }).routes
      .filter((r) => !String(r.path).includes('*'))
      .map((r) => [`${r.method === 'ALL' ? 'GET' : r.method} ${r.path}`, { method: r.method === 'ALL' ? 'GET' : r.method, path: String(r.path) }]),
  ).values(),
];

// 2. Mount map: /api/<prefix> → route file, from index.ts app.route calls.
const indexSrc = readFileSync(join(ROOT, 'src/index.ts'), 'utf8');
const mounts: Array<{ prefix: string; ident: string }> = [];
for (const m of indexSrc.matchAll(/app\.route\('([^']+)'\s*,\s*(\w+)\)/g)) {
  mounts.push({ prefix: m[1], ident: m[2] });
}
const importFile: Record<string, string> = {};
for (const m of indexSrc.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/(routes\/[\w-]+)'/g)) {
  for (const ident of m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()!.trim())) {
    if (ident) importFile[ident] = `src/${m[2]}.ts`;
  }
}
function fileFor(path: string): string | null {
  let best: { prefix: string; ident: string } | null = null;
  for (const mt of mounts) {
    if ((path === mt.prefix || path.startsWith(mt.prefix + '/')) && (!best || mt.prefix.length > best.prefix.length)) best = mt;
  }
  return best ? (importFile[best.ident] ?? null) : null;
}

// 3. Static scan per route file: D1 tables + external hosts.
const TABLE_RE = /\b(?:FROM|INTO|UPDATE|JOIN|DELETE\s+FROM)\s+([a-z_][a-z0-9_]*)/gi;
const SQL_KEYWORDS = new Set(['select', 'where', 'values', 'set', 'and', 'or', 'not', 'on', 'as', 'left', 'inner', 'order', 'group', 'limit']);
const HOST_RE = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi;
const fileScan = new Map<string, { tables: string[]; externals: string[] }>();
function scanFile(rel: string): { tables: string[]; externals: string[] } {
  const hit = fileScan.get(rel);
  if (hit) return hit;
  let tables: string[] = [];
  let externals: string[] = [];
  try {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    tables = [...new Set([...src.matchAll(TABLE_RE)].map((m) => m[1].toLowerCase()).filter((t) => !SQL_KEYWORDS.has(t)))].sort();
    externals = [...new Set([...src.matchAll(HOST_RE)].map((m) => m[1].toLowerCase()).filter((h) => !h.endsWith('sismo911.com') && !h.endsWith('w3.org')))].sort();
  } catch {
    /* file missing — keep empties */
  }
  fileScan.set(rel, { tables, externals });
  return { tables, externals };
}

function gateLabel(path: string, method: string): string {
  const g = evaluateGate(path, method) as { kind: string; perm?: string };
  return g.kind === 'perm' ? `perm:${g.perm}` : g.kind;
}

const routes: RouteInfo[] = rawRoutes
  .map(({ method, path }) => {
    const file = path.startsWith('/api') ? fileFor(path) : null;
    const scan = file ? scanFile(file) : { tables: [], externals: [] };
    return { method, path, gate: path.startsWith('/api') ? gateLabel(path, method) : 'page/static', file, ...scan };
  })
  .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

// ---------------------------------------------------------------------------
// 4. Live probe: public GET param-less /api routes only. Never sends data.
interface ProbeResult {
  path: string;
  status: number | 'network_error' | 'timeout';
  ms: number;
  ok: boolean;
  recommendation?: string;
}

async function probe(path: string): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(BASE + path, { signal: ctl.signal, headers: { 'user-agent': 'sismo911-api-audit/1' } });
    clearTimeout(timer);
    const ms = Date.now() - started;
    const ok = res.status < 500;
    return {
      path,
      status: res.status,
      ms,
      ok,
      ...(ok ? {} : { recommendation: `GET ${path} returned ${res.status} — check Worker logs (wrangler tail) for the route handler; likely an unhandled null/env binding.` }),
    };
  } catch (e) {
    const ms = Date.now() - started;
    const timedOut = ms >= PROBE_TIMEOUT_MS - 50;
    return {
      path,
      status: timedOut ? 'timeout' : 'network_error',
      ms,
      ok: false,
      recommendation: timedOut
        ? `GET ${path} exceeded ${PROBE_TIMEOUT_MS} ms — likely unbounded D1 scan or upstream fetch without timeout; add LIMIT / AbortSignal.`
        : `GET ${path} network error (${(e as Error).message}) — verify the route is mounted and the zone is serving.`,
    };
  }
}

async function probeAll(paths: string[]): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  for (let i = 0; i < paths.length; i += PROBE_CONCURRENCY) {
    out.push(...(await Promise.all(paths.slice(i, i + PROBE_CONCURRENCY).map(probe))));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. Repo discovery (framework, cron, ingest, migrations, tests).
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
const migrations = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
const ingestFiles = readdirSync(join(ROOT, 'src/ingest')).filter((f) => f.endsWith('.ts')).sort();
const testFiles = readdirSync(join(ROOT, 'test')).filter((f) => f.endsWith('.test.ts')).sort();
const cronSrc = readFileSync(join(ROOT, 'src/cron.ts'), 'utf8');
const cronJobs = [...cronSrc.matchAll(/name:\s*'([\w-]+)'/g)].map((m) => m[1]);
const cronSchedules = [...readFileSync(join(ROOT, 'wrangler.toml'), 'utf8').matchAll(/"([\d*/ ]+ \* \* \* \*)"/g)].map((m) => m[1]);

// Duplicate-prone tables: any table referenced with person-identity columns.
const DUP_PRONE = ['personas', 'hospital_patients', 'casualties', 'case_intel', 'intake_submissions', 'contacts', 'edificios_personas'];
const tablesSeen = [...new Set(routes.flatMap((r) => r.tables))].sort();

async function main(): Promise<void> {
  mkdirSync(REPORTS, { recursive: true });

  const apiRoutes = routes.filter((r) => r.path.startsWith('/api'));
  const openGets = apiRoutes.filter((r) => r.gate === 'open' && r.method === 'GET' && !r.path.includes(':'));
  const probeResults = PROBE ? await probeAll([...new Set(openGets.map((r) => r.path))]) : [];
  const failures = probeResults.filter((r) => !r.ok);

  // ---- api-debug-audit.md -------------------------------------------------
  const audit: string[] = [
    '# SISMO911 — API Debug Audit',
    '',
    `Generated: ${new Date().toISOString()} · Base: ${BASE} · Routes: ${routes.length} (${apiRoutes.length} under /api)`,
    '',
    '## Live probe (public, GET, param-less only — read-only)',
    '',
    PROBE ? `Probed ${probeResults.length} endpoints · **${failures.length} failing** (status ≥500 / timeout / network)` : '_Probe skipped (--no-probe)._',
    '',
  ];
  if (failures.length) {
    audit.push('| endpoint | status | ms | recommendation |', '|---|---|---|---|');
    for (const f of failures) audit.push(`| GET ${f.path} | ${f.status} | ${f.ms} | ${f.recommendation} |`);
  } else if (PROBE) {
    audit.push('All probed endpoints healthy (<500).');
  }
  audit.push('', '## Route inventory (method · path · gate · owning file · D1 tables)', '');
  audit.push('| method | path | gate | file | tables |', '|---|---|---|---|---|');
  for (const r of apiRoutes) audit.push(`| ${r.method} | ${r.path} | ${r.gate} | ${r.file ?? ''} | ${r.tables.join(' ')} |`);
  writeFileSync(join(REPORTS, 'api-debug-audit.md'), audit.join('\n') + '\n');
  writeFileSync(join(REPORTS, 'api-map.json'), JSON.stringify({ generated: new Date().toISOString(), base: BASE, routes, probeResults }, null, 2));

  // ---- sismo911-discovery-report.md --------------------------------------
  const disco: string[] = [
    '# SISMO911 — Discovery Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Stack',
    '- Framework: Cloudflare Workers + Hono ' + (pkg.dependencies?.hono ?? '') + ' (single Worker: static assets + /api/*)',
    '- Database: Cloudflare D1 (SQLite) via env.DB — no ORM, prepared statements',
    '- Storage: KV (SESSIONS/CACHE), R2 (fotos/evidence), Workers AI, Vectorize',
    '- Tests: Vitest (' + testFiles.length + ' files) · CI: verify + security + secret-scan + gitleaks',
    '',
    '## API surface',
    `- ${apiRoutes.length} concrete /api routes across ${mounts.length} mounts (authoritative: Hono route table; classified by src/rbac/route-policy.ts, default-deny enforced by test/api-route-coverage.test.ts)`,
    `- Gates: ${Object.entries(apiRoutes.reduce((acc: Record<string, number>, r) => ((acc[r.gate] = (acc[r.gate] ?? 0) + 1), acc), {})).map(([k, v]) => `${k}=${v}`).join(' · ')}`,
    '',
    '## Cron / scheduled work',
    `- ${cronSchedules.length} wrangler cron triggers → CRON_GROUPS in src/cron.ts · ${cronJobs.length} named jobs`,
    '- Jobs: ' + cronJobs.join(', '),
    '',
    '## Ingest scripts (src/ingest/)',
    '- ' + ingestFiles.join(', '),
    '',
    '## Migrations',
    `- ${migrations.length} files, ${migrations[0]} … ${migrations[migrations.length - 1]}`,
    '',
    '## D1 tables referenced by routes (static scan)',
    '- ' + tablesSeen.join(', '),
    '',
    '## Duplicate-prone tables (identity-bearing; targets for the dedupe pipeline)',
    ...DUP_PRONE.map((t) => `- ${t}`),
    '',
    '## Risk areas',
    '- personas (~132k rows): bulk importers historically skipped name_norm (fixed PR #627) — dedupe blind spots recur when a new write path forgets computeSearchFields.',
    '- External ingests (CIVIS/RAV/social) are UPSERT-keyed per-source but have no cross-source identity contract → cross-source duplicates accumulate between dedupe passes.',
    '- Cron subrequest budget (~1000/invocation): any new job must join an existing CRON_GROUP with bounded fan-out.',
    '- OCR intake: artifacts now flagged (ocr-normalize, PR #648) but historical rows before 2026-07-05 are untagged.',
    '',
    '## Missing / weak (feeds the plan increments)',
    '- No DB schema map artifact (Increment 2), no pre-ingest gate (4), no cross-source scoring dedupe (3), no data-quality endpoint (7).',
    '- Live probe covers public GETs only; gated routes are exercised by the Vitest suite, not by this audit.',
    '',
    '## Recommended execution order',
    '- Map DB (2) → dedupe engine + tables (3) → clean existing duplicates all tables (5) → pre-ingest gate + adapters (4) → consolidated ingest cron + hourly dedupe (6/6b) → data-quality endpoint (7).',
  ];
  writeFileSync(join(REPORTS, 'sismo911-discovery-report.md'), disco.join('\n') + '\n');

  console.log(`[api-audit] routes=${routes.length} api=${apiRoutes.length} probed=${probeResults.length} failing=${failures.length}`);
  console.log(`[api-audit] wrote reports/api-debug-audit.md, reports/api-map.json, reports/sismo911-discovery-report.md`);
  if (failures.length) process.exitCode = 2;
}

await main();
