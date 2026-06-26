import type { Env } from '../types';

// Corruption / fake-data cleaner for the DESAP `personas` registry.
//
// The public API this data comes from is citizen-submitted and unmoderated, so
// it carries junk rows: empty names, all-digit/all-emoji "names", test/spam
// entries. We do NOT delete these (a life-safety DB stays auditable + reversible)
// — we set moderation='rejected', and every public read already filters
// moderation='approved', so junk never goes live. Operators can still see and
// un-reject via the admin tools. Pure-SQL so it runs identically in the Worker
// cron and in scripts/pull-familia.mjs.
//
// A name is considered junk when, after trimming, it: is empty / under 3 chars;
// contains NO letter at all (digits/punctuation/emoji only); is a single char
// repeated; or is an exact known test/placeholder token.

const JUNK_NAMES = [
  'test', 'testing', 'prueba', 'pruebas', 'asdf', 'asdfgh', 'qwerty', 'abc', 'abcd',
  'nombre', 'sin nombre', 'desconocido', 'desconocida', 'n/a', 'na', 'none', 'null',
  'xxx', 'xxxx', 'aaa', 'aaaa', 'ninguno', 'ninguna', '.', '..', '...', '-', '--',
];

// Known spam phrases that bots have flooded the missing-persons form with. A real
// missing-person report never carries these as a name. Matched as a substring
// (case-insensitive) so every variant is caught, including the lone flood-keeper
// that the namesake-safe flood cleaner intentionally leaves behind.
export const SPAM_PHRASES = [
  'simone buratti',
];

// TLDs that, appearing as a bare domain inside a NAME, mark it as link-spam.
// Mirrors DOMAIN_RE in lib/security.ts (nameHasSpam) but as a SQL clause so the
// cleaner can reject spam already sitting in the DB, not just block it at the door.
const SPAM_TLDS = [
  'it', 'com', 'net', 'org', 'info', 'biz', 'xyz', 'ru', 'cn', 'top', 'online',
  'site', 'click', 'link', 'shop', 'store', 'vip', 'live', 'club', 'icu', 'app', 'io', 'me', 'co',
];

// WHERE clause (without leading WHERE) matching a NAME that is really a link,
// email or bare domain — a real person name never contains these.
export function spamNameWhere(col = 'nombre'): string {
  const c = `lower(trim(${col}))`;
  return [
    `${c} LIKE '%http://%'`,
    `${c} LIKE '%https://%'`,
    `${c} LIKE '%www.%'`,
    `${col} LIKE '%@%.%'`,                                          // email-as-name
    ...SPAM_TLDS.map((t) => `${c} LIKE '%.${t}%'`),                 // bare domain (e.g. infinityhotel.it)
  ].map((x) => `(${x})`).join(' OR ');
}

// WHERE clause matching a NAME that contains a known spam phrase (substring,
// case-insensitive). Unlike the flood cleaner this has no count threshold, so the
// single approved keeper of a spam-name flood is caught too.
export function spamPhraseWhere(col = 'nombre'): string {
  const c = `lower(trim(${col}))`;
  return SPAM_PHRASES.map((p) => `${c} LIKE '%${p.replace(/'/g, "''")}%'`).map((x) => `(${x})`).join(' OR ');
}

// WHERE clause matching a NAME/TITLE that carries HTML/script-injection markup —
// stored-XSS abuse like '"><svg/onload=("@jofpin");>'. SQL twin of MARKUP_RE in
// lib/security.ts (nameHasMarkup). Scoped TIGHTLY to tag-open / handler / URI
// patterns (NOT a bare '<'/'>' LIKE that could catch a legit "grieta <5cm").
export function markupNameWhere(col = 'nombre'): string {
  const lc = `lower(trim(${col}))`;
  return [
    `${lc} GLOB '*<[a-z]*'`,          // HTML tag open: '<svg', '<img', '<script'
    `${lc} GLOB '*</[a-z]*'`,         // closing tag: '</a', '</svg'
    `${lc} LIKE '%javascript:%'`,
    `${lc} LIKE '%data:text/html%'`,
    `${lc} GLOB '*on[a-z]*=*'`,       // on*= event handler: onload=, onerror=, onclick=
  ].map((x) => `(${x})`).join(' OR ');
}

