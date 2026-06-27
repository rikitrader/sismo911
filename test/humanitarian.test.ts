import { describe, expect, it } from 'vitest';
import { ops } from '../src/routes/ops';

function makeDB() {
  const stmt = (sql: string) => ({
    all: async () => {
      if (/FROM checkins/.test(sql)) return { results: [
        { status: 'safe', n: 7 },
        { status: 'need_help', n: 2 },
      ] };
      if (/FROM sos_alerts/.test(sql)) return { results: [
        { status: 'active', n: 3 },
        { status: 'acknowledged', n: 1 },
        { status: 'resolved', n: 5 },
      ] };
      if (/FROM resources/.test(sql)) return { results: [
        { kind: 'water', status: 'available', n: 4 },
        { kind: 'medical', status: 'low', n: 2 },
        { kind: 'fuel', status: 'depleted', n: 1 },
      ] };
      if (/FROM shelter_status/.test(sql)) return { results: [
        { status: 'activo', n: 6 },
        { status: 'lleno', n: 1 },
      ] };
      return { results: [] };
    },
  });
  return { prepare: (sql: string) => stmt(sql) } as any;
}

describe('humanitarian dashboard aggregate', () => {
  it('returns public non-PII humanitarian operating-picture counts', async () => {
    const res = await ops.request('/humanitarian/dashboard', {}, { DB: makeDB() } as any);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('max-age=30');
    const j = await res.json() as any;
    expect(j.checkins).toMatchObject({ total: 9, safe: 7, need_help: 2 });
    expect(j.sos).toMatchObject({ active: 3, acknowledged: 1, unresolved: 4 });
    expect(j.resources).toMatchObject({ available: 4, low: 2, depleted: 1, total: 7 });
    expect(j.shelters).toMatchObject({ active: 6, full: 1, closed: 0, total: 7 });
    expect(JSON.stringify(j)).not.toMatch(/phone|lat|lon|note|name/i);
  });
});
