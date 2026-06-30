// Case change-detection for the email-alert subscription feature.
//
// A "case" is the unified investigation id (see caseExists() in
// routes/investigation.ts): `persons.id` | `fam-<personas.id>` | `hosp-<id>`.
// We snapshot the WATCHED fields of a case, hash them, and compare the hash
// across cron ticks. When it changes, the `case-alerts` cron emails subscribers
// an AI-written summary of WHAT changed (computed from diffCase()).
//
// Design: the pure functions (buildSnapshot / hashCaseState / diffCase) carry the
// logic and are unit-tested without a DB; caseStateSnapshot() is the thin IO layer.

import type { Env } from '../types';
import { sha256hex } from './email';

const FAM = 'fam-';
const HOSP = 'hosp-';

export interface CaseSnapshot {
  caseId: string;
  name: string;
  status: string;        // raw status token
  statusLabel: string;   // human-readable (ES)
  location: string;
  notes: string;
  reportCount: number;   // citizen report count (movement signal)
  verifiedLeads: number; // count of verified case_intel leads
  latestLead: string;    // title of the most recent verified lead
  priority: string;      // case_meta.priority
}

// Raw status token → human Spanish label, per source table.
export function statusLabelFor(caseId: string, raw: string | null | undefined): string {
  const s = (raw || '').trim();
  const famMap: Record<string, string> = {
    'sin-contacto': 'Sin contacto',
    'localizado': 'Localizado',
    'aparecido': 'Apareció / a salvo',
    'hospitalizado': 'Hospitalizado',
    'fallecido': 'Fallecido',
  };
  const personsMap: Record<string, string> = {
    'missing': 'Desaparecido',
    'found_safe': 'Encontrado a salvo',
    'found_deceased': 'Fallecido',
    'unknown': 'Desconocido',
  };
  if (caseId.startsWith(FAM) || caseId.startsWith(HOSP)) return famMap[s] || (s || 'Sin estado');
  return personsMap[s] || (s || 'Sin estado');
}

// Pure builder: assemble a normalized snapshot from already-fetched values.
export function buildSnapshot(input: {
  caseId: string;
  name?: string | null;
  status?: string | null;
  location?: string | null;
  notes?: string | null;
  reportCount?: number | null;
  verifiedLeads?: number | null;
  latestLead?: string | null;
  priority?: string | null;
}): CaseSnapshot {
  return {
    caseId: input.caseId,
    name: (input.name || '').trim(),
    status: (input.status || '').trim(),
    statusLabel: statusLabelFor(input.caseId, input.status),
    location: (input.location || '').trim(),
    notes: (input.notes || '').trim(),
    reportCount: Number(input.reportCount || 0),
    verifiedLeads: Number(input.verifiedLeads || 0),
    latestLead: (input.latestLead || '').trim(),
    priority: (input.priority || '').trim(),
  };
}

// The subset of fields whose change is worth an alert, in a STABLE order so the
// hash is deterministic regardless of object key ordering.
function watchedTuple(s: CaseSnapshot): unknown[] {
  return [s.status, s.statusLabel, s.location, s.notes, s.reportCount, s.verifiedLeads, s.latestLead, s.priority];
}

export async function hashCaseState(s: CaseSnapshot): Promise<string> {
  return sha256hex(JSON.stringify(watchedTuple(s)));
}

export interface CaseChange { field: string; label: string; from: string; to: string }

// Human-readable diff of the watched fields. `prev` null ⇒ no changes (first
// snapshot is the baseline, never an alert).
export function diffCase(prev: CaseSnapshot | null, next: CaseSnapshot): CaseChange[] {
  if (!prev) return [];
  const out: CaseChange[] = [];
  const push = (field: string, label: string, from: unknown, to: unknown) => {
    const a = String(from ?? ''); const b = String(to ?? '');
    if (a !== b) out.push({ field, label, from: a, to: b });
  };
  push('status', 'Estado', prev.statusLabel, next.statusLabel);
  push('location', 'Ubicación', prev.location, next.location);
  push('notes', 'Descripción', prev.notes, next.notes);
  push('reportCount', 'Reportes ciudadanos', prev.reportCount, next.reportCount);
  push('verifiedLeads', 'Pistas verificadas', prev.verifiedLeads, next.verifiedLeads);
  push('latestLead', 'Última pista', prev.latestLead, next.latestLead);
  push('priority', 'Prioridad', prev.priority, next.priority);
  return out;
}

// IO: resolve the source table by id prefix and assemble the snapshot. Returns
// null if the case no longer exists (e.g. deduped/removed) — caller skips it.
export async function caseStateSnapshot(env: Env, caseId: string): Promise<CaseSnapshot | null> {
  // Verified-lead aggregate (shared across all case types).
  const leadAgg = await env.DB.prepare(
    `SELECT COUNT(*) AS n,
            (SELECT title FROM case_intel WHERE person_id = ? AND status='verified' ORDER BY created_ms DESC LIMIT 1) AS latest
     FROM case_intel WHERE person_id = ? AND status='verified'`
  ).bind(caseId, caseId).first<any>().catch(() => null);
  const meta = await env.DB.prepare(`SELECT priority FROM case_meta WHERE person_id = ?`)
    .bind(caseId).first<any>().catch(() => null);
  const verifiedLeads = Number(leadAgg?.n || 0);
  const latestLead = leadAgg?.latest || '';
  const priority = meta?.priority || '';

  if (caseId.startsWith(FAM)) {
    const r = await env.DB.prepare(
      `SELECT nombre, estado, ubicacion, descripcion, reportes FROM personas WHERE id = ?`
    ).bind(caseId.slice(FAM.length)).first<any>().catch(() => null);
    if (!r) return null;
    return buildSnapshot({
      caseId, name: r.nombre, status: r.estado, location: r.ubicacion,
      notes: r.descripcion, reportCount: r.reportes, verifiedLeads, latestLead, priority,
    });
  }
  if (caseId.startsWith(HOSP)) {
    const r = await env.DB.prepare(
      `SELECT title, status FROM rav_reports WHERE id = ? AND kind='hospital'`
    ).bind(caseId.slice(HOSP.length)).first<any>().catch(() => null);
    if (!r) return null;
    return buildSnapshot({ caseId, name: r.title, status: r.status, verifiedLeads, latestLead, priority });
  }
  const r = await env.DB.prepare(
    `SELECT full_name, status, last_seen, notes FROM persons WHERE id = ?`
  ).bind(caseId).first<any>().catch(() => null);
  if (!r) return null;
  return buildSnapshot({
    caseId, name: r.full_name, status: r.status, location: r.last_seen,
    notes: r.notes, verifiedLeads, latestLead, priority,
  });
}
