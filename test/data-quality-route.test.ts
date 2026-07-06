// GET /api/admin/data-quality — gate + shape.
import { describe, it, expect } from 'vitest';
import { app } from '../src/index';
import { evaluateGate } from '../src/rbac/route-policy';

describe('/api/admin/data-quality', () => {
  it('is registered and classified (never default-deny)', () => {
    const routes = (app as any).routes.filter((r: any) => String(r.path).startsWith('/api/admin/data-quality'));
    expect(routes.length).toBeGreaterThan(0);
    // /api/admin GETs pass the GLOBAL gate as 'open' by design and self-gate at
    // route level (requirePermission — same pattern as /api/admin/intake). The
    // unauthenticated-request test below proves the route-level gate holds.
    const g = evaluateGate('/api/admin/data-quality', 'GET') as { kind: string };
    expect(g.kind).not.toBe('deny');
  });

  it('unauthenticated request is rejected', async () => {
    const res = await app.request('/api/admin/data-quality', { method: 'GET' }, { DB: { prepare: () => ({ first: async () => null, all: async () => ({ results: [] }) }) } } as any);
    expect([401, 403]).toContain(res.status);
  });
});
