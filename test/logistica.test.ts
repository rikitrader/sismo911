import { describe, it, expect } from 'vitest';
import { haversineKm, rankMatches, planConfirmation, logistica, type CenterGeo, type InvRow, type NeedRow } from '../src/routes/logistica';
import { COMMODITIES, COMMODITY_IDS, COMMODITY_UNIT } from '../src/data/commodities';

describe('commodity taxonomy', () => {
  it('has stable ids, units and unique keys', () => {
    expect(COMMODITIES.length).toBeGreaterThanOrEqual(8);
    expect(COMMODITY_IDS.has('agua')).toBe(true);
    expect(COMMODITY_IDS.has('inventado')).toBe(false);
    expect(COMMODITY_UNIT['agua']).toBe('l');
    const ids = COMMODITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
  });
});

describe('haversineKm', () => {
  it('returns 0 for the same point and null when coords missing', () => {
    expect(haversineKm({ lat: 10, lon: -66 }, { lat: 10, lon: -66 })).toBe(0);
    expect(haversineKm(null, { lat: 10, lon: -66 })).toBeNull();
    expect(haversineKm({ lat: 10, lon: -66 }, undefined)).toBeNull();
    expect(haversineKm({ lat: NaN, lon: -66 }, { lat: 10, lon: -66 })).toBeNull();
  });
  it('approximates Caracas↔Maracaibo (~520 km) within tolerance', () => {
    const km = haversineKm({ lat: 10.48, lon: -66.90 }, { lat: 10.65, lon: -71.64 })!;
    expect(km).toBeGreaterThan(490);
    expect(km).toBeLessThan(540);
  });
});

describe('rankMatches (needs ↔ surplus, distance-ranked)', () => {
  const geo = new Map<string, CenterGeo>([
    ['dest',  { id: 'dest',  lat: 10.0, lon: -66.0 }],
    ['near',  { id: 'near',  lat: 10.1, lon: -66.0 }], // ~11 km
    ['far',   { id: 'far',   lat: 11.0, lon: -66.0 }], // ~111 km
    ['nogeo', { id: 'nogeo', lat: NaN,  lon: NaN }],
  ]);

  it('prefers the nearest surplus center for a need', () => {
    const needs: NeedRow[] = [{ id: 'n1', center_id: 'dest', commodity: 'agua', qty: 100, priority: 1 }];
    const inv: InvRow[] = [
      { center_id: 'far', commodity: 'agua', qty: 50 },
      { center_id: 'near', commodity: 'agua', qty: 50 },
    ];
    const m = rankMatches(needs, inv, geo);
    expect(m[0].origin_id).toBe('near'); // nearest first
    expect(m[1].origin_id).toBe('far');
    expect(m.every((x) => x.dest_id === 'dest')).toBe(true);
  });

  it('never suggests a center supplying itself', () => {
    const needs: NeedRow[] = [{ id: 'n1', center_id: 'dest', commodity: 'agua', qty: 100, priority: 2 }];
    const inv: InvRow[] = [{ center_id: 'dest', commodity: 'agua', qty: 999 }];
    expect(rankMatches(needs, inv, geo)).toHaveLength(0);
  });

  it('ignores zero/negative inventory and commodity mismatches', () => {
    const needs: NeedRow[] = [{ id: 'n1', center_id: 'dest', commodity: 'agua', qty: 10, priority: 2 }];
    const inv: InvRow[] = [
      { center_id: 'near', commodity: 'agua', qty: 0 },
      { center_id: 'far', commodity: 'medicinas', qty: 50 },
    ];
    expect(rankMatches(needs, inv, geo)).toHaveLength(0);
  });

  it('orders global suggestions by priority then distance', () => {
    const needs: NeedRow[] = [
      { id: 'low', center_id: 'dest', commodity: 'agua', qty: 10, priority: 3 },
      { id: 'crit', center_id: 'far', commodity: 'agua', qty: 10, priority: 1 },
    ];
    const inv: InvRow[] = [{ center_id: 'near', commodity: 'agua', qty: 100 }];
    const m = rankMatches(needs, inv, geo);
    expect(m[0].priority).toBe(1); // critical surfaces first
  });

  it('caps suggestions per need (perNeed)', () => {
    const needs: NeedRow[] = [{ id: 'n1', center_id: 'dest', commodity: 'agua', qty: 10, priority: 2 }];
    const inv: InvRow[] = Array.from({ length: 10 }, (_, i) => ({ center_id: 'near', commodity: 'agua', qty: i + 1 }));
    expect(rankMatches(needs, inv, geo, 3).length).toBeLessThanOrEqual(3);
  });
});

