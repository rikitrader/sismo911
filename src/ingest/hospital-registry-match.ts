import type { Env } from '../types';
import { normName } from '../lib/hospital-registry';
import { logAgentActivity, missingStats, missingPhrase } from '../lib/agent-activity';

// Cross-reference the hospital_patients registry against the missing-persons cases.
// Mirrors src/ingest/hospital-match.ts: build an index of the SMALL set (unmatched
// patients), drain pages of the LARGE set (cases) via a KV cursor, and on a name hit
// LINK the patient ↔ case and add a tracer (person_events) note. Honesty/hybrid policy:
//   • name-only match  → review='pending' note, status UNCHANGED (operator verifies).
//   • cédula-confirmed (case_identity cédula == patient cédula) → auto status flip
//     (hospitalizado / fallecido) ONLY if the case is still unresolved, + a
//     status_change tracer. Ambiguous names (one norm key → many patients) are skipped.

interface PatientHit { id: string; cedula: string; estado: string; hospital: string; full_name: string; }

async function buildIndex(env: Env): Promise<Map<string, PatientHit | null>> {
  // null value marks an AMBIGUOUS key (matches >1 patient) → never auto-link.
  const idx = new Map<string, PatientHit | null>();
  const { results } = await env.DB.prepare(
    `SELECT id, cedula, estado, hospital, full_name, name_variants
       FROM hospital_patients WHERE match_confidence='none'`,
  ).all<any>();
  for (const r of results ?? []) {
    let names: string[] = [];
    try { names = JSON.parse(r.name_variants || '[]'); } catch { /* */ }
    if (!names.length) names = [r.full_name];
    const hit: PatientHit = { id: String(r.id), cedula: String(r.cedula || ''), estado: String(r.estado), hospital: String(r.hospital || 'Hospital'), full_name: String(r.full_name) };
    for (const nm of names) {
      const k = normName(nm);
      if (k.length < 6) continue;                 // too short → name collisions
      if (idx.has(k)) idx.set(k, null);           // seen before → ambiguous
      else idx.set(k, hit);
    }
  }
  return idx;
}

const KV_PHASE = 'hospreg:match:phase';
const KV_CURSOR = 'hospreg:match:cursor';

