import { describe, it, expect } from 'vitest';
import { makeDb, makeEnv, type D1Mock } from './helpers/d1';
import { hashPassword } from '../src/lib/auth';
import { hasPermission } from '../src/rbac/engine';
import { evaluateGate } from '../src/rbac/route-policy';

// Proves SUMINISTROS per-area least-privilege end-to-end through the real RBAC
// engine: a user assigned only an area role holds that area's permission and
// NOTHING else (no other area, no ops:console), and the route gate maps each
// inventory write path to the correct area permission.
const MIGRATIONS = [
  'migrations/0004_auth.sql',
  'migrations/0002_ops.sql',
  'migrations/0009_password_resets.sql',
  'migrations/0046_rbac_workforce.sql',
  'migrations/0047_rbac_seed.sql',
  'migrations/0052_rbac_finegrained.sql', // fine-grained perms + user_roles.expires_ms
  'migrations/0050_suministros_areas.sql',
];

async function userWithRole(roleId: string) {
  const db: D1Mock = makeDb(MIGRATIONS);
  const env = makeEnv(db);
  const now = Date.now();
  const pw = await hashPassword('x');
  db.raw.prepare(`INSERT INTO users (id,email,name,role,pw_hash,pw_salt,status,created_ms) VALUES (?,?,?,?,?,?,?,?)`)
    .run('usr_area', 'area@s.com', 'Area Op', 'operator', pw.hash, pw.salt, 'active', now);
  // Assign ONLY the area role → engine ignores the legacy operator fallback.
  db.raw.prepare(`INSERT INTO user_roles (user_id, role_id, granted_ms) VALUES (?,?,?)`).run('usr_area', roleId, now);
  return { env };
}

describe('SUMINISTROS RBAC — area roles grant only their area', () => {
  it('warehouse role: has warehouse + read, but NOT dispatch/inventory/purchasing/manage/ops:console', async () => {
    const { env } = await userWithRole('role_sum_warehouse');
    expect(await hasPermission(env as any, 'usr_area', 'suministros:warehouse')).toBe(true);
    expect(await hasPermission(env as any, 'usr_area', 'suministros:read')).toBe(true);
    expect(await hasPermission(env as any, 'usr_area', 'suministros:dispatch')).toBe(false);
    expect(await hasPermission(env as any, 'usr_area', 'suministros:inventory')).toBe(false);
    expect(await hasPermission(env as any, 'usr_area', 'suministros:purchasing')).toBe(false);
    expect(await hasPermission(env as any, 'usr_area', 'suministros:manage')).toBe(false);
    expect(await hasPermission(env as any, 'usr_area', 'ops:console')).toBe(false);
  });

  it('purchasing role: has purchasing but not warehouse/dispatch', async () => {
    const { env } = await userWithRole('role_sum_purchasing');
    expect(await hasPermission(env as any, 'usr_area', 'suministros:purchasing')).toBe(true);
    expect(await hasPermission(env as any, 'usr_area', 'suministros:warehouse')).toBe(false);
    expect(await hasPermission(env as any, 'usr_area', 'suministros:dispatch')).toBe(false);
  });

  it('legacy operator (manager) keeps all four area perms', async () => {
    const db: D1Mock = makeDb(MIGRATIONS);
    const env = makeEnv(db);
    const now = Date.now();
    const pw = await hashPassword('x');
    db.raw.prepare(`INSERT INTO users (id,email,name,role,pw_hash,pw_salt,status,created_ms) VALUES (?,?,?,?,?,?,?,?)`)
      .run('usr_mgr', 'mgr@s.com', 'Manager', 'operator', pw.hash, pw.salt, 'active', now); // no user_roles → legacy operator
    for (const a of ['warehouse', 'dispatch', 'inventory', 'purchasing']) {
      expect(await hasPermission(env as any, 'usr_mgr', `suministros:${a}`), a).toBe(true);
    }
    expect(await hasPermission(env as any, 'usr_mgr', 'ops:console')).toBe(true);
  });
});

describe('SUMINISTROS RBAC — gate maps each write path to its area permission', () => {
  const cases: Array<[string, string, string]> = [
    ['/api/suministros/movimientos/recepcion', 'POST', 'suministros:warehouse'],
    ['/api/suministros/movimientos/traslado', 'POST', 'suministros:warehouse'],
    ['/api/suministros/requisiciones/abc/surtir', 'POST', 'suministros:warehouse'],
    ['/api/suministros/movimientos/despacho', 'POST', 'suministros:dispatch'],
    ['/api/suministros/picklists/abc/completar', 'POST', 'suministros:dispatch'],
    ['/api/suministros/envios/abc/despachar', 'POST', 'suministros:dispatch'],
    ['/api/suministros/movimientos/ajuste', 'POST', 'suministros:inventory'],
    ['/api/suministros/conteos/abc/conciliar', 'POST', 'suministros:inventory'],
    ['/api/suministros/ordenes', 'POST', 'suministros:purchasing'],
    ['/api/suministros/donaciones/abc/recibir', 'POST', 'suministros:purchasing'],
    ['/api/suministros/facturas/abc/pagar', 'POST', 'suministros:purchasing'],
    ['/api/suministros/productos', 'POST', 'suministros:manage'],
    ['/api/suministros/ubicaciones', 'POST', 'suministros:manage'],
  ];
  it('routes inventory writes to the right area perm', () => {
    for (const [p, m, perm] of cases) {
      const d = evaluateGate(p, m);
      expect(d.kind, `${m} ${p}`).toBe('perm');
      if (d.kind === 'perm') expect(d.perm, `${m} ${p}`).toBe(perm);
    }
  });
  it('inventory reads require suministros:read (division gated end-to-end)', () => {
    const a = evaluateGate('/api/suministros/inventario', 'GET');
    const b = evaluateGate('/api/suministros/reportes/valuacion', 'GET');
    expect(a.kind).toBe('perm'); if (a.kind === 'perm') expect(a.perm).toBe('suministros:read');
    expect(b.kind).toBe('perm'); if (b.kind === 'perm') expect(b.perm).toBe('suministros:read');
    const page = evaluateGate('/suministros', 'GET');
    expect(page.kind).toBe('page'); if (page.kind === 'page') expect(page.perm).toBe('suministros:read');
  });
});
