import { describe, it, expect, beforeEach } from 'vitest';
import { makeDb, makeEnv, mount, call, type TestEnv, type D1Mock } from './helpers/d1';
import { sumMovimientos } from '../src/routes/suministros-movimientos';
import { sumRequisiciones } from '../src/routes/suministros-requisiciones';
import { sumDonaciones } from '../src/routes/suministros-donaciones';
import { sumOrdenes } from '../src/routes/suministros-ordenes';
import { sumEnvios } from '../src/routes/suministros-envios';
import { sumPicklists } from '../src/routes/suministros-picklists';
import { sumConteos } from '../src/routes/suministros-conteos';
import { sumProductos } from '../src/routes/suministros-productos';
import { sumInventario } from '../src/routes/suministros-inventario';
import { sumReportes } from '../src/routes/suministros-reportes';
import { sumKits } from '../src/routes/suministros-kits';

// Integration tests proving the SUMINISTROS stock-mutation flows end-to-end:
// real route handlers → real in-memory SQLite (D1 adapter) → assert the actual
// sum_existencias deltas + conservation invariants. The global auth gate is a
// separate prefix check bypassed here (covered live by the 401 smoke tests).
//
// Starting stock comes from migrations/seed_suministros.sql (e.g. item_agua1 @
// ubi_ccs = 800, item_manta @ ubi_ccs = 500, item_para_b @ ubi_ccs = 600).

const MIGS = [
  'migrations/0038_suministros.sql',
  'migrations/seed_suministros.sql',
  'migrations/0039_sum_proveedores.sql',
  'migrations/0040_sum_donaciones.sql',
  'migrations/0041_sum_ordenes.sql',
  'migrations/0042_sum_facturas.sql',
  'migrations/0043_sum_picklists.sql',
  'migrations/0044_sum_envios.sql',
  'migrations/0045_sum_conteos.sql',
  'migrations/0076_sum_producto_costo.sql',
  'migrations/0077_sum_kits.sql',
];

let db: D1Mock;
let env: TestEnv;
const app = mount([
  ['/api/suministros/movimientos', sumMovimientos],
  ['/api/suministros/requisiciones', sumRequisiciones],
  ['/api/suministros/donaciones', sumDonaciones],
  ['/api/suministros/ordenes', sumOrdenes],
  ['/api/suministros/envios', sumEnvios],
  ['/api/suministros/picklists', sumPicklists],
  ['/api/suministros/conteos', sumConteos],
  ['/api/suministros/productos', sumProductos],
  ['/api/suministros/inventario', sumInventario],
  ['/api/suministros/reportes', sumReportes],
  ['/api/suministros/kits', sumKits],
]);

const M = '/api/suministros/movimientos';

beforeEach(() => {
  db = makeDb(MIGS);
  env = makeEnv(db);
});

/** Current on-hand for (ubicacion, item); 0 if no row. */
function stock(ubic: string, item: string): number {
  const row = db.raw
    .prepare('SELECT cantidad FROM sum_existencias WHERE ubicacion_id = ? AND item_id = ?')
    .get(ubic, item) as { cantidad: number } | undefined;
  return row?.cantidad ?? 0;
}
/** Total on-hand of a product across all items at a location. */
function prodStock(ubic: string, prod: string): number {
  const row = db.raw
    .prepare(
      `SELECT COALESCE(SUM(e.cantidad),0) AS n FROM sum_existencias e
       JOIN sum_items i ON i.id = e.item_id WHERE e.ubicacion_id = ? AND i.producto_id = ?`,
    )
    .get(ubic, prod) as { n: number };
  return row.n;
}

describe('seed sanity', () => {
  it('loads the expected starting stock', () => {
    expect(stock('ubi_ccs', 'item_agua1')).toBe(800);
    expect(stock('ubi_ccs', 'item_manta')).toBe(500);
    expect(stock('ubi_ccs', 'item_para_b')).toBe(600);
  });
});

