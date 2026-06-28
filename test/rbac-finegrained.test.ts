import { describe, it, expect } from 'vitest';
import { evaluateGate } from '../src/rbac/route-policy';
import { expandRolePerms } from '../scripts/rbac-catalog.mjs';
import { getEffectivePermissions } from '../src/rbac/engine';
import { redactRow, redactRows, type FieldPolicy } from '../src/rbac/field-policy';

// ── R1: fine-grained per-surface gate (no more coarse ops:console) ───────────
describe('R1 — fine-grained route→permission gate', () => {
  const cases: Array<[string, string, string]> = [
    ['/api/flota/unidades', 'GET', 'flota:read'],
    ['/api/flota/unidades', 'POST', 'flota:dispatch'], // audit H1: writes require the write cap, not flota:read
    ['/api/admin/flota/live', 'GET', 'flota:track'],
    ['/api/admin/dedupe-personas', 'POST', 'admin:maintenance'],
    ['/api/contacts', 'POST', 'contacts:manage'],
    ['/api/resources', 'POST', 'resources:manage'],
    ['/api/acopio/status', 'POST', 'acopio:manage'],
    ['/api/danos-estructurales/x', 'POST', 'damage:moderate'],
    ['/api/aid-orgs/x', 'POST', 'aid_orgs:manage'],
    ['/api/emergencia', 'POST', 'emergencia:manage'],
    ['/api/suministros/productos', 'POST', 'suministros:manage'],
    ['/api/reports/queue', 'GET', 'reports:moderate'],
    ['/api/persons/queue', 'GET', 'persons:moderate'],
    ['/api/persons/abc/attachments', 'GET', 'persons:moderate'],
    ['/api/sos', 'GET', 'sos:triage'],
    ['/api/damage', 'GET', 'damage:moderate'],
    ['/api/events/refresh', 'POST', 'events:refresh'],
    ['/api/shelters/queue', 'GET', 'shelters:manage'],
    ['/api/sat/analyze', 'POST', 'sat:analyze'],
    ['/api/acopio/submissions', 'GET', 'acopio:manage'],
  ];

  it('maps each surface to its specific fine-grained permission', () => {
    for (const [p, m, perm] of cases) {
      const d = evaluateGate(p, m);
      expect(d.kind, `${m} ${p}`).toBe('perm');
      if (d.kind === 'perm') expect(d.perm, `${m} ${p}`).toBe(perm);
    }
  });

  it('no surface uses the deprecated coarse ops:console anymore', () => {
    for (const [p, m] of cases) {
      const d = evaluateGate(p, m);
      if (d.kind === 'perm') expect(d.perm).not.toBe('ops:console');
    }
  });

  it('access preserved: operator + super_admin hold every mapped perm; citizen none', () => {
    const op = expandRolePerms('operator');
    const sa = expandRolePerms('super_admin');
    const cit = expandRolePerms('citizen');
    for (const [, , perm] of cases) {
      expect(op.has(perm), `operator must hold ${perm}`).toBe(true);
      expect(sa.has(perm), `super_admin must hold ${perm}`).toBe(true);
      expect(cit.has(perm), `citizen must NOT hold ${perm}`).toBe(false);
    }
  });
});

// ── U4: temporary role expiry honored by the engine ─────────────────────────
function makeEngineEnv(userRoles: any[]) {
  const tables: any = {
    users: [{ id: 'u1', role: 'citizen', perm_epoch: 1 }],
    rbac_roles: [{ id: 'role_reader', key: 'reader', inherits_json: '[]' }],
    role_permissions: [{ role_id: 'role_reader', perm_key: 'incidents:read', effect: 'allow' }],
    user_roles: userRoles,
    user_permissions: [],
    rbac_permissions: [{ key: 'incidents:read' }],
  };
  const exec = (sql: string, args: any[], kind: string) => {
    if (/FROM users WHERE id = \?/.test(sql)) return tables.users.find((u: any) => u.id === args[0]) ?? null;
    if (/FROM user_roles WHERE user_id = \? AND \(expires_ms IS NULL OR expires_ms > \?\)/.test(sql)) {
      const now = args[1];
      return { results: tables.user_roles.filter((r: any) => r.user_id === args[0] && (r.expires_ms == null || r.expires_ms > now)) };
    }
    if (/FROM rbac_roles/.test(sql)) return { results: tables.rbac_roles };
    if (/FROM role_permissions/.test(sql)) return { results: tables.role_permissions };
    if (/FROM user_permissions WHERE user_id = \?/.test(sql)) return { results: [] };
    if (/SELECT key FROM rbac_permissions/.test(sql)) return { results: tables.rbac_permissions };
    return kind === 'all' ? { results: [] } : null;
  };
  const stmt = (sql: string, a: any[] = []): any => ({ bind: (...x: any[]) => stmt(sql, x), first: async () => exec(sql, a, 'first'), all: async () => exec(sql, a, 'all'), run: async () => ({}) });
  const kv = new Map<string, string>();
  return { DB: { prepare: (s: string) => stmt(s) }, CACHE: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v); } } } as any;
}

describe('U4 — temporary role expiry', () => {
  it('an unexpired temp role still grants its permissions', async () => {
    const env = makeEngineEnv([{ user_id: 'u1', role_id: 'role_reader', expires_ms: Date.now() + 60_000 }]);
    expect((await getEffectivePermissions(env, 'u1')).has('incidents:read')).toBe(true);
  });
  it('an expired temp role grants nothing', async () => {
    const env = makeEngineEnv([{ user_id: 'u1', role_id: 'role_reader', expires_ms: Date.now() - 60_000 }]);
    expect((await getEffectivePermissions(env, 'u1')).has('incidents:read')).toBe(false);
  });
  it('a permanent role (null expiry) is unaffected', async () => {
    const env = makeEngineEnv([{ user_id: 'u1', role_id: 'role_reader', expires_ms: null }]);
    expect((await getEffectivePermissions(env, 'u1')).has('incidents:read')).toBe(true);
  });
});

// ── R4: field-level redaction ───────────────────────────────────────────────
describe('R4 — field-level redaction', () => {
  const policies: FieldPolicy[] = [
    { resource: 'users', field: 'phone', visibility: 'perm', required_perm: 'users:read' },
    { resource: 'users', field: 'ssn', visibility: 'hidden', required_perm: null },
    { resource: 'users', field: 'name', visibility: 'visible', required_perm: null },
  ];
  const row = { id: 'u1', name: 'Ana', phone: '0412-555', ssn: 'X' };

  it('hidden fields are always stripped', () => {
    expect(redactRow(row, policies, new Set(['users:read'])).ssn).toBeUndefined();
  });
  it('perm-gated field is stripped without the permission', () => {
    expect(redactRow(row, policies, new Set()).phone).toBeUndefined();
  });
  it('perm-gated field is kept with the permission', () => {
    expect(redactRow(row, policies, new Set(['users:read'])).phone).toBe('0412-555');
  });
  it('visible fields always pass; arrays redact element-wise', () => {
    const out = redactRows([row, { ...row, id: 'u2' }], policies, new Set());
    expect(out.every((r) => r.name && r.phone === undefined && r.ssn === undefined)).toBe(true);
  });
});
