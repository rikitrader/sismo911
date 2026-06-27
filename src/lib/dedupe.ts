import type { Env } from '../types';
import { deleteByIds, deletePhotos } from './sql';

export type DedupeMode = 'exact' | 'loose' | 'photo' | 'fuzzyphone' | 'fuzzyname' | 'phash' | 'dhash';

// Accent/case/space-insensitive normalized name (Spanish diacritics → ASCII).
// lower() first, then fold the lowercase accented vowels + ñ/ü. Used so that
// "Aron sánchez", "Aron sanchez" collapse to one key.
function normNameSql(col = 'nombre'): string {
  let e = `lower(trim(${col}))`;
  for (const [a, b] of [['á', 'a'], ['é', 'e'], ['í', 'i'], ['ó', 'o'], ['ú', 'u'], ['ü', 'u'], ['ñ', 'n']]) {
    e = `replace(${e}, '${a}', '${b}')`;
  }
  return e;
}
// Phone normalized to digits only (strip spaces, punctuation, +, parens).
function normPhoneSql(col = 'contacto'): string {
  let e = `coalesce(${col}, '')`;
  for (const ch of [' ', '-', '+', '(', ')', '.']) e = `replace(${e}, '${ch}', '')`;
  return e;
}

export interface DedupeReport {
  mode: DedupeMode;
  found: number;        // total duplicate (extra) rows detected
  applied: boolean;
  deletedRows: number;
  deletedPhotos: number;
  remaining: number;    // still-duplicate rows after this run
}

// Partition that defines "the same record":
//  exact → same name + age + location + description + contact (true re-scrapes; safe to auto-remove)
//  photo → same photo URL (same image reused across records; safe to auto-remove)
//  loose → same name + location only (may merge namesakes; operator-confirmed use only)
//  phash → same photo CONTENT hash (byte-identical image re-hosted at a different
//          URL across sources — what same-foto-URL dedupe misses)
function partitionFor(mode: DedupeMode): string {
  if (mode === 'photo') return `lower(trim(foto))`;
  if (mode === 'phash') return `photo_phash`;
  if (mode === 'dhash') return `photo_dhash`;
  if (mode === 'fuzzyname') return `${normNameSql('nombre')}, coalesce(edad,-1)`;
  if (mode === 'fuzzyphone') return `${normNameSql('nombre')}, coalesce(edad,-1), ${normPhoneSql('contacto')}`;
  return mode === 'loose'
    ? `lower(trim(nombre)), lower(trim(coalesce(ubicacion,'')))`
    : `lower(trim(nombre)), coalesce(edad,-1), lower(trim(coalesce(ubicacion,''))), lower(trim(coalesce(descripcion,''))), lower(trim(coalesce(contacto,'')))`;
}

// Find duplicate "extra" rows (everything but the best keeper per group) in the
// DESAP `personas` registry. The keeper is the row WITH a photo, then the most
// recently updated, then the smallest id. When apply=true, delete up to `limit`
// of them plus their R2 photos. The cap keeps one invocation within Worker
// subrequest limits; repeated runs (daily cron or the admin button) converge.
export async function dedupePersonas(
  env: Env,
  opts: { mode?: DedupeMode; apply?: boolean; limit?: number } = {}
): Promise<DedupeReport> {
  const mode: DedupeMode = opts.mode === 'loose' ? 'loose' : opts.mode === 'photo' ? 'photo'
    : opts.mode === 'fuzzyphone' ? 'fuzzyphone' : opts.mode === 'fuzzyname' ? 'fuzzyname'
    : opts.mode === 'phash' ? 'phash' : opts.mode === 'dhash' ? 'dhash' : 'exact';
  const apply = !!opts.apply;
  const limit = Math.min(Math.max(opts.limit ?? 300, 1), 400);
  // photo mode must only group rows that actually have a photo, or it would
  // collapse every photoless row into one bogus group. fuzzyphone needs a real
  // phone (≥7 digits). fuzzyname groups by name+age alone — scope it to a real
  // first+last name (a space, ≥5 chars) so single-token names don't over-merge.
  const scope = mode === 'photo' ? `WHERE trim(coalesce(foto,'')) != ''`
    : mode === 'phash' ? `WHERE trim(coalesce(photo_phash,'')) != ''`
    : mode === 'dhash' ? `WHERE trim(coalesce(photo_dhash,'')) != '' AND photo_dhash NOT LIKE 'dead:%' AND photo_dhash NOT IN ('0000000000000000','ffffffffffffffff')`
    : mode === 'fuzzyphone' ? `WHERE length(${normPhoneSql('contacto')}) >= 7`
    : mode === 'fuzzyname' ? `WHERE length(${normNameSql('nombre')}) >= 5 AND instr(trim(nombre), ' ') > 0`
    : ``;
  // Keeper = the most COMPLETE row (most non-empty fields), then has-R2-photo,
  // then newest, then smallest id. Deleting the sparser duplicates preserves info.
  const completeness = `(
      (CASE WHEN trim(coalesce(foto_r2,'')) != '' OR trim(coalesce(foto,'')) != '' THEN 1 ELSE 0 END) +
      (CASE WHEN trim(coalesce(contacto,'')) != '' THEN 1 ELSE 0 END) +
      (CASE WHEN trim(coalesce(descripcion,'')) != '' THEN 1 ELSE 0 END) +
      (CASE WHEN trim(coalesce(ubicacion,'')) != '' THEN 1 ELSE 0 END)
    )`;
  // SAFETY (perceptual hash only): a dHash can collide on DIFFERENT people whose
  // photos are visually similar (blank/placeholder/dark) — a real danger in a
  // missing-persons DB. So for `dhash`, only collapse SMALL clusters (2..6 rows =
  // the same person across a few sources); a large same-dHash cluster signals a
  // shared placeholder/generic image and is left untouched. `grp` is the cluster
  // size; the guard is a no-op for the exact-match modes.
  const grpGuard = mode === 'dhash' ? `AND grp BETWEEN 2 AND 6` : ``;
  const sql = `SELECT id, foto_r2 FROM (
      SELECT id, foto_r2,
        ROW_NUMBER() OVER (
          PARTITION BY ${partitionFor(mode)}
          ORDER BY ${completeness} DESC, (CASE WHEN foto_r2 IS NOT NULL THEN 0 ELSE 1 END), updated_at DESC, id ASC
        ) AS rn,
        COUNT(*) OVER (PARTITION BY ${partitionFor(mode)}) AS grp
      FROM personas ${scope}
    ) WHERE rn > 1 ${grpGuard}`;
  const { results } = await env.DB.prepare(sql).all<{ id: string; foto_r2: string | null }>();
  const all = results ?? [];
  const found = all.length;
  if (!apply) return { mode, found, applied: false, deletedRows: 0, deletedPhotos: 0, remaining: found };

  const batch = all.slice(0, limit);
  const deletedPhotos = await deletePhotos(env.DESAP_FOTOS, batch.map((v) => v.foto_r2));
  const deletedRows = await deleteByIds(env.DB, 'personas', batch.map((v) => v.id));
  return { mode, found, applied: true, deletedRows, deletedPhotos, remaining: found - deletedRows };
}
