// /api/admin/dedupe — registration + route-level gate.
import { describe, it, expect } from 'vitest';
import { app } from '../src/index';
import { evaluateGate } from '../src/rbac/route-policy';

const fakeDb = { prepare: () => ({ bind: function(){return this;}, first: async () => null, all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 0 } }) }), batch: async () => [] };

describe('/api/admin/dedupe', () => {
  it('routes are registered and classified (never default-deny)', () => {
    const routes = (app as any).routes.filter((r: any) => String(r.path).startsWith('/api/admin/dedupe'));
    expect(routes.length).toBeGreaterThanOrEqual(6);
    for (const r of routes) {
      expect(evaluateGate(String(r.path), r.method === 'ALL' ? 'GET' : r.method).kind).not.toBe('deny');
    }
  });

  it('unauthenticated requests are rejected on every endpoint', async () => {
    for (const [method, path] of [
      ['GET', '/api/admin/dedupe/candidates'],
      ['GET', '/api/admin/dedupe/conflicts'],
      ['GET', '/api/admin/dedupe/stats'],
      ['POST', '/api/admin/dedupe/candidates/x/merge'],
      ['POST', '/api/admin/dedupe/candidates/x/reject'],
      ['POST', '/api/admin/dedupe/conflicts/x/resolve'],
    ] as const) {
      const res = await app.request(path, { method }, { DB: fakeDb } as any);
      expect([401, 403], `${method} ${path}`).toContain(res.status);
    }
  });
});