export async function drainHospitalRegistryMatch(env: Env, opts: { pages?: number; pageSize?: number } = {}): Promise<{ phase: string; scanned: number; matched: number; done: boolean }> {
  const pages = Math.min(Math.max(opts.pages ?? 6, 1), 20);
  const pageSize = Math.min(Math.max(opts.pageSize ?? 500, 50), 1000);
  const now = Date.now();
  const idx = await buildIndex(env);
  if (idx.size === 0) { await env.CACHE.put(KV_PHASE, 'done'); return { phase: 'done', scanned: 0, matched: 0, done: true }; }

  let phase = (await env.CACHE.get(KV_PHASE)) || 'personas';
  if (phase === 'done') { phase = 'personas'; await env.CACHE.delete(KV_CURSOR); }   // restart sweep
  let cursor = (await env.CACHE.get(KV_CURSOR)) || '';
  let scanned = 0, matched = 0;

  for (let p = 0; p < pages; p++) {
    const isFam = phase === 'personas';
    const rows = isFam
      ? (await env.DB.prepare(
          `SELECT id, nombre AS name FROM personas
            WHERE id > ? AND moderation='approved' AND estado NOT IN ('localizado','fallecido','hospitalizado','aparecido')
            ORDER BY id LIMIT ?`).bind(cursor, pageSize).all<any>()).results
      : (await env.DB.prepare(
          `SELECT id, full_name AS name FROM persons
            WHERE id > ? AND status='missing' AND review='approved'
            ORDER BY id LIMIT ?`).bind(cursor, pageSize).all<any>()).results;
    const list = rows ?? [];
    scanned += list.length;

    for (const r of list) {
      const hit = idx.get(normName(r.name));
      if (!hit) continue;                          // miss or ambiguous (null)
      const caseId = isFam ? 'fam-' + r.id : String(r.id);

      // cédula-confirm via the operator-only identity table.
      let high = false;
      if (hit.cedula) {
        const ci: any = await env.DB.prepare(
          `SELECT 1 FROM case_identity WHERE person_id=? AND cedula=? AND result IN ('match','manual') LIMIT 1`,
        ).bind(caseId, hit.cedula).first().catch(() => null);
        high = !!ci;
      }
      const conf = high ? 'high' : 'low';

      // Link the patient (idempotent — buildIndex only returns match_confidence='none').
      const linkCol = isFam ? 'matched_persona_id' : 'matched_person_id';
      await env.DB.prepare(
        `UPDATE hospital_patients SET ${linkCol}=?, match_kind=?, match_confidence=?, matched_ms=? WHERE id=? AND match_confidence='none'`,
      ).bind(String(r.id), high ? 'cedula' : 'name', conf, now, hit.id).run();
      idx.set(normName(hit.full_name), undefined as any);   // don't re-link this patient this tick

      const evId = 'hpm_' + caseId.replace(/[^a-zA-Z0-9]/g, '').slice(-14) + '_' + hit.id.slice(-8);
      const estLabel = hit.estado === 'fallecido' ? 'fallecido' : hit.estado === 'alta' ? 'dado de alta' : 'hospitalizado';
      const detail = `🏥 Registro hospitalario: ${hit.full_name} — ${estLabel} en ${hit.hospital} (Registro Maestro de Pacientes). ${high ? 'Cédula verificada.' : 'Coincidencia de nombre — verificar identidad.'}`;

      if (high && (hit.estado === 'hospitalizado' || hit.estado === 'fallecido')) {
        // Auto status flip (only when the case is still unresolved).
        const newEstado = hit.estado === 'fallecido' ? 'fallecido' : 'hospitalizado';
        const newStatus = hit.estado === 'fallecido' ? 'found_deceased' : 'hospitalizado';
        if (isFam) await env.DB.prepare(`UPDATE personas SET estado=?, updated_at=? WHERE id=? AND estado NOT IN ('localizado','fallecido','hospitalizado','aparecido')`).bind(newEstado, now, r.id).run();
        else await env.DB.prepare(`UPDATE persons SET status=?, updated_ms=? WHERE id=? AND status='missing'`).bind(newStatus, now, r.id).run();
        await env.DB.prepare(
          `INSERT OR IGNORE INTO person_events (id, person_id, kind, status_from, status_to, detail, source, review, created_ms)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        ).bind(evId, caseId, 'status_change', 'missing', newStatus, detail, 'system', 'approved', now).run();
      } else {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO person_events (id, person_id, kind, status_to, detail, source, review, created_ms)
           VALUES (?,?,?,?,?,?,?,?)`,
        ).bind(evId, caseId, 'hospital', null, detail, 'system', 'pending', now).run();
      }
      matched++;
    }

    if (list.length < pageSize) { phase = isFam ? 'persons' : 'done'; cursor = ''; if (phase === 'done') break; }
    else cursor = String(list[list.length - 1].id);
  }

  await env.CACHE.put(KV_PHASE, phase);
  await env.CACHE.put(KV_CURSOR, cursor);
  if (matched > 0) {
    const m = await missingStats(env).catch(() => ({ total: 0, unique: 0 }));
    await logAgentActivity(env, { source: 'hospital-registry-match', action: 'match', matched, stillMissing: m.total, stillUnique: m.unique,
      summary: `🏥 Cruce registro hospitalario — ${matched} caso(s) enlazado(s) a un ingreso (nota en el expediente, pendiente de verificación salvo cédula confirmada). ${missingPhrase(m)}.`, ok: true });
  }
  return { phase, scanned, matched, done: phase === 'done' };
}
