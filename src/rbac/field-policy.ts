/**
 * Field-level security (Phase 2 R4).
 *
 * `field_policies` rows declare, per (resource, field), a visibility:
 *   - 'visible'  → always returned
 *   - 'hidden'   → always stripped from read payloads
 *   - 'perm'     → returned only if the caller holds `required_perm`
 *   - 'readonly' → returned on reads (it only constrains writes); kept here
 *
 * `redactFields()` strips the fields a caller may not see BEFORE the row leaves
 * the Worker — enforcement is server-side, never the client's job. Routes call it
 * on any payload containing sensitive columns (e.g. users.phone, patients.medical_notes,
 * persons.gov_id, incidents.gps). Policies are cached for the request via the
 * passed-in policy list so a list endpoint loads them once.
 */
import type { Env } from '../types';

export interface FieldPolicy {
  resource: string;
  field: string;
  visibility: 'visible' | 'hidden' | 'perm' | 'readonly';
  required_perm: string | null;
}

/** Load the field policies for a resource (small table; one query per request). */
export async function loadFieldPolicies(env: Env, resource: string, orgId = 'org_sismo911'): Promise<FieldPolicy[]> {
  const r = await env.DB
    .prepare('SELECT resource, field, visibility, required_perm FROM field_policies WHERE org_id = ? AND resource = ?')
    .bind(orgId, resource)
    .all<FieldPolicy>()
    .catch(() => null);
  return (r?.results ?? []) as FieldPolicy[];
}

/** Strip fields the caller may not see from a single row. Returns a shallow copy. */
export function redactRow<T extends Record<string, any>>(row: T, policies: FieldPolicy[], perms: Set<string>): Partial<T> {
  if (!row || !policies.length) return row;
  const out: Record<string, any> = { ...row };
  for (const p of policies) {
    if (!(p.field in out)) continue;
    if (p.visibility === 'hidden') delete out[p.field];
    else if (p.visibility === 'perm' && !(p.required_perm && perms.has(p.required_perm))) delete out[p.field];
  }
  return out as Partial<T>;
}

/** Strip fields from an array of rows. */
export function redactRows<T extends Record<string, any>>(rows: T[], policies: FieldPolicy[], perms: Set<string>): Partial<T>[] {
  if (!policies.length) return rows;
  return rows.map((r) => redactRow(r, policies, perms));
}

/** Convenience: load policies then redact. */
export async function redactFields<T extends Record<string, any>>(
  env: Env,
  resource: string,
  data: T | T[],
  perms: Set<string>,
  orgId = 'org_sismo911',
): Promise<Partial<T> | Partial<T>[]> {
  const policies = await loadFieldPolicies(env, resource, orgId);
  return Array.isArray(data) ? redactRows(data, policies, perms) : redactRow(data, policies, perms);
}
