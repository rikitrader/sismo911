import { describe, it, expect } from 'vitest';
import { app } from '../src/index';
import { evaluateGate } from '../src/rbac/route-policy';

// M1 default-deny safety net. Enumerates EVERY registered route from Hono's own
// route table and proves each /api route is classified (open/public/gated) — never
// fails closed. This makes it impossible to merge/deploy a new /api route (or a new
// feature prefix, the C3/flota bug class) without classifying it: an unclassified
// route → evaluateGate returns 'deny' → this test goes red.

// Concrete /api routes (skip mount wildcards like /api/* — their sub-routes are
// listed separately). Each evaluated with its own method.
const apiRoutes = [
  ...new Set(
    (app as any).routes
      .filter((r: any) => String(r.path).startsWith('/api') && !String(r.path).includes('*'))
      .map((r: any) => (r.method === 'ALL' ? 'GET' : r.method) + ' ' + r.path),
  ),
] as string[];

describe('M1 default-deny — full route coverage', () => {
  it('there are many /api routes to check (sanity)', () => {
    expect(apiRoutes.length).toBeGreaterThan(200);
  });

  it('EVERY registered /api route is classified — none fails closed', () => {
    const denied = apiRoutes.filter((k) => {
      const sp = k.indexOf(' ');
      const method = k.slice(0, sp), path = k.slice(sp + 1);
      return evaluateGate(path, method).kind === 'deny';
    });
    expect(
      denied,
      'These /api routes are UNCLASSIFIED (would 403). Add their prefix to PUBLIC_API_PREFIXES (if public/route-authed) or to the gated matrix in route-policy.ts:\n  ' +
        denied.join('\n  '),
    ).toEqual([]);
  });

  it('an unknown /api path / new feature prefix fails closed', () => {
    expect(evaluateGate('/api/__definitely_not_a_route__', 'GET').kind).toBe('deny');
    expect(evaluateGate('/api/brandnewfeature/list', 'GET').kind).toBe('deny');
    expect(evaluateGate('/api/brandnewfeature/create', 'POST').kind).toBe('deny');
  });

  it('non-/api paths are unaffected (stay open)', () => {
    expect(evaluateGate('/', 'GET').kind).toBe('open');
    expect(evaluateGate('/blog', 'GET').kind).toBe('open');
    expect(evaluateGate('/terremotos', 'GET').kind).toBe('open');
  });

  it('known public stays open; gated stays gated', () => {
    expect(evaluateGate('/api/sos', 'POST').kind).toBe('open');
    expect(evaluateGate('/api/events', 'GET').kind).toBe('open');
    expect(evaluateGate('/api/health', 'GET').kind).toBe('open');
    expect(evaluateGate('/api/admin/flota/units', 'GET').kind).toBe('perm');
    expect(evaluateGate('/api/flota/misiones', 'GET').kind).toBe('perm');
  });
});