describe('movimientos — recepción (+stock, creates lots)', () => {
  it('adds to an existing default item', async () => {
    const r = await call(app, 'POST', `${M}/recepcion`, env, {
      ubicacion_id: 'ubi_ccs',
      lineas: [{ producto_id: 'prod_agua1', cantidad: 100 }],
    });
    expect(r.status).toBe(201);
    expect(stock('ubi_ccs', 'item_agua1')).toBe(900);
  });
  it('creates a new lot (item) for a new lote/caducidad', async () => {
    const before = prodStock('ubi_ccs', 'prod_arroz');
    const r = await call(app, 'POST', `${M}/recepcion`, env, {
      ubicacion_id: 'ubi_ccs',
      lineas: [{ producto_id: 'prod_arroz', lote: 'LOTE-NEW', caducidad_ms: 1900000000000, cantidad: 25 }],
    });
    expect(r.status).toBe(201);
    expect(prodStock('ubi_ccs', 'prod_arroz')).toBe(before + 25);
    const item = db.raw.prepare("SELECT id FROM sum_items WHERE producto_id='prod_arroz' AND lote='LOTE-NEW'").get() as any;
    expect(item).toBeTruthy();
    expect(stock('ubi_ccs', item.id)).toBe(25);
  });
});

describe('movimientos — despacho (−stock, guards)', () => {
  it('removes stock', async () => {
    const r = await call(app, 'POST', `${M}/despacho`, env, {
      ubicacion_id: 'ubi_ccs',
      lineas: [{ item_id: 'item_agua1', cantidad: 50 }],
    });
    expect(r.status).toBe(201);
    expect(stock('ubi_ccs', 'item_agua1')).toBe(750);
  });
  it('rejects despacho beyond on-hand (409) and leaves stock unchanged', async () => {
    const r = await call(app, 'POST', `${M}/despacho`, env, {
      ubicacion_id: 'ubi_ccs',
      lineas: [{ item_id: 'item_agua1', cantidad: 100000 }],
    });
    expect(r.status).toBe(409);
    expect(stock('ubi_ccs', 'item_agua1')).toBe(800);
  });
});

describe('movimientos — traslado (conserved across locations)', () => {
  it('moves stock origen→destino, total conserved', async () => {
    const totalBefore = stock('ubi_ccs', 'item_agua1') + stock('ubi_val', 'item_agua1');
    const r = await call(app, 'POST', `${M}/traslado`, env, {
      ubicacion_id: 'ubi_ccs',
      ubicacion_dest_id: 'ubi_val',
      lineas: [{ item_id: 'item_agua1', cantidad: 200 }],
    });
    expect(r.status).toBe(201);
    expect(stock('ubi_ccs', 'item_agua1')).toBe(600);
    expect(stock('ubi_val', 'item_agua1')).toBe(500);
    expect(stock('ubi_ccs', 'item_agua1') + stock('ubi_val', 'item_agua1')).toBe(totalBefore);
  });
});

describe('movimientos — ajuste (signed) + conteo (absolute)', () => {
  it('ajuste applies a positive delta', async () => {
    const r = await call(app, 'POST', `${M}/ajuste`, env, {
      ubicacion_id: 'ubi_ccs', motivo: 'test',
      lineas: [{ item_id: 'item_casco', delta: 10 }],
    });
    expect(r.status).toBe(201);
    expect(stock('ubi_ccs', 'item_casco')).toBe(25);
  });
  it('ajuste rejects a negative delta that would go below zero', async () => {
    const r = await call(app, 'POST', `${M}/ajuste`, env, {
      ubicacion_id: 'ubi_ccs', motivo: 'test',
      lineas: [{ item_id: 'item_casco', delta: -100 }],
    });
    expect(r.status).toBe(409);
    expect(stock('ubi_ccs', 'item_casco')).toBe(15);
  });
  it('conteo sets stock to the counted absolute value', async () => {
    const r = await call(app, 'POST', `${M}/conteo`, env, {
      ubicacion_id: 'ubi_ccs', motivo: 'count',
      lineas: [{ item_id: 'item_agua1', cantidad: 750 }],
    });
    expect(r.status).toBe(201);
    expect(stock('ubi_ccs', 'item_agua1')).toBe(750);
  });
});

