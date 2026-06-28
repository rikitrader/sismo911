import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { makeDb, makeEnv, type D1Mock } from './helpers/d1';
import { logistica } from '../src/routes/logistica';

// /api/acopio/gaps — supply-gap (shortage) analysis feeding the command dashboard.
// Regression for the dashboard bug where /api/acopio/gaps 404'd (endpoint missing),
// silently blanking the "brechas" panel.
function setup() {
  const db: D1Mock = makeDb(['migrations/0021_acopio_logistica.sql']);
  const env = makeEnv(db);
  const app = new Hono();
  app.route('/api/acopio', logistica);
  return { db, env, app };
}

function seed(db: D1Mock) {
  const need = db.raw.prepare(`INSERT INTO acopio_needs (id,center_id,commodity,qty,priority,status,created_ms,updated_ms) VALUES (?,?,?,?,?,?,?,?)`);
  const inv = db.raw.prepare(`INSERT INTO acopio_inventory (center_id,commodity,qty,unit,updated_ms) VALUES (?,?,?,?,?)`);
  const now = Date.now();
  need.run('n1', 'c1', 'agua', 100, 1, 'open', now, now);       // critical (prio 1) — cov 10%
  need.run('n2', 'c1', 'alimentos', 50, 2, 'open', now, now);   // shortage — cov 80%
  need.run('n3', 'c1', 'agua', 50, 2, 'fulfilled', now, now);   // not open → ignored
  inv.run('c1', 'agua', 10, 'l', now);
  inv.run('c2', 'agua', 0, 'l', now);                      // sums to 10 across centers
  inv.run('c1', 'alimentos', 40, 'caja', now);
  inv.run('c1', 'medicinas', 30, 'caja', now);             // surplus — inventory, no open need
}

describe('GET /api/acopio/gaps', () => {
  it('aggregates open needs vs inventory per commodity + classifies shortage', async () => {
    const { db, env, app } = setup();
    seed(db);
    const r = await app.request('/api/acopio/gaps', {}, env);
    expect(r.status).toBe(200);
    const d: any = await r.json();
    const by = Object.fromEntries(d.gaps.map((g: any) => [g.commodity, g]));

    expect(by.agua.open_need_qty).toBe(100);
    expect(by.agua.inventory_qty).toBe(10);
    expect(by.agua.coverage_pct).toBe(10);
    expect(by.agua.status).toBe('critical_shortage');
    expect(by.agua.esf).toBe(6);            // from the taxonomy

    expect(by.alimentos.coverage_pct).toBe(80);
    expect(by.alimentos.status).toBe('shortage');

    expect(by.medicinas.open_need_qty).toBe(0);
    expect(by.medicinas.inventory_qty).toBe(30);
    expect(by.medicinas.status).toBe('surplus');

    expect(d.counts.critical_shortage).toBe(1);
    expect(d.counts.shortage).toBe(1);
    // most severe first
    expect(d.gaps[0].status).toBe('critical_shortage');
  });

  it('returns empty gaps + zero counts when nothing is tracked', async () => {
    const { env, app } = setup();
    const d: any = await (await app.request('/api/acopio/gaps', {}, env)).json();
    expect(d.gaps).toEqual([]);
    expect(d.counts).toEqual({ critical_shortage: 0, shortage: 0 });
  });
});
