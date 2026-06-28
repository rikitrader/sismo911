import { describe, it, expect } from 'vitest';
import { makeDb, makeEnv, type D1Mock, RBAC_MIGRATIONS } from './helpers/d1';
import { getEffectivePermissions } from '../src/rbac/engine';
import { loadFieldPolicies, redactRow, redactRows } from '../src/rbac/field-policy';

// Audit finding M1 (field-level security full coverage).
//
// This proves the SEEDED field_policies (migrations/0047_rbac_seed.sql) plus the
// redact* mechanism actually enforce, end-to-end, against the REAL effective
// permissions resolved by the engine:
//   fp_003 patients.medical_notes  → perm patients:medical_notes
//   fp_005 persons.gov_id          → perm users:read
//   fp_006 incidents.gps           → perm incidents:gps
// A super_admin (legacy `admin`) holds every catalog permission; a `citizen`
// holds none — so redactRow must KEEP each field for the admin and STRIP it for
// the citizen, driven only by the seeded policy + the caller's perms.
//
// NOTE on production wiring: no SISMO911 route currently returns a column literally
// named `gov_id`, `medical_notes`, or `gps` (those policies describe a generic
// workforce/EMS schema SISMO911 has not implemented). The genuinely-returned PII
// (telemed `patient_cedula`, `telemed_consult_notes.body`, person contact/coords)
// is already redacted server-side by bespoke per-role logic. This test therefore
// guards the policy MECHANISM so that the instant such a column is added to a
// payload, the seeded policy enforces it. See the PR/report for the donations.amount
// seed recommendation.

async function setup() {
  const db: D1Mock = makeDb(RBAC_MIGRATIONS);
  // getUserFromRequest selects these; harmless here but keeps the env honest.
  db.raw.exec('ALTER TABLE users ADD COLUMN wallet_address TEXT');
  db.raw.exec('ALTER TABLE users ADD COLUMN must_change_pw INTEGER NOT NULL DEFAULT 0');
  db.raw.exec('ALTER TABLE users ADD COLUMN mfa_required INTEGER NOT NULL DEFAULT 0');
  const env = makeEnv(db);

  const now = Date.now();
  const ins = db.raw.prepare(
    `INSERT INTO users (id,email,name,role,pw_hash,pw_salt,status,created_ms) VALUES (?,?,?,?,?,?,?,?)`,
  );
  ins.run('usr_admin', 'admin@s.com', 'Admin', 'admin', 'h', 's', 'active', now);   // legacy admin → super_admin (all perms)
  ins.run('usr_cit', 'cit@s.com', 'Cit', 'citizen', 'h', 's', 'active', now);       // citizen → no perms

  const adminPerms = await getEffectivePermissions(env as any, 'usr_admin');
  const citPerms = await getEffectivePermissions(env as any, 'usr_cit');
  return { env, adminPerms, citPerms };
}

describe('field-redaction coverage — seeded field_policies enforce', () => {
  it('engine resolves the gating perms for the holder and not the citizen', async () => {
    const { adminPerms, citPerms } = await setup();
    for (const perm of ['incidents:gps', 'users:read', 'patients:medical_notes']) {
      expect(adminPerms.has(perm)).toBe(true);
      expect(citPerms.has(perm)).toBe(false);
    }
  });

  it('incidents.gps: stripped without incidents:gps, kept for an operator who holds it', async () => {
    const { env, adminPerms, citPerms } = await setup();
    const policies = await loadFieldPolicies(env as any, 'incidents');
    expect(policies.some((p) => p.field === 'gps' && p.required_perm === 'incidents:gps')).toBe(true);

    const row = { id: 'inc1', gps: '10.5,-66.9', label: 'collapse' };
    expect(redactRow(row, policies, citPerms)).toEqual({ id: 'inc1', label: 'collapse' }); // gps stripped
    expect(redactRow(row, policies, adminPerms)).toEqual(row);                              // gps kept
  });

  it('persons.gov_id: stripped without users:read, kept for a caller who holds it', async () => {
    const { env, adminPerms, citPerms } = await setup();
    const policies = await loadFieldPolicies(env as any, 'persons');
    expect(policies.some((p) => p.field === 'gov_id' && p.required_perm === 'users:read')).toBe(true);

    const row = { id: 'p1', full_name: 'Ana', gov_id: 'V-12345678' };
    expect(redactRow(row, policies, citPerms)).toEqual({ id: 'p1', full_name: 'Ana' }); // gov_id stripped
    expect('gov_id' in redactRow(row, policies, adminPerms)).toBe(true);                 // gov_id kept
  });

  it('patients.medical_notes: only visible to patients:medical_notes holders', async () => {
    const { env, adminPerms, citPerms } = await setup();
    const policies = await loadFieldPolicies(env as any, 'patients');
    expect(policies.some((p) => p.field === 'medical_notes' && p.required_perm === 'patients:medical_notes')).toBe(true);

    const rows = [
      { id: 'pt1', name: 'Luis', medical_notes: 'fractura expuesta' },
      { id: 'pt2', name: 'Sara', medical_notes: 'shock' },
    ];
    const forCit = redactRows(rows, policies, citPerms);
    expect(forCit.every((r) => !('medical_notes' in r))).toBe(true);  // all stripped for citizen
    const forAdmin = redactRows(rows, policies, adminPerms);
    expect(forAdmin.every((r) => 'medical_notes' in r)).toBe(true);   // all kept for holder
  });

  it('redaction only ever removes fields — never adds or mutates the source row', async () => {
    const { env, citPerms } = await setup();
    const policies = await loadFieldPolicies(env as any, 'incidents');
    const row = { id: 'inc2', gps: '1,2', note: 'x' };
    const safe = redactRow(row, policies, citPerms);
    expect(row.gps).toBe('1,2');                          // source untouched (shallow copy)
    expect(Object.keys(safe)).toEqual(['id', 'note']);    // no extra keys introduced
  });
});
