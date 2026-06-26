#!/usr/bin/env node
// SISMO911 — backfill redayudavenezuela.com (RAV) into the live D1 via the
// Worker's own Bearer endpoint POST /api/rav/run (which uses the Worker's D1
// binding, so it works regardless of the local wrangler token's D1 scope).
//
// DEDUPE BY CONSTRUCTION: personas rows are keyed `rav_<uuid>` and every write is
// an UPSERT, so re-running REFRESHES rather than duplicates. App-owned status
// columns are never overwritten. Cross-source dups (RAV↔theempire) are collapsed
// by the --clean pass (exact/photo/fuzzyphone/phash dedupe), which runs server-side.
//
// Usage:
//   node scripts/pull-rav.mjs                 # dry-run: prints counts, writes nothing
//   node scripts/pull-rav.mjs --apply         # ingest all ~53k persons + stats + verified
//   node scripts/pull-rav.mjs --apply --clean # …then depurar (junk→rejected) + dedupe
//   node scripts/pull-rav.mjs --clean --no-pull  # clean/dedupe only
//
// Env: SISMO911_BASE (default live worker), RAV_INGEST_TOKEN (or ~/.sismo911-tokens/rav.env).

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APPLY = process.argv.includes('--apply');
const CLEAN = process.argv.includes('--clean');
const NO_PULL = process.argv.includes('--no-pull');
const PAGES = Math.min(Math.max(Number(process.env.RAV_PAGES) || 10, 1), 25);
const BASE = (process.env.SISMO911_BASE || 'https://sismo911.rikitrader.workers.dev').replace(/\/+$/, '');
const DB = 'sismo911';

function token() {
  if (process.env.RAV_INGEST_TOKEN) return process.env.RAV_INGEST_TOKEN.trim();
  for (const f of ['rav.env', 'blog-cron.env']) {
    try {
      const txt = readFileSync(join(homedir(), '.sismo911-tokens', f), 'utf8');
      const m = txt.match(/^(?:RAV_INGEST_TOKEN|BLOG_INGEST_TOKEN)\s*=\s*(.+)$/m);
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    } catch { /* next */ }
  }
  return null;
}
const TOK = token();

async function run(kind, extra = '') {
  const url = `${BASE}/api/rav/run?kind=${kind}${extra}`;
  const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${TOK}` } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`run ${kind} HTTP ${res.status}: ${JSON.stringify(j)}`);
  return j;
}

// remote D1 counts via wrangler (OAuth session) for the comparison report.
function d1(sql) {
  try {
    const out = execSync(
      `wrangler d1 execute ${DB} --remote --json --command ${JSON.stringify(sql)}`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const j = JSON.parse(out);
    return j?.[0]?.results ?? [];
  } catch { return []; }
}

function report() {
  const one = (sql) => { const r = d1(sql); return r.length ? Object.values(r[0])[0] : '?'; };
  console.log('\n================  COMPARACIÓN / ENRICH REPORT  ================');
  console.log('personas total            :', one(`SELECT count(*) FROM personas`));
  console.log("  origen RAV              :", one(`SELECT count(*) FROM personas WHERE origen LIKE 'rav:%'`));
  console.log("  origen theempire/otros  :", one(`SELECT count(*) FROM personas WHERE origen IS NULL OR origen NOT LIKE 'rav:%'`));
  console.log("  RAV terremotovenezuela  :", one(`SELECT count(*) FROM personas WHERE origen = 'rav:terremotovenezuela.app'`));
  console.log("  RAV comunidad           :", one(`SELECT count(*) FROM personas WHERE origen = 'rav:comunidad'`));
  console.log('  rejected (junk/depurado):', one(`SELECT count(*) FROM personas WHERE moderation='rejected'`));
  console.log('  con foto                :', one(`SELECT count(*) FROM personas WHERE trim(coalesce(foto,'')) <> ''`));
  console.log('  con caption IA          :', one(`SELECT count(*) FROM personas WHERE photo_caption IS NOT NULL`));
  console.log('  con phash               :', one(`SELECT count(*) FROM personas WHERE photo_phash IS NOT NULL`));
  console.log('verified_info             :', one(`SELECT count(*) FROM verified_info`));
  console.log('official_stats            :', one(`SELECT count(*) FROM official_stats`));
  console.log('--- duplicados restantes (deben tender a 0) ---');
  console.log('  exact-content dups      :', one(`SELECT coalesce(sum(c-1),0) FROM (SELECT count(*) c FROM personas GROUP BY lower(trim(nombre)),coalesce(edad,-1),lower(trim(coalesce(ubicacion,''))),lower(trim(coalesce(descripcion,''))),lower(trim(coalesce(contacto,'')))) WHERE c>1`));
  console.log('  same-photo-URL dups     :', one(`SELECT coalesce(sum(c-1),0) FROM (SELECT count(*) c FROM personas WHERE trim(coalesce(foto,''))<>'' GROUP BY lower(trim(foto))) WHERE c>1`));
  console.log('  same-image (phash) dups :', one(`SELECT coalesce(sum(c-1),0) FROM (SELECT count(*) c FROM personas WHERE trim(coalesce(photo_phash,''))<>'' GROUP BY photo_phash) WHERE c>1`));
  console.log('==============================================================\n');
}

async function main() {
  if (!TOK) { console.error('No RAV_INGEST_TOKEN (env or ~/.sismo911-tokens/rav.env). Set it first.'); process.exit(1); }
  console.log(`Target: ${BASE}  pages/call=${PAGES}  apply=${APPLY} clean=${CLEAN} no-pull=${NO_PULL}`);

  if (!APPLY && !CLEAN) {
    // dry-run: report only
    report();
    console.log('Dry-run only. Re-run with --apply to ingest.');
    return;
  }

  if (APPLY && !NO_PULL) {
    console.log('Ingesting stats + verified…');
    console.log('  →', JSON.stringify(await run('stats')));
    console.log('  →', JSON.stringify(await run('verified')));
    console.log('Ingesting persons (looping until cursor wraps to 0)…');
    let guard = 0, totalWritten = 0;
    while (guard++ < 200) {
      const j = await run('persons', `&pages=${PAGES}`);
      const p = j.persons || {};
      totalWritten += p.written || 0;
      console.log(`  ${p.from ?? '?'}-${p.to ?? '?'}/${p.total ?? '?'}  wrote ${p.written ?? 0}  next=${p.next}`);
      if (!p || p.next === 0 || p.next == null) break;
    }
    console.log(`Persons ingest complete: ~${totalWritten} upserts this run.`);
  }

  if (CLEAN) {
    console.log('Depurar + dedupe (junk→rejected, exact/photo/fuzzyphone/phash)…');
    // run clean+dedupe a few passes — each is bounded (limit 400) and convergent.
    for (let i = 0; i < 8; i++) {
      const j = await run('persons', `&pages=1&clean=1&dedupe=1`);
      const d = j.dedupe || {};
      const remaining = Object.values(d).reduce((s, x) => s + (x?.remaining || 0), 0);
      console.log(`  pass ${i + 1}: dedupe remaining≈${remaining}`);
      if (remaining === 0 && i > 0) break;
    }
  }

  report();
}
main().catch((e) => { console.error(e); process.exit(1); });
