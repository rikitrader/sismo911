#!/usr/bin/env node
// SISMO911 — D1 de-duplication tool.
//
// DRY-RUN BY DEFAULT: prints duplicate groups per table and deletes NOTHING.
// Pass --apply to actually delete (keeps ONE row per group). This is a
// life-safety database — sensitive tables (persons, sos_alerts, checkins,
// damage_reports) are EXCLUDED unless you add --include-sensitive.
//
// Usage:
//   node scripts/d1-dedupe.mjs                       # dry-run, safe tables
//   node scripts/d1-dedupe.mjs --include-sensitive   # dry-run, all tables (incl. duplicate pics)
//   node scripts/d1-dedupe.mjs --apply               # DELETE dups in safe tables
//   node scripts/d1-dedupe.mjs --apply --include-sensitive   # DELETE everywhere (careful!)
//
// "Keep" policy per group: resources keep the most-recently-updated row;
// everything else keeps the earliest-created row. Photos: damage_reports are
// de-duped by photo_key (same image uploaded twice → one row kept).

import { execSync } from 'node:child_process';

const APPLY = process.argv.includes('--apply');
const SENSITIVE = process.argv.includes('--include-sensitive');
const DB = 'sismo911';

// table → { key: SQL key columns/expr, order: ORDER BY for ROW_NUMBER (rn=1 is kept), sensitive }
const TABLES = [
  { t: 'contacts',       key: "agency, category, COALESCE(region,''), COALESCE(phone,'')", order: 'rowid ASC' },
  { t: 'resources',      key: "kind, label, COALESCE(region,'')",                          order: 'updated_ms DESC, rowid DESC' },
  { t: 'comms_channels', key: "name, COALESCE(band,''), COALESCE(frequency,'')",           order: 'rowid ASC' },
  // --- sensitive / life-safety (opt-in) ---
  { t: 'damage_reports', key: 'photo_key',                                                 order: 'created_ms ASC', sensitive: true, note: 'fotos duplicadas (mismo photo_key)' },
  { t: 'persons',        key: "full_name, COALESCE(last_seen,''), COALESCE(contact_phone,'')", order: 'created_ms ASC', sensitive: true },
  { t: 'sos_alerts',     key: "lat, lon, COALESCE(phone,''), COALESCE(note,'')",            order: 'created_ms ASC', sensitive: true },
  { t: 'checkins',       key: "name, COALESCE(message,''), status",                         order: 'created_ms ASC', sensitive: true },
];

function d1(sql) {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;   // force the gmail OAuth wrangler session
  delete env.CLOUDFLARE_ACCOUNT_ID;
  const out = execSync(
    `npx wrangler d1 execute ${DB} --remote --json --command ${JSON.stringify(sql)}`,
    { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }
  );
  const json = JSON.parse(out);
  return (Array.isArray(json) ? json[0] : json)?.results ?? [];
}

let totalDups = 0;
console.log(`\nSISMO911 D1 dedupe — ${APPLY ? 'APPLY (deleting)' : 'DRY-RUN (no deletes)'}${SENSITIVE ? ' · incl. sensitive' : ' · safe tables only'}\n${'='.repeat(64)}`);

for (const cfg of TABLES) {
  if (cfg.sensitive && !SENSITIVE) { console.log(`· ${cfg.t.padEnd(16)} skipped (sensitive — add --include-sensitive)`); continue; }
  const groups = d1(
    `SELECT ${cfg.key}, COUNT(*) AS n FROM ${cfg.t} GROUP BY ${cfg.key} HAVING n > 1 ORDER BY n DESC`
  );
  const extra = groups.reduce((s, g) => s + (g.n - 1), 0);
  totalDups += extra;
  const tag = cfg.note ? ` [${cfg.note}]` : '';
  console.log(`\n▸ ${cfg.t}${tag}: ${groups.length} grupo(s) duplicado(s), ${extra} fila(s) sobrantes`);
  for (const g of groups.slice(0, 12)) {
    const label = Object.entries(g).filter(([k]) => k !== 'n').map(([, v]) => v).join(' | ');
    console.log(`    ${String(g.n).padStart(3)}×  ${label}`);
  }
  if (groups.length > 12) console.log(`    … y ${groups.length - 12} grupo(s) más`);

  if (APPLY && extra > 0) {
    const res = d1(
      `DELETE FROM ${cfg.t} WHERE rowid IN (
         SELECT rowid FROM (
           SELECT rowid, ROW_NUMBER() OVER (PARTITION BY ${cfg.key} ORDER BY ${cfg.order}) AS rn
           FROM ${cfg.t}
         ) WHERE rn > 1
       )`
    );
    console.log(`    ✓ eliminadas ${extra} fila(s) duplicada(s) (conservada 1 por grupo)`);
  }
}

console.log(`\n${'='.repeat(64)}\nTotal de filas sobrantes${APPLY ? ' eliminadas' : ' (sin tocar)'}: ${totalDups}`);
if (!APPLY && totalDups > 0) console.log('Para eliminar: vuelve a correr con --apply\n');