describe('requisiciones — FEFO surtir moves stock + records cantidad_surt', () => {
  it('fulfills from origen to destino', async () => {
    const create = await call(app, 'POST', '/api/suministros/requisiciones', env, {
      ubicacion_id: 'ubi_lgu',
      lineas: [{ producto_id: 'prod_para', cantidad_sol: 100 }],
    });
    expect(create.status).toBe(201);
    const id = create.json.requisicion.id;
    await call(app, 'PATCH', `/api/suministros/requisiciones/${id}`, env, { estado: 'aprobada', origen_id: 'ubi_ccs' });
    const ccsBefore = prodStock('ubi_ccs', 'prod_para');
    const lguBefore = prodStock('ubi_lgu', 'prod_para');
    const surtir = await call(app, 'POST', `/api/suministros/requisiciones/${id}/surtir`, env, { origen_id: 'ubi_ccs' });
    expect(surtir.status).toBe(200);
    expect(prodStock('ubi_ccs', 'prod_para')).toBe(ccsBefore - 100);
    expect(prodStock('ubi_lgu', 'prod_para')).toBe(lguBefore + 100);
    const line = db.raw.prepare(`SELECT cantidad_surt FROM sum_requisicion_lineas WHERE requisicion_id = ?`).get(id) as any;
    expect(line.cantidad_surt).toBe(100);
    const req = db.raw.prepare(`SELECT estado FROM sum_requisiciones WHERE id = ?`).get(id) as any;
    expect(req.estado).toBe('surtida');
  });
});

describe('donaciones — recibir posts lines into stock', () => {
  it('receives the seeded donation into ubi_ccs', async () => {
    const mantaBefore = stock('ubi_ccs', 'item_manta');   // 500
    const aguaBefore = stock('ubi_ccs', 'item_agua1');    // 800
    const r = await call(app, 'POST', '/api/suministros/donaciones/don_cruzroja/recibir', env, {});
    expect(r.status).toBe(201);
    expect(stock('ubi_ccs', 'item_manta')).toBe(mantaBefore + 200);
    expect(stock('ubi_ccs', 'item_agua1')).toBe(aguaBefore + 500);
    const don = db.raw.prepare(`SELECT estado FROM sum_donaciones WHERE id='don_cruzroja'`).get() as any;
    expect(don.estado).toBe('recibida');
  });
  it('refuses to receive twice', async () => {
    await call(app, 'POST', '/api/suministros/donaciones/don_cruzroja/recibir', env, {});
    const again = await call(app, 'POST', '/api/suministros/donaciones/don_cruzroja/recibir', env, {});
    expect(again.status).toBeGreaterThanOrEqual(400);
  });
});

describe('ordenes — recibir vs OC posts received qty + tracks cantidad_rec', () => {
  it('partially receives a PO into stock', async () => {
    const linea = db.raw.prepare(`SELECT id FROM sum_orden_lineas WHERE orden_id='oc_para01'`).get() as any;
    const before = prodStock('ubi_ccs', 'prod_para');
    const r = await call(app, 'POST', '/api/suministros/ordenes/oc_para01/recibir', env, {
      lineas: [{ linea_id: linea.id, cantidad: 1000 }],
    });
    expect(r.status).toBe(201);
    expect(prodStock('ubi_ccs', 'prod_para')).toBe(before + 1000);
    const ol = db.raw.prepare(`SELECT cantidad_rec FROM sum_orden_lineas WHERE id = ?`).get(linea.id) as any;
    expect(ol.cantidad_rec).toBe(1000);
    const oc = db.raw.prepare(`SELECT estado FROM sum_ordenes WHERE id='oc_para01'`).get() as any;
    expect(oc.estado).toBe('recibida_parcial');
  });
});

