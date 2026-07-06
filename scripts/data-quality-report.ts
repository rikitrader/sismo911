// SISMO911 — data-quality report (CLI mirror of GET /api/admin/data-quality).
// Queries remote D1 directly (wrangler OAuth) so it works without a session.
//   npm run data:quality
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function d1(sql: string): Array<Record<string, unknown>> {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_ACCOUNT_ID;
  const res = spawnSync('npx', ['wrangler', 'd1', 'execute', 'sismo911', '--remote', '--env-file', '/dev/null', '--json', '--command', sql], {
    cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`d1: ${(res.stdout || res.stderr || '').slice(0, 300)}`);
  return (JSON.parse(res.stdout) as Array<{ results?: Array<Record<string, unknown>> }>)[0]?.results ?? [];
}

const row = d1(
  `SELECT
    (SELECT COUNT(*) FROM personas) AS personas_total,
    (SELECT COUNT(*) FROM personas WHERE moderation='approved' AND (merged_into IS NULL OR trim(merged_into)='')) AS personas_activas,
    (SELECT COUNT(*) FROM personas WHERE merged_into IS NOT NULL AND trim(merged_into)<>'') AS personas_merged,
    (SELECT COUNT(*) FROM personas WHERE moderation='approved' AND (merged_into IS NULL OR trim(merged_into)='') AND (name_norm IS NULL OR name_norm='')) AS sin_name_norm,
    (SELECT COUNT(*) FROM hospital_patients) AS hospital_patients,
    (SELECT COUNT(*) FROM dedupe_candidates WHERE decision='review') AS review_queue,
    (SELECT COUNT(*) FROM dedupe_candidates WHERE decision='merged') AS auto_merged_pairs,
    (SELECT COUNT(*) FROM dedupe_conflicts WHERE resolved=0 AND severity='critical') AS critical_conflicts,
    (SELECT COUNT(*) FROM dedupe_runs WHERE status='error' AND created_ms > (strftime('%s','now')-604800)*1000) AS failed_dedupe_runs_7d,
    (SELECT MAX(created_ms) FROM dedupe_runs) AS last_dedupe_ms,
    (SELECT MAX(created_ms) FROM ingest_runs) AS last_ingest_ms,
    (SELECT MAX(created_ms) FROM audit WHERE action='db_map_generated') AS db_map_ms`,
)[0];

const md = [
  '# SISMO911 — Data Quality Report',
  '',
  `Generated: ${new Date().toISOString()}`,
  '',
  ...Object.entries(row).map(([k, v]) => `- **${k}**: ${typeof v === 'number' && k.endsWith('_ms') && v ? new Date(v).toISOString() : (v ?? '—')}`),
];
mkdirSync(join(ROOT, 'reports'), { recursive: true });
writeFileSync(join(ROOT, 'reports', 'data-quality.md'), md.join('\n') + '\n');
console.log(md.join('\n'));