// WHERE clause (without leading WHERE) that matches a junk/corrupted row.
export function junkWhere(col = 'nombre'): string {
  const list = JUNK_NAMES.map((n) => `'${n.replace(/'/g, "''")}'`).join(', ');
  return [
    `trim(${col}) = ''`,
    `length(trim(${col})) < 3`,
    `${col} NOT GLOB '*[A-Za-zÀ-ÿ]*'`,                              // no letter anywhere → not a name
    `lower(trim(${col})) IN (${list})`,
    `length(replace(trim(${col}), substr(trim(${col}), 1, 1), '')) = 0`,   // one char repeated, e.g. "aaaa"
  ].map((c) => `(${c})`).join(' OR ');
}

export interface CleanReport { scanned: number; flagged: number; applied: boolean; }

// Flag corrupted/fake/spam personas as moderation='rejected'. apply=false reports
// only. Catches junk names (empty/no-letter/test tokens), link/email/domain spam
// names (e.g. "TRUSTEDF57 - infinityhotel.it"), AND HTML/script-injection markup
// names (e.g. '"><svg/onload=…') that slip past the door via the familia ingest.
export async function cleanPersonas(env: Env, opts: { apply?: boolean } = {}): Promise<CleanReport> {
  const apply = !!opts.apply;
  const where = `moderation = 'approved' AND ((${junkWhere('nombre')}) OR (${spamNameWhere('nombre')}) OR (${spamPhraseWhere('nombre')}) OR (${markupNameWhere('nombre')}))`;
  const scanned = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM personas WHERE ${where}`).first<{ n: number }>())?.n ?? 0;
  if (!apply || scanned === 0) return { scanned, flagged: 0, applied: false };
  await env.DB.prepare(`UPDATE personas SET moderation = 'rejected', updated_at = ? WHERE ${where}`).bind(Date.now()).run();
  return { scanned, flagged: scanned, applied: true };
}

export interface PurgeReport { found: number; deletedRows: number; deletedPhotos: number; remaining: number; applied: boolean; }

// Physically delete personas already flagged moderation='rejected' (confirmed
// junk/spam, hidden from public reads) plus their R2 photos. cleanPersonas /
// cleanNameFloods only soft-reject (auditable); this drains that backlog so it
// doesn't accumulate. Bounded by `limit` to stay within the Worker subrequest
// budget — convergent: repeated runs (the :15 cron or the admin button) finish
// the job. apply=false → count only.
export async function purgeRejectedPersonas(
  env: Env,
  opts: { apply?: boolean; limit?: number } = {},
): Promise<PurgeReport> {
  const apply = !!opts.apply;
  const limit = Math.min(Math.max(opts.limit ?? 300, 1), 400);
  const found = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM personas WHERE moderation='rejected'`).first<{ n: number }>())?.n ?? 0;
  if (!apply || found === 0) return { found, deletedRows: 0, deletedPhotos: 0, remaining: found, applied: false };
  const { results } = await env.DB.prepare(
    `SELECT id, foto_r2 FROM personas WHERE moderation='rejected' LIMIT ?`
  ).bind(limit).all<{ id: string; foto_r2: string | null }>();
  const batch = results ?? [];
  let deletedPhotos = 0;
  for (const r of batch) {
    if (r.foto_r2) { try { await env.DESAP_FOTOS.delete(r.foto_r2); deletedPhotos++; } catch { /* ignore */ } }
  }
  let deletedRows = 0;
  const ids = batch.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    await env.DB.prepare(`DELETE FROM personas WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).run();
    deletedRows += chunk.length;
  }
  return { found, deletedRows, deletedPhotos, remaining: found - deletedRows, applied: true };
}

export interface FloodReport { groups: number; flagged: number; applied: boolean; }

// Reject "name flood" corruption: a single name spammed across many rows with no
// real per-row detail. A genuine namesake cluster has varied descriptions (each
// family writes its own); corruption has ONE description across hundreds of rows
// (e.g. "SIMONE BURATTI GAY" ×353, 1 description / 192 locations). We keep the
// newest row per flagged name (auditable, reversible) and reject the rest. The
// threshold is deliberately conservative so real namesakes are never touched.
export async function cleanNameFloods(
  env: Env,
  opts: { apply?: boolean; minCount?: number } = {},
): Promise<FloodReport> {
  const apply = !!opts.apply;
  const minCount = opts.minCount ?? 25;
  const { results } = await env.DB.prepare(
    `SELECT lower(trim(nombre)) AS nm
       FROM personas WHERE moderation='approved'
      GROUP BY lower(trim(nombre))
     HAVING COUNT(*) > ?
        AND COUNT(DISTINCT lower(trim(coalesce(descripcion,'')))) <= 1`,
  ).bind(minCount).all<{ nm: string }>();
  const names = results ?? [];
  let flagged = 0;
  for (const { nm } of names) {
    const keeper = await env.DB.prepare(
      `SELECT id FROM personas WHERE moderation='approved' AND lower(trim(nombre)) = ?
        ORDER BY updated_at DESC, id LIMIT 1`,
    ).bind(nm).first<{ id: string }>();
    if (!keeper) continue;
    const extra = `moderation='approved' AND lower(trim(nombre)) = ? AND id <> ?`;
    const scanned = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM personas WHERE ${extra}`).bind(nm, keeper.id).first<{ n: number }>())?.n ?? 0;
    if (apply && scanned > 0) {
      await env.DB.prepare(`UPDATE personas SET moderation='rejected', updated_at = ? WHERE ${extra}`).bind(Date.now(), nm, keeper.id).run();
    }
    flagged += scanned;
  }
  return { groups: names.length, flagged, applied: apply && flagged > 0 };
}

