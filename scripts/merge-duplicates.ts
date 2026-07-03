#!/usr/bin/env bun
/**
 * merge-duplicates.ts — guarded, reversible, photo-safe duplicate merger for
 * the DESAP `personas` (Familia) registry.
 *
 * Mirrors the app's OWN canonical merge (src/routes/admin.ts POST /api/admin/dup/merge):
 *   UPDATE personas SET merged_into=<keep>, moderation='rejected' WHERE id=<loser>
 * The loser ROW AND ITS PHOTO ARE PRESERVED — nothing is ever deleted. Merged
 * losers just drop out of the approved list; a restore fully un-merges them.
 *
 * SAVE GUARDS (why this is safe to run):
 *   1. DRY-RUN by default. Writes ONLY with --apply.
 *   2. Every change is logged to `personas_merge_log` → fully reversible with
 *      --restore=<run_id>. No hard deletes, no R2 photo deletion, ever.
 *   3. SAFE modes only (exact | extid | phash | fuzzyphone). Name-only modes
 *      (loose/fuzzyname) merge distinct namesakes and are BLOCKED unless
 *      --allow-unsafe is passed (with a warning).
 *   4. PHOTO safeguard: the keeper is chosen has-photo-first; if it still lacks
 *      a photo but a loser has one, the keeper inherits foto+foto_r2 BEFORE the
 *      loser is hidden — so no photo is ever lost from view.
 *   5. STATUS safeguard: if a loser is localizado/hospitalizado/fallecido and the
 *      keeper is not, the keeper is upgraded (a "found" resolution is never lost).
 *   6. protected=1 rows are never touched. Idempotent: re-runs converge.
 *   7. Per-run --limit cap. Uses wrangler OAuth (no stored CF token).
 *
 * Usage:
 *   bun scripts/merge-duplicates.ts --mode=fuzzyphone            # dry-run report
 *   bun scripts/merge-duplicates.ts --mode=fuzzyphone --apply    # perform merges
 *   bun scripts/merge-duplicates.ts --mode=phash --apply --limit=100
 *   bun scripts/merge-duplicates.ts --restore=merge-fuzzyphone-1720000000000
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const REPO = '/Users/ricardoprieto/projects/sismo911';
const SCRATCH = '/private/tmp/claude-501/-Users-ricardoprieto/9d0122f6-882f-417b-a876-98ddcd3c0ef7/scratchpad';
const SAFE_MODES = ['exact', 'extid', 'phash', 'fuzzyphone'] as const;
const UNSAFE_MODES = ['loose', 'fuzzyname'] as const;
type Mode = (typeof SAFE_MODES)[number] | (typeof UNSAFE_MODES)[number];

// ---- args ----
const arg = (k: string) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : undefined; };
const flag = (k: string) => process.argv.includes(`--${k}`);
const mode = (arg('mode') || 'fuzzyphone') as Mode;
const apply = flag('apply');
const allowUnsafe = flag('allow-unsafe');
const limit = Math.max(1, Number(arg('limit') || 200));
const restoreRun = arg('restore');

// ---- wrangler plumbing (OAuth, no stored CF token — CLAUDE.md rule) ----
const env = { ...process.env } as Record<string, string>;
delete env.CLOUDFLARE_API_TOKEN; delete env.CLOUDFLARE_ACCOUNT_ID;
const WR = `npx wrangler d1 execute sismo911 --remote --env-file /dev/null`;
function run(cmd: string): string {
  let last: any;
  for (let i = 0; i < 5; i++) {
    try { return execSync(cmd, { cwd: REPO, env, maxBuffer: 1 << 28 }).toString(); }
    catch (e) { last = e; execSync('sleep 3'); }
  }
  throw last;
}
const jout = (o: string) => { const a = o.indexOf('['), b = o.lastIndexOf(']'); return JSON.parse(o.slice(a, b + 1)); };
const rows = (sql: string) => jout(run(`${WR} --json --command ${JSON.stringify(sql.replace(/\s+/g, ' ').trim())}`))[0].results as any[];
function execFile(sql: string) { const f = `${SCRATCH}/_merge.sql`; writeFileSync(f, sql); run(`${WR} --file ${f}`); }
const lit = (v: any) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

// ---- normalization SQL (mirrors src/lib/dedupe.ts exactly) ----
function normName(col = 'nombre') { let e = `lower(trim(${col}))`; for (const [a, b] of [['á', 'a'], ['é', 'e'], ['í', 'i'], ['ó', 'o'], ['ú', 'u'], ['ü', 'u'], ['ñ', 'n']]) e = `replace(${e},'${a}','${b}')`; return e; }
function normPhone(col = 'contacto') { let e = `coalesce(${col},'')`; for (const ch of [' ', '-', '+', '(', ')', '.']) e = `replace(${e},'${ch}','')`; return e; }

// Partition columns per mode (mirrors dedupe.ts partitionFor).
function partCols(m: Mode): string[] {
  if (m === 'extid') return ['origen', 'ext_id'];
  if (m === 'phash') return ['photo_phash'];
  if (m === 'fuzzyphone') return [normName('nombre'), 'coalesce(edad,-1)', normPhone('contacto')];
  if (m === 'loose') return [`lower(trim(nombre))`, `lower(trim(coalesce(ubicacion,'')))`];
  if (m === 'fuzzyname') return [normName('nombre'), 'coalesce(edad,-1)'];
  // exact
  return [`lower(trim(nombre))`, 'coalesce(edad,-1)', `lower(trim(coalesce(ubicacion,'')))`, `lower(trim(coalesce(descripcion,'')))`, `lower(trim(coalesce(contacto,'')))`];
}
// Only-active, only-approved, never-protected, not-already-merged.
const COMMON = `moderation='approved' AND (merged_into IS NULL OR trim(merged_into)='') AND coalesce(protected,0)=0`;
function scope(m: Mode): string {
  const s = m === 'extid' ? `AND trim(coalesce(ext_id,''))<>'' AND trim(coalesce(origen,''))<>''`
    : m === 'phash' ? `AND trim(coalesce(photo_phash,''))<>''`
    : m === 'fuzzyphone' ? `AND length(${normPhone('contacto')})>=7`
    : m === 'fuzzyname' ? `AND length(${normName('nombre')})>=5 AND instr(trim(nombre),' ')>0`
    : ``;
  return `WHERE ${COMMON} ${s}`;
}
const COMPLETENESS = `((CASE WHEN trim(coalesce(foto_r2,''))<>'' OR trim(coalesce(foto,''))<>'' THEN 1 ELSE 0 END)+(CASE WHEN trim(coalesce(contacto,''))<>'' THEN 1 ELSE 0 END)+(CASE WHEN trim(coalesce(descripcion,''))<>'' THEN 1 ELSE 0 END)+(CASE WHEN trim(coalesce(ubicacion,''))<>'' THEN 1 ELSE 0 END))`;
const STATUS_RANK: Record<string, number> = { 'sin-contacto': 0, '': 0, localizado: 1, hospitalizado: 2, fallecido: 3 };

const COLS = 'id,nombre,edad,estado,foto,foto_r2,reportes,localizado_por,localizado_contacto,localizado_relacion,localizado_nota,hospitalizado,fallecido,hospital_nombre,moderation,merged_into,protected,updated_at';

// ======================= RESTORE =======================
function ensureLog() {
  execFile(`CREATE TABLE IF NOT EXISTS personas_merge_log (run_id TEXT, ts INTEGER, mode TEXT, role TEXT, keep_id TEXT, loser_id TEXT, prev_moderation TEXT, prev_merged_into TEXT, keeper_before TEXT);`);
}
if (restoreRun) {
  ensureLog();
  const log = rows(`SELECT * FROM personas_merge_log WHERE run_id=${lit(restoreRun)}`);
  if (!log.length) { console.log(`No log rows for run ${restoreRun}.`); process.exit(0); }
  const stmts: string[] = [];
  for (const r of log) {
    if (r.role === 'loser') {
      stmts.push(`UPDATE personas SET merged_into=${lit(r.prev_merged_into)}, moderation=${lit(r.prev_moderation || 'approved')} WHERE id=${lit(r.loser_id)};`);
    } else if (r.role === 'keeper' && r.keeper_before) {
      const b = JSON.parse(r.keeper_before);
      stmts.push(`UPDATE personas SET foto=${lit(b.foto)}, foto_r2=${lit(b.foto_r2)}, estado=${lit(b.estado)}, localizado_por=${lit(b.localizado_por)}, localizado_contacto=${lit(b.localizado_contacto)}, localizado_relacion=${lit(b.localizado_relacion)}, localizado_nota=${lit(b.localizado_nota)}, hospitalizado=${lit(b.hospitalizado)}, fallecido=${lit(b.fallecido)}, hospital_nombre=${lit(b.hospital_nombre)}, reportes=${lit(b.reportes)} WHERE id=${lit(r.keep_id)};`);
    }
  }
  console.log(`Restore ${restoreRun}: ${stmts.length} statements${apply ? '' : '  (dry-run — pass --apply)'}`);
  if (apply) { for (let i = 0; i < stmts.length; i += 40) execFile(stmts.slice(i, i + 40).join('\n')); console.log('Restored (un-merged + keepers reverted).'); }
  process.exit(0);
}

// ======================= MERGE =======================
if (!SAFE_MODES.includes(mode as any)) {
  if (!allowUnsafe) { console.error(`Mode "${mode}" merges on name alone (namesake risk). Refusing. Re-run with --allow-unsafe to override.`); process.exit(1); }
  console.warn(`⚠️  UNSAFE mode "${mode}" — merges distinct namesakes. Review output carefully.`);
}
const parts = partCols(mode);
const partBy = parts.join(',');
const gk = parts.map((e) => `coalesce(cast(${e} as text),'')`).join("||'|~|'||");
const fetch = `SELECT * FROM (
  SELECT ${COLS}, ${gk} AS __gk,
    ROW_NUMBER() OVER (PARTITION BY ${partBy} ORDER BY ${COMPLETENESS} DESC,(CASE WHEN foto_r2 IS NOT NULL THEN 0 ELSE 1 END),updated_at DESC,id ASC) AS __rn,
    COUNT(*) OVER (PARTITION BY ${partBy}) AS __grp
  FROM personas ${scope(mode)}
) WHERE __grp>1 ORDER BY __gk, __rn`;

const members = rows(fetch);
// group by __gk
const groups: any[][] = [];
let cur: any[] = [];
for (const r of members) { if (r.__rn === 1) { if (cur.length) groups.push(cur); cur = [r]; } else cur.push(r); }
if (cur.length) groups.push(cur);
const capped = groups.slice(0, limit);

const now = Date.now();
const runId = `merge-${mode}-${now}`;
const has = (v: any) => v !== null && v !== undefined && String(v).trim() !== '';
const rank = (e: any) => STATUS_RANK[String(e ?? '')] ?? 0;

// Photo-hash modes group by image only — names are NOT in the key, so a shared/
// placeholder image can cluster DIFFERENT people. Guard: only merge members whose
// name agrees with the keeper; name-mismatches are routed to review, never merged.
const PHOTO_MODES = new Set(['phash', 'photo', 'dhash']);
const nameKey = (s: any) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ñ/g, 'n').replace(/[^a-z0-9]/g, '');

let totalLosers = 0, photoFixes = 0, statusFixes = 0, reviewCount = 0;
const stmts: string[] = [];
console.log(`\nMODE=${mode}  groups=${groups.length}  (processing ${capped.length}, cap=${limit})  apply=${apply}\n`);

for (const g of capped) {
  const keep = g[0];
  let losers = g.slice(1);
  let review: any[] = [];
  if (PHOTO_MODES.has(mode)) {
    const kk = nameKey(keep.nombre);
    review = losers.filter((l) => nameKey(l.nombre) !== kk);
    losers = losers.filter((l) => nameKey(l.nombre) === kk);
  }
  reviewCount += review.length;
  for (const r of review) console.log(`⚠ REVIEW (same photo, name differs — NOT merged): ${keep.id} "${keep.nombre}"  vs  ${r.id} "${r.nombre}"`);
  if (!losers.length) continue;
  totalLosers += losers.length;
  const before = { foto: keep.foto, foto_r2: keep.foto_r2, estado: keep.estado, localizado_por: keep.localizado_por, localizado_contacto: keep.localizado_contacto, localizado_relacion: keep.localizado_relacion, localizado_nota: keep.localizado_nota, hospitalizado: keep.hospitalizado, fallecido: keep.fallecido, hospital_nombre: keep.hospital_nombre, reportes: keep.reportes };

  // photo safeguard
  const keepSet: string[] = [];
  if (!has(keep.foto) && !has(keep.foto_r2)) {
    const src = losers.find((l) => has(l.foto) || has(l.foto_r2));
    if (src) { keepSet.push(`foto=${lit(src.foto)}`, `foto_r2=${lit(src.foto_r2)}`); photoFixes++; }
  }
  // status safeguard
  const best = g.reduce((a, b) => (rank(b.estado) > rank(a.estado) ? b : a), keep);
  if (rank(best.estado) > rank(keep.estado)) {
    keepSet.push(`estado=${lit(best.estado)}`, `localizado_por=${lit(best.localizado_por)}`, `localizado_contacto=${lit(best.localizado_contacto)}`, `localizado_relacion=${lit(best.localizado_relacion)}`, `localizado_nota=${lit(best.localizado_nota)}`, `hospitalizado=${lit(best.hospitalizado)}`, `fallecido=${lit(best.fallecido)}`, `hospital_nombre=${lit(best.hospital_nombre)}`);
    statusFixes++;
  }
  // sum reportes
  const sumRep = g.reduce((s, r) => s + (Number(r.reportes) || 0), 0);
  if (sumRep !== (Number(keep.reportes) || 0)) keepSet.push(`reportes=${sumRep}`);

  // report line
  console.log(`KEEP ${keep.id}  "${keep.nombre}"${has(keep.foto) || has(keep.foto_r2) || keepSet.some((s) => s.startsWith('foto')) ? ' 📷' : '  (no photo)'}`);
  for (const l of losers) console.log(`  merge← ${l.id}  "${l.nombre}"  ${has(l.foto) || has(l.foto_r2) ? '📷' : '—'}  estado=${l.estado}`);

  if (apply) {
    if (keepSet.length) { keepSet.push(`updated_at=${now}`); stmts.push(`UPDATE personas SET ${keepSet.join(',')} WHERE id=${lit(keep.id)};`); }
    stmts.push(`INSERT INTO personas_merge_log (run_id,ts,mode,role,keep_id,loser_id,prev_moderation,prev_merged_into,keeper_before) VALUES (${lit(runId)},${now},${lit(mode)},'keeper',${lit(keep.id)},NULL,NULL,NULL,${lit(JSON.stringify(before))});`);
    for (const l of losers) {
      stmts.push(`INSERT INTO personas_merge_log (run_id,ts,mode,role,keep_id,loser_id,prev_moderation,prev_merged_into,keeper_before) VALUES (${lit(runId)},${now},${lit(mode)},'loser',${lit(keep.id)},${lit(l.id)},${lit(l.moderation)},${lit(l.merged_into)},NULL);`);
      stmts.push(`UPDATE personas SET merged_into=${lit(keep.id)}, moderation='rejected', updated_at=${now} WHERE id=${lit(l.id)} AND (merged_into IS NULL OR trim(merged_into)='');`);
    }
  }
}

console.log(`\n──────── SUMMARY ────────`);
console.log(`mode=${mode}  groups=${capped.length}  losers-merged=${totalLosers}  photo-safeguards=${photoFixes}  status-upgrades=${statusFixes}  review-skipped=${reviewCount}`);
if (!apply) { console.log(`DRY-RUN — nothing written. Re-run with --apply to merge; every change is reversible via --restore=${runId}-…`); process.exit(0); }

ensureLog();
for (let i = 0; i < stmts.length; i += 40) execFile(stmts.slice(i, i + 40).join('\n'));
console.log(`APPLIED. run_id=${runId}  (undo: bun scripts/merge-duplicates.ts --restore=${runId} --apply)`);
