import type { Env } from '../types';

export type DedupeMode = 'exact' | 'loose' | 'photo' | 'fuzzyphone';

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
function partitionFor(mode: DedupeMode): string {
  if (mode === 'photo') return `lower(trim(foto))`;
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
    : opts.mode === 'fuzzyphone' ? 'fuzzyphone' : 'exact';
  const apply = !!opts.apply;
  const limit = Math.min(Math.max(opts.limit ?? 300, 1), 400);
  // photo mode must only group rows that actually have a photo, or it would
  // collapse every photoless row into one bogus group. fuzzyphone likewise needs
  // a real phone (≥7 digits) or every phoneless row would merge by name+age alone.
  const scope = mode === 'photo' ? `WHERE trim(coalesce(foto,'')) != ''`
    : mode === 'fuzzyphone' ? `WHERE length(${normPhoneSql('contacto')}) >= 7`
    : ``;
  const sql = `SELECT id, foto_r2 FROM (
      SELECT id, foto_r2, ROW_NUMBER() OVER (
        PARTITION BY ${partitionFor(mode)}
        ORDER BY (CASE WHEN foto_r2 IS NOT NULL THEN 0 ELSE 1 END), updated_at DESC, id ASC
      ) AS rn FROM personas ${scope}
    ) WHERE rn > 1`;
  const { results } = await env.DB.prepare(sql).all<{ id: string; foto_r2: string | null }>();
  const all = results ?? [];
  const found = all.length;
  if (!apply) return { mode, found, applied: false, deletedRows: 0, deletedPhotos: 0, remaining: found };

  const batch = all.slice(0, limit);
  let deletedPhotos = 0;
  for (const v of batch) {
    if (v.foto_r2) { try { await env.DESAP_FOTOS.delete(v.foto_r2); deletedPhotos++; } catch { /* ignore */ } }
  }
  let deletedRows = 0;
  const ids = batch.map((v) => v.id);
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    await env.DB.prepare(`DELETE FROM personas WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).run();
    deletedRows += chunk.length;
  }
  return { mode, found, applied: true, deletedRows, deletedPhotos, remaining: found - deletedRows };
}