// The one known operator-left test report row (a deploy-verification post, not a
// real damage report) — purged alongside the XSS markup rows.
export const TEST_REPORT_ID = 'rep_f7fdc6e7';

export interface MarkupPurgeReport {
  personas: number;
  persons: number;
  map_reports: number;
  testRow: number;
  applied: boolean;
}

// Physically DELETE stored-XSS abuse rows whose name/title carries HTML/script
// markup ('"><svg/onload=…') from personas (nombre), persons (full_name) and
// map_reports (title), plus the known test report TEST_REPORT_ID. Idempotent:
// re-running after a successful purge matches nothing → all counts 0. apply=false
// → count-only dry run (deletes nothing). Deletion is scoped tightly via
// markupNameWhere() (tag/handler/URI patterns) so legitimate missing-person or
// damage reports are never touched. personas R2 photos for matched rows are freed.
export async function purgeMarkupAbuse(
  env: Env,
  opts: { apply?: boolean } = {},
): Promise<MarkupPurgeReport> {
  const apply = !!opts.apply;
  const personasWhere = markupNameWhere('nombre');
  const personsWhere = markupNameWhere('full_name');
  const reportsWhere = `(${markupNameWhere('title')}) OR id = '${TEST_REPORT_ID}'`;

  const countOf = async (table: string, where: string) =>
    (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first<{ n: number }>())?.n ?? 0;

  const personas = await countOf('personas', personasWhere);
  const persons = await countOf('persons', personsWhere);
  const map_reports = await countOf('map_reports', reportsWhere);
  const testRow = await countOf('map_reports', `id = '${TEST_REPORT_ID}'`);

  if (!apply) return { personas, persons, map_reports, testRow, applied: false };

  // Free R2 photos for the matched personas before deleting their rows.
  if (personas > 0) {
    const { results } = await env.DB.prepare(
      `SELECT foto_r2 FROM personas WHERE ${personasWhere} AND foto_r2 IS NOT NULL`
    ).all<{ foto_r2: string }>();
    for (const r of results ?? []) {
      try { await env.DESAP_FOTOS.delete(r.foto_r2); } catch { /* ignore */ }
    }
  }

  await env.DB.prepare(`DELETE FROM personas WHERE ${personasWhere}`).run();
  await env.DB.prepare(`DELETE FROM persons WHERE ${personsWhere}`).run();
  await env.DB.prepare(`DELETE FROM map_reports WHERE ${reportsWhere}`).run();

  return { personas, persons, map_reports, testRow, applied: true };
}