describe('planConfirmation (loop closure on confirmed delivery)', () => {
  it('moves stock origin→dest and draws down the destination need', () => {
    const plan = planConfirmation(
      [{ commodity: 'agua', qty: 2000, unit: 'l' }],
      'orig', 'dest',
      [{ center_id: 'orig', commodity: 'agua', qty: 5000, unit: 'l' }],
      [{ id: 'n1', commodity: 'agua', qty: 2000 }]
    );
    const orig = plan.inventory.find((r) => r.center_id === 'orig')!;
    const dest = plan.inventory.find((r) => r.center_id === 'dest')!;
    expect(orig.qty).toBe(3000);              // 5000 - 2000
    expect(dest.qty).toBe(2000);              // 0 + 2000
    expect(plan.needs).toEqual([{ id: 'n1', qty: 0, status: 'fulfilled' }]);
  });

  it('never drives origin stock negative', () => {
    const plan = planConfirmation(
      [{ commodity: 'agua', qty: 9999 }], 'orig', 'dest',
      [{ center_id: 'orig', commodity: 'agua', qty: 100 }], []
    );
    expect(plan.inventory.find((r) => r.center_id === 'orig')!.qty).toBe(0);
  });

  it('partially fulfills a larger need (stays open with reduced qty)', () => {
    const plan = planConfirmation(
      [{ commodity: 'medicinas', qty: 30 }], 'o', 'd',
      [{ center_id: 'o', commodity: 'medicinas', qty: 100 }],
      [{ id: 'n1', commodity: 'medicinas', qty: 50 }]
    );
    expect(plan.needs).toEqual([{ id: 'n1', qty: 20, status: 'open' }]);
  });

  it('consumes multiple needs oldest-first and ignores other commodities', () => {
    const plan = planConfirmation(
      [{ commodity: 'agua', qty: 30 }], 'o', 'd',
      [{ center_id: 'o', commodity: 'agua', qty: 100 }],
      [{ id: 'n1', commodity: 'agua', qty: 20 }, { id: 'n2', commodity: 'agua', qty: 20 }, { id: 'nx', commodity: 'higiene', qty: 5 }]
    );
    expect(plan.needs).toEqual([
      { id: 'n1', qty: 0, status: 'fulfilled' },
      { id: 'n2', qty: 10, status: 'open' },
    ]);
  });
});

