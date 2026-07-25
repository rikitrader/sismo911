import type { Env } from '../types';
import { parseXlsxRows } from '../lib/xlsx-lite';
import { mapSheetRows, upsertHospitalRows, collapseHospitalDupes } from '../lib/hospital-ingest';
import { logAgentActivity } from '../lib/agent-activity';

// The source publishes a stable "Actualizado" stamp. Keep it in KV so a
// six-hour cron does not re-upsert the same snapshot or run the full duplicate
// collapse query when the upstream feed has not changed.
export const HOSPITAL_SOURCE_MARKER_KEY = 'hospital-registry:source-updated';

// Recurring pull of the hospital patient registry. Fetches the configured feed
// (HOSPITAL_FEED_URL — an .xlsx direct-download), parses it in-Worker with the
// dependency-free xlsx-lite reader, and re-ingests (idempotent upsert by dedupe_key).
// No silent failure: a missing URL / fetch / parse error is logged to agent_activity.

export async function ingestHospitalRegistry(env: Env): Promise<{ ok: boolean; written?: number; collapsed?: number; reason?: string }> {
  const url = (env.HOSPITAL_FEED_URL || '').trim();
  if (!url) return { ok: false, reason: 'no_feed_url' };   // unconfigured → no-op (not an error)
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'sismo911-hospital-sync', accept: 'application/octet-stream' } });
    if (!res.ok) throw new Error('fetch_' + res.status);
    const buf = await res.arrayBuffer();
    const rows = await parseXlsxRows(buf);
    const { source_updated, patients } = mapSheetRows(rows);
    if (!patients.length) throw new Error('no_rows_parsed');
    if (source_updated) {
      const previous = await env.CACHE.get(HOSPITAL_SOURCE_MARKER_KEY);
      if (previous === source_updated)
        return { ok: true, written: 0, collapsed: 0, reason: 'unchanged_source' };
    }
    const out = await upsertHospitalRows(env, patients, source_updated);
    // Self-heal duplicates each pull: the source lists some people both with and
    // without a cédula (and under hospital-name variants), so an upsert alone can
    // leave duplicate rows. collapseHospitalDupes merges them (reversible).
    // A new upstream snapshot is an explicit reason to run the otherwise
    // six-hour-cooldown duplicate collapse.
    const col = await collapseHospitalDupes(env, { force: true });
    if (col.reason) throw new Error(col.reason);
    if (source_updated)
      await env.CACHE.put(HOSPITAL_SOURCE_MARKER_KEY, source_updated);
    await logAgentActivity(env, {
      source: 'hospital-registry-sync', action: 'ingest', fetched: patients.length, created: out.written,
      summary: `🏥 Registro hospitalario actualizado — ${out.written} paciente(s)${col.collapsed ? `, ${col.collapsed} duplicado(s) fusionado(s)` : ''} (fuente: ${source_updated || 's/f'}).`, ok: true,
    });
    return { ok: true, written: out.written, collapsed: col.collapsed };
  } catch (e: any) {
    const reason = String(e?.message || e).slice(0, 120);
    await logAgentActivity(env, { source: 'hospital-registry-sync', action: 'ingest', ok: false,
      summary: `⚠ Fallo al actualizar el registro hospitalario: ${reason}.` }).catch(() => {});
    console.error('[hospital-registry-sync]', reason);
    return { ok: false, reason };
  }
}