describe('envíos — despachar (out) then recibir (in), conserved over time', () => {
  it('moves stock origen→destino across the two steps', async () => {
    const ccsAguaBefore = stock('ubi_ccs', 'item_agua1');  // 800
    const lguAguaBefore = stock('ubi_lgu', 'item_agua1');  // 50
    const totalBefore = ccsAguaBefore + lguAguaBefore;

    const desp = await call(app, 'POST', '/api/suministros/envios/env_demo01/despachar', env, {});
    expect(desp.status).toBe(200); // state transition (not a create)
    expect(stock('ubi_ccs', 'item_agua1')).toBe(ccsAguaBefore - 200); // left origen → in transit
    expect(stock('ubi_lgu', 'item_agua1')).toBe(lguAguaBefore);       // not yet arrived
    expect(db.raw.prepare(`SELECT estado FROM sum_envios WHERE id='env_demo01'`).get()).toMatchObject({ estado: 'despachado' });

    const rec = await call(app, 'POST', '/api/suministros/envios/env_demo01/recibir', env, {});
    expect(rec.status).toBe(200);
    expect(stock('ubi_lgu', 'item_agua1')).toBe(lguAguaBefore + 200); // arrived destino
    expect(stock('ubi_ccs', 'item_agua1') + stock('ubi_lgu', 'item_agua1')).toBe(totalBefore);
    expect(db.raw.prepare(`SELECT estado FROM sum_envios WHERE id='env_demo01'`).get()).toMatchObject({ estado: 'recibido' });
  });
});

describe('picklists — pick then completar emits a despacho', () => {
  it('issues the picked quantities out of the location', async () => {
    const detail = await call(app, 'GET', '/api/suministros/picklists/pck_demo01', env);
    const lineas: any[] = detail.json.lineas;
    const aguaLine = lineas.find((l) => l.item_id === 'item_agua1');
    const mantaLine = lineas.find((l) => l.item_id === 'item_manta');
    const aguaBefore = stock('ubi_ccs', 'item_agua1');
    const mantaBefore = stock('ubi_ccs', 'item_manta');

    const pick = await call(app, 'POST', '/api/suministros/picklists/pck_demo01/pick', env, {
      lineas: [{ linea_id: aguaLine.id, cantidad_pick: 100 }, { linea_id: mantaLine.id, cantidad_pick: 50 }],
    });
    expect(pick.status).toBe(200);
    const done = await call(app, 'POST', '/api/suministros/picklists/pck_demo01/completar', env, {});
    expect(done.status).toBe(201);
    expect(stock('ubi_ccs', 'item_agua1')).toBe(aguaBefore - 100);
    expect(stock('ubi_ccs', 'item_manta')).toBe(mantaBefore - 50);
    expect(db.raw.prepare(`SELECT estado FROM sum_picklists WHERE id='pck_demo01'`).get()).toMatchObject({ estado: 'completada' });
  });
});

describe('conteos — conciliar reconciles variance via ajuste', () => {
  it('sets stock to the counted value (+/- variance)', async () => {
    const detail = await call(app, 'GET', '/api/suministros/conteos/cnt_demo01', env);
    const lineas: any[] = detail.json.lineas;
    const aguaLine = lineas.find((l) => l.item_id === 'item_agua1');   // sistema 800
    const paraLine = lineas.find((l) => l.item_id === 'item_para_b');  // sistema 600

    await call(app, 'POST', '/api/suministros/conteos/cnt_demo01/contar', env, {
      lineas: [{ linea_id: aguaLine.id, cantidad_contada: 790 }, { linea_id: paraLine.id, cantidad_contada: 610 }],
    });
    const rec = await call(app, 'POST', '/api/suministros/conteos/cnt_demo01/conciliar', env, {});
    expect(rec.status).toBe(200);
    expect(stock('ubi_ccs', 'item_agua1')).toBe(790); // -10 variance applied
    expect(stock('ubi_ccs', 'item_para_b')).toBe(610); // +10 variance applied
    expect(db.raw.prepare(`SELECT estado FROM sum_conteos WHERE id='cnt_demo01'`).get()).toMatchObject({ estado: 'conciliado' });
  });
});

describe('productos — cost + valuation surfacing', () => {
  it('list returns costo_efectivo + valor_inventario', async () => {
    const r = await call(app, 'GET', '/api/suministros/productos', env);
    expect(r.status).toBe(200);
    const agua = r.json.results.find((p: any) => p.id === 'prod_agua1');
    expect(agua).toBeTruthy();
    expect(typeof agua.costo_efectivo).toBe('number');
    expect(agua.valor_inventario).toBeCloseTo(Number(agua.on_hand) * Number(agua.costo_efectivo), 2);
  });
  it('manual costo_unit override wins over supplier price and drives value', async () => {
    const patch = await call(app, 'PATCH', '/api/suministros/productos/prod_agua1', env, { costo_unit: 7 });
    expect(patch.status).toBe(200);
    const r = await call(app, 'GET', '/api/suministros/productos/prod_agua1', env);
    expect(r.json.costo_efectivo).toBe(7);
    expect(r.json.valor_inventario).toBeCloseTo(Number(r.json.on_hand) * 7, 2);
    const val = await call(app, 'GET', '/api/suministros/reportes/valuacion', env);
    expect(val.json.total).toBeGreaterThan(0);
  });
});