// ── In-memory D1 stub for route-level tests ──
function makeStub() {
  const db: any = { shipments: [], items: [], inventory: [], needs: [], custody: [], audit: [] };
  const findInv = (c: string, k: string) => db.inventory.find((r: any) => r.center_id === c && r.commodity === k);
  const stmt = (sql: string, args: any[] = []) => ({
    bind: (...a: any[]) => stmt(sql, a),
    first: async () => {
      if (/FROM acopio_shipments WHERE id/.test(sql)) return db.shipments.find((s: any) => s.id === args[0]) ?? null;
      return null;
    },
    all: async () => {
      if (/FROM acopio_shipment_items WHERE shipment_id/.test(sql)) return { results: db.items.filter((i: any) => i.shipment_id === args[0]) };
      if (/FROM acopio_inventory WHERE center_id/.test(sql)) return { results: db.inventory.filter((i: any) => i.center_id === args[0]) };
      if (/FROM acopio_needs WHERE center_id = \? AND status = 'open'/.test(sql)) return { results: db.needs.filter((n: any) => n.center_id === args[0] && n.status === 'open') };
      return { results: [] };
    },
    run: async () => {
      if (/UPDATE acopio_shipments SET status/.test(sql)) { const s = db.shipments.find((x: any) => x.id === args[2]); if (s) s.status = args[0]; }
      else if (/INSERT INTO acopio_custody/.test(sql)) db.custody.push({ id: args[0], shipment_id: args[1], event: args[2] });
      else if (/INSERT INTO acopio_inventory/.test(sql)) { const e = findInv(args[0], args[1]); if (e) e.qty = args[2]; else db.inventory.push({ center_id: args[0], commodity: args[1], qty: args[2], unit: args[3] }); }
      else if (/UPDATE acopio_needs SET qty/.test(sql)) { const n = db.needs.find((x: any) => x.id === args[3]); if (n) { n.qty = args[0]; n.status = args[1]; } }
      else if (/INSERT INTO audit/.test(sql)) db.audit.push({});
      return { meta: { changes: 1 }, success: true };
    },
  });
  const DB: any = { prepare: (sql: string) => stmt(sql), batch: async (ss: any[]) => { for (const s of ss) await s.run(); return ss.map(() => ({ success: true })); } };
  return { db, DB };
}
const J = (body: any) => ({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('logistica routes (in-memory D1)', () => {
  it('confirming a shipment moves stock and closes the need end-to-end', async () => {
    const { db, DB } = makeStub();
    db.shipments.push({ id: 'shp1', status: 'en_transito', origin_id: 'A', dest_id: 'B' });
    db.items.push({ shipment_id: 'shp1', commodity: 'agua', qty: 100, unit: 'l' });
    db.inventory.push({ center_id: 'A', commodity: 'agua', qty: 500, unit: 'l' });
    db.needs.push({ id: 'n1', center_id: 'B', commodity: 'agua', qty: 100, status: 'open', priority: 1 });

    const res = await logistica.request('/shipments/shp1', J({ status: 'confirmado' }), { DB } as any);
    expect(res.status).toBe(200);
    expect((await res.json()).applied).toBe(true);
    expect(findInvAfter(db, 'A')).toBe(400);   // 500 - 100
    expect(findInvAfter(db, 'B')).toBe(100);   // 0 + 100
    expect(db.needs[0].status).toBe('fulfilled');
  });

  it('re-confirming is idempotent (does not move stock twice)', async () => {
    const { db, DB } = makeStub();
    db.shipments.push({ id: 'shp1', status: 'confirmado', origin_id: 'A', dest_id: 'B' });
    db.items.push({ shipment_id: 'shp1', commodity: 'agua', qty: 100, unit: 'l' });
    db.inventory.push({ center_id: 'A', commodity: 'agua', qty: 400, unit: 'l' });
    const res = await logistica.request('/shipments/shp1', J({ status: 'confirmado' }), { DB } as any);
    expect((await res.json()).applied).toBe(false);
    expect(findInvAfter(db, 'A')).toBe(400);   // unchanged
  });

  it('bulk inventory import upserts valid rows and skips invalid', async () => {
    const { db, DB } = makeStub();
    const res = await logistica.request('/inventory/bulk', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rows: [
        { center_id: 'A', commodity: 'agua', qty: 50 },
        { center_id: 'A', commodity: 'NOPE', qty: 10 },   // invalid commodity → skipped
        { center_id: 'B', commodity: 'medicinas', qty: 5 },
      ] }),
    }, { DB } as any);
    const j = await res.json();
    expect(j.imported).toBe(2);
    expect(j.skipped).toBe(1);
    expect(db.inventory.length).toBe(2);
  });
});
function findInvAfter(db: any, c: string) { return db.inventory.find((r: any) => r.center_id === c)?.qty; }
