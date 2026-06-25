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

// Flag corrupted/fake personas as moderation='rejected'. apply=false reports only.
export async function cleanPersonas(env: Env, opts: { apply?: boolean } = {}): Promise<CleanReport> {
  const apply = !!opts.apply;
  const where = `moderation = 'approved' AND (${junkWhere('nombre')})`;
  const scanned = (await env.DESAP.prepare(`SELECT COUNT(*) AS n FROM personas WHERE ${where}`).first<{ n: number }>())?.n ?? 0;
  if (!apply || scanned === 0) return { scanned, flagged: 0, applied: false };
  await env.DESAP.prepare(`UPDATE personas SET moderation = 'rejected', updated_at = ? WHERE ${where}`).bind(Date.now()).run();
  return { scanned, flagged: scanned, applied: true };
}