describe('movimientos — ?producto_id filter (per-product ledger)', () => {
  it('returns only transactions that touch the given product', async () => {
    await call(app, 'POST', `${M}/recepcion`, env, {
      ubicacion_id: 'ubi_ccs', referencia: 'FILTER-AGUA',
      lineas: [{ producto_id: 'prod_agua1', cantidad: 10 }],
    });
    await call(app, 'POST', `${M}/recepcion`, env, {
      ubicacion_id: 'ubi_ccs', referencia: 'FILTER-ARROZ',
      lineas: [{ producto_id: 'prod_arroz', cantidad: 10 }],
    });
    const filtered = await call(app, 'GET', `${M}?producto_id=prod_agua1`, env);
    const refs = filtered.json.results.map((t: any) => t.referencia);
    expect(refs).toContain('FILTER-AGUA');
    expect(refs).not.toContain('FILTER-ARROZ');
    const all = await call(app, 'GET', `${M}`, env);
    const allRefs = all.json.results.map((t: any) => t.referencia);
    expect(allRefs).toContain('FILTER-AGUA');
    expect(allRefs).toContain('FILTER-ARROZ');
  });
});

describe('kits — BOM cost/buildable + assemble consumes components (FEFO, atomic)', () => {
  async function makeKit() {
    const r = await call(app, 'POST', '/api/suministros/kits', env, {
      nombre: 'Kit prueba', lineas: [
        { producto_id: 'prod_agua1', cantidad: 2 },
        { producto_id: 'prod_manta', cantidad: 1 },
      ],
    });
    expect(r.status).toBe(201);
    return r.json.id as string;
  }

  it('computes component count, cost and buildable', async () => {
    const id = await makeKit();
    const list = await call(app, 'GET', '/api/suministros/kits', env);
    const kit = list.json.results.find((k: any) => k.id === id);
    expect(kit).toBeTruthy();
    expect(kit.n_componentes).toBe(2);
    expect(typeof kit.costo_total).toBe('number');
    // buildable = min(floor(agua/2), floor(manta/1)); both seeded > 0 at ubi_ccs
    expect(kit.buildable).toBeGreaterThan(0);
  });

  it('ensamblar consumes the right quantities from the location and ledgers it', async () => {
    const id = await makeKit();
    const agua0 = stock('ubi_ccs', 'item_agua1');
    const manta0 = stock('ubi_ccs', 'item_manta');
    const r = await call(app, 'POST', `/api/suministros/kits/${id}/ensamblar`, env, {
      ubicacion_id: 'ubi_ccs', cantidad: 3,
    });
    expect(r.status).toBe(201);
    expect(stock('ubi_ccs', 'item_agua1')).toBe(agua0 - 6); // 2 × 3
    expect(stock('ubi_ccs', 'item_manta')).toBe(manta0 - 3); // 1 × 3
    // a despacho transaction referencing the kit code exists
    const tx = db.raw.prepare(
      `SELECT referencia FROM sum_transacciones WHERE tipo='despacho' ORDER BY created_ms DESC LIMIT 1`
    ).get() as any;
    expect(String(tx.referencia)).toContain('Ensamblaje');
  });

  it('refuses to assemble more than available (409) and leaves stock untouched', async () => {
    const id = await makeKit();
    const agua0 = stock('ubi_ccs', 'item_agua1');
    const r = await call(app, 'POST', `/api/suministros/kits/${id}/ensamblar`, env, {
      ubicacion_id: 'ubi_ccs', cantidad: 1_000_000,
    });
    expect(r.status).toBe(409);
    expect(stock('ubi_ccs', 'item_agua1')).toBe(agua0); // unchanged
  });
});
