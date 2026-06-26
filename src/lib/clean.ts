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
// only. Catches both junk names (empty/no-letter/test tokens) and link/email/domain
// spam names (e.g. "TRUSTEDF57 - infinityhotel.it") that slipped past the door.
export async function cleanPersonas(env: Env, opts: { apply?: boolean } = {}): Promise<CleanReport> {
  const apply = !!opts.apply;
  const where = `moderation = 'approved' AND ((${junkWhere('nombre')}) OR (${spamNameWhere('nombre')}) OR (${spamPhraseWhere('nombre')}))`;
  const scanned = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM personas WHERE ${where}`).first<{ n: number }>())?.n ?? 0;
  if (!apply || scanned === 0) return { scanned, flagged: 0, applied: false };
  await env.DB.prepare(`UPDATE personas SET moderation = 'rejected', updated_at = ? WHERE ${where}`).bind(Date.now()).run();
  return { scanned, flagged: scanned, applied: true };
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
