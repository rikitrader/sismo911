import { describe, it, expect } from 'vitest';
import { makeDb } from './helpers/d1';

// The IEHK medical-catalog seed (migration 0078) must load against the real
// schema, be idempotent, and only use unit codes the productos route accepts.
const UNIDADES = ['unidad', 'caja', 'kg', 'litro', 'ml', 'paquete', 'saco', 'blister',
  'ampolla', 'vial', 'tableta', 'dosis', 'bolsa', 'frasco', 'par', 'sobre', 'set'];

const MIGS = [
  'migrations/0038_suministros.sql',
  'migrations/0076_sum_producto_costo.sql',
  'migrations/0078_sum_medicos_seed.sql',
];

describe('medical IEHK seed (0078)', () => {
  it('loads 14 categories + 142 products with no duplicate codes', () => {
    const db = makeDb(MIGS);
    const cats = db.raw.prepare(`SELECT COUNT(*) n FROM sum_categorias WHERE id LIKE 'cat_med_%'`).get() as any;
    const prods = db.raw.prepare(`SELECT COUNT(*) n FROM sum_productos WHERE id LIKE 'prod_med_%'`).get() as any;
    expect(cats.n).toBe(14);
    expect(prods.n).toBe(142);
    const dup = db.raw.prepare(`SELECT codigo, COUNT(*) c FROM sum_productos GROUP BY codigo HAVING c > 1`).all();
    expect(dup).toEqual([]);
  });

  it('only uses accepted unit codes (so seeded products stay editable)', () => {
    const db = makeDb(MIGS);
    const units = db.raw.prepare(`SELECT DISTINCT unidad FROM sum_productos WHERE id LIKE 'prod_med_%'`).all() as any[];
    for (const u of units) expect(UNIDADES).toContain(u.unidad);
  });

  it('seeds reference data only — zero stock', () => {
    const db = makeDb(MIGS);
    const stock = db.raw.prepare(`SELECT COALESCE(SUM(cantidad),0) n FROM sum_existencias`).get() as any;
    expect(stock.n).toBe(0);
  });

  it('is idempotent (re-running adds nothing)', () => {
    const db = makeDb(MIGS);
    const before = (db.raw.prepare(`SELECT COUNT(*) n FROM sum_productos`).get() as any).n;
    db.raw.exec(require('node:fs').readFileSync('migrations/0078_sum_medicos_seed.sql', 'utf8'));
    const after = (db.raw.prepare(`SELECT COUNT(*) n FROM sum_productos`).get() as any).n;
    expect(after).toBe(before);
  });
});
