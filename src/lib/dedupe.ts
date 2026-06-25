import type { Env } from '../types';

export interface DedupeReport {
  mode: 'exact' | 'loose';
  found: number;        // total duplicate (extra) rows detected
  applied: boolean;
  deletedRows: number;
  deletedPhotos: number;
  remaining: number;    // still-duplicate rows after this run
}

// Partition that defines "the same record":
//  exact → same name + age + location + description + contact (true re-scrapes; safe to auto-remove)
//  loose → same name + location only (may merge namesakes; operator-confirmed use only)
function partitionFor(mode: 'exact' | 'loose'): string {
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
  opts: { mode?: 'exact' | 'loose'; apply?: boolean; limit?: number } = {}
): Promise<DedupeReport> {
  const mode: 'exact' | 'loose' = opts.mode === 'loose' ? 'loose' : 'exact';
  const apply = !!opts.apply;
  const limit = Math.min(Math.max(opts.limit ?? 300, 1), 400);
  const sql = `SELECT id, foto_r2 FROM (
      SELECT id, foto_r2, ROW_NUMBER() OVER (
        PARTITION BY ${partitionFor(mode)}
        ORDER BY (CASE WHEN foto_r2 IS NOT NULL THEN 0 ELSE 1 END), updated_at DESC, id ASC
      ) AS rn FROM personas
    ) WHERE rn > 1`;
  const { results } = await env.DESAP.prepare(sql).all<{ id: string; foto_r2: string | null }>();
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
    await env.DESAP.prepare(`DELETE FROM personas WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).run();
    deletedRows += chunk.length;
  }
  return { mode, found, applied: true, deletedRows, deletedPhotos, remaining: found - deletedRows };
}
