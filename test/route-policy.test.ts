import { describe, it, expect } from 'vitest';
import { evaluateGate, LEGACY_OPS_PERM } from '../src/rbac/route-policy';
import { expandRolePerms } from '../scripts/rbac-catalog.mjs';

// Representative requests covering every protected surface in the old index.ts gate.
const GATED: Array<[string, string]> = [
  ['/api/flota/unidades', 'GET'],            // isFlotaApi (all methods)
  ['/api/flota/unidades', 'POST'],
  ['/api/admin/flota/live', 'GET'],          // isFlotaAdminApi
  ['/api/admin/dedupe-personas', 'POST'],    // isAdminWrite (/api/admin)
  ['/api/contacts', 'POST'],                 // isAdminWrite
  ['/api/suministros/productos', 'POST'],    // isAdminWrite (/api/suministros)
  ['/api/reports/queue', 'GET'],             // isReportModeration
  ['/api/reports/abc', 'PATCH'],             // isReportModeration
  ['/api/persons/queue', 'GET'],             // isPersonModeration
  ['/api/persons/abc', 'PATCH'],             // isPersonModeration
  ['/api/persons/abc/approve', 'POST'],      // endsWith approve
  ['/api/persons/abc/attachments', 'GET'],   // isCaseAdmin (all methods)
  ['/api/sos', 'GET'],                       // isSosTriage
  ['/api/sos/abc', 'PATCH'],                 // isSosTriage
  ['/api/damage', 'GET'],                    // isDamageReview
  ['/api/events/refresh', 'POST'],           // isManualRefresh
  ['/api/shelters/queue', 'GET'],            // isShelterModeration
  ['/api/sat/analyze', 'POST'],              // isSatWrite
  ['/api/acopio/submissions', 'GET'],        // isAcopioReview
  ['/api/aid-orgs/x', 'POST'],               // isAdminWrite
  ['/api/emergencia', 'POST'],               // isAdminWrite
  ['/api/danos-estructurales/x', 'POST'],    // isAdminWrite
];

// Surfaces that must stay PUBLIC (open) — the documented exceptions.
const OPEN: Array<[string, string]> = [
  ['/api/acopio/report', 'POST'],            // citizen acopio submission
  ['/api/emergencia/abc/share', 'POST'],     // public share bump
  ['/api/events', 'GET'],                    // public reads
  ['/api/reports', 'POST'],                  // citizen report submission
  ['/api/persons', 'POST'],                  // citizen missing-person report
  ['/api/sat/pytorch-results', 'POST'],      // explicit public callback
  ['/api/suministros/productos', 'GET'],     // suministros reads are public; only writes gated
  ['/api/health', 'GET'],
  ['/', 'GET'],
];

describe('route policy — gate matrix', () => {
  it('every protected surface requires a capability (perm/login/page)', () => {
    for (const [p, m] of GATED) {
      const d = evaluateGate(p, m);
      expect(d.kind, `${m} ${p} should be gated`).not.toBe('open');
    }
  });

  it('documented public surfaces stay open', () => {
    for (const [p, m] of OPEN) {
      expect(evaluateGate(p, m).kind, `${m} ${p} should be open`).toBe('open');
    }
  });

  it('docket submission requires only login (any role)', () => {
    expect(evaluateGate('/api/persons/abc/docket', 'POST').kind).toBe('login');
  });

  it('admin HTML pages resolve to a login-redirect page gate', () => {
    expect(evaluateGate('/admin', 'GET').kind).toBe('page');
    expect(evaluateGate('/admin/users', 'GET').kind).toBe('page');
  });
});

describe('route policy — access preservation (no regression)', () => {
  const operatorPerms = expandRolePerms('operator');
  const citizenPerms = expandRolePerms('citizen');
  const superAdminPerms = expandRolePerms('super_admin');

  it('legacy operator holds the gate capability; citizen does not', () => {
    expect(operatorPerms.has(LEGACY_OPS_PERM)).toBe(true);
    expect(superAdminPerms.has(LEGACY_OPS_PERM)).toBe(true);
    expect(citizenPerms.has(LEGACY_OPS_PERM)).toBe(false);
  });

  it('every "perm" gate maps to a capability operator+admin hold and citizen lacks', () => {
    for (const [p, m] of GATED) {
      const d = evaluateGate(p, m);
      if (d.kind !== 'perm') continue;
      expect(operatorPerms.has(d.perm), `operator must keep ${m} ${p}`).toBe(true);
      expect(superAdminPerms.has(d.perm), `admin must keep ${m} ${p}`).toBe(true);
      expect(citizenPerms.has(d.perm), `citizen must NOT get ${m} ${p}`).toBe(false);
    }
  });
});
