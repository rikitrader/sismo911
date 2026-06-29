import { describe, it, expect, beforeEach } from 'vitest';
import { makeDb, makeEnv, mount, call, type D1Mock, type TestEnv } from './helpers/d1';
import { sumProveedores } from '../src/routes/suministros-proveedores';
import { sumFacturas } from '../src/routes/suministros-facturas';
import { sumPagos } from '../src/routes/suministros-pagos';
import { sumTablero } from '../src/routes/suministros-tablero';

// Integration tests for the SUMINISTROS ↔ x402 payment bridge: payee links,
// invoice pay-link generation, the /pagar requirements flow, manual-paid sync,
// the payment ledger, and the map endpoint. Real route handlers → real SQLite.

const MIGS = [
  'migrations/0004_auth.sql',
  'migrations/0016_donations.sql',
  'migrations/0048_x402_payments.sql',
  'migrations/0050_x402_hardening.sql',
  'migrations/0057_payment_links.sql',
  'migrations/0070_cobros_donation_invoice.sql',
  'migrations/0038_suministros.sql',
  'migrations/0039_sum_proveedores.sql',
  'migrations/0042_sum_facturas.sql',
  'migrations/0074_suministros_payee_link.sql',
];

// env with the x402 platform gate LIVE (facilitator + flag). USDC asset resolves
// from the default Base network inside x402Asset.
const LIVE = { X402_FACILITATOR_URL: 'https://facilitator.test', X402_PAYMENTS_ENABLED: '1' };

let db: D1Mock;
let env: TestEnv;
const app = mount([
  ['/api/suministros/proveedores', sumProveedores],
  ['/api/suministros/facturas', sumFacturas],
  ['/api/suministros/pagos', sumPagos],
  ['/api/suministros/tablero', sumTablero],
]);

const PROV = '/api/suministros/proveedores';
const FAC = '/api/suministros/facturas';

/** Insert a receive-enabled user (wallet + x402 on). */
function makeUser(id: string, enabled = 1, wallet = '0xWALLET' + id) {
  db.raw.prepare(
    `INSERT INTO users (id, email, name, role, pw_hash, pw_salt, created_ms,
       wallet_address, x402_enabled, x402_pay_to)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, `${id}@test.io`, `User ${id}`, 'operator', 'h', 's', Date.now(), wallet, enabled, wallet);
}

/** Create a proveedor (optionally with payee) and an emitida factura. Returns {provId, facId, codigo}. */
async function seedInvoice(opts: { payee?: string | null; monto?: number } = {}) {
  const pr = await call(app, 'POST', `${PROV}`, env, { nombre: 'Farmacia Test', payee_user_id: opts.payee ?? undefined });
  const provId = pr.json.id;
  const fc = await call(app, 'POST', `${FAC}`, env, {
    proveedor_id: provId, monto_total: opts.monto ?? 250, moneda: 'USD',
  });
  const facId = fc.json.factura.id;
  // borrador → emitida so it is payable.
  await call(app, 'PATCH', `${FAC}/${facId}`, env, { estado: 'emitida' });
  const codigo = fc.json.factura.codigo as string;
  return { provId, facId, codigo };
}

beforeEach(() => {
  db = makeDb(MIGS);
  env = makeEnv(db);
  Object.assign(env, LIVE);
});

describe('proveedores: payee link', () => {
  it('accepts payee_user_id on create and returns payee fields on list + detail', async () => {
    makeUser('u_supplier');
    const created = await call(app, 'POST', `${PROV}`, env, { nombre: 'Distribuidora Sur', payee_user_id: 'u_supplier' });
    expect(created.status).toBe(201);
    expect(created.json.payee_user_id).toBe('u_supplier');

    const list = await call(app, 'GET', `${PROV}`, env);
    const row = list.json.results.find((r: any) => r.id === created.json.id);
    expect(row.payee_name).toBe('User u_supplier');
    expect(Number(row.payee_x402_enabled)).toBe(1);
    expect(row.payee_wallet).toBe('0xWALLETu_supplier');

    const detail = await call(app, 'GET', `${PROV}/${created.json.id}`, env);
    expect(detail.json.payee_name).toBe('User u_supplier');
    expect(detail.json.payee_wallet).toBe('0xWALLETu_supplier');
  });

  it('rejects an unknown payee_user_id with 404', async () => {
    const r = await call(app, 'POST', `${PROV}`, env, { nombre: 'X', payee_user_id: 'nope' });
    expect(r.status).toBe(404);
  });

  it('can set/clear payee via PATCH', async () => {
    makeUser('u_p');
    const c = await call(app, 'POST', `${PROV}`, env, { nombre: 'Y' });
    await call(app, 'PATCH', `${PROV}/${c.json.id}`, env, { payee_user_id: 'u_p' });
    let d = await call(app, 'GET', `${PROV}/${c.json.id}`, env);
    expect(d.json.payee_user_id).toBe('u_p');
    await call(app, 'PATCH', `${PROV}/${c.json.id}`, env, { payee_user_id: '' });
    d = await call(app, 'GET', `${PROV}/${c.json.id}`, env);
    expect(d.json.payee_user_id).toBeNull();
  });
});

describe('facturas: generar-enlace-pago', () => {
  it('mints an x402 invoice resource and stamps it on the factura', async () => {
    makeUser('u_pay');
    const { facId, codigo } = await seedInvoice({ payee: 'u_pay', monto: 250 });

    const r = await call(app, 'POST', `${FAC}/${facId}/generar-enlace-pago`, env);
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.slug).toBe(codigo.toLowerCase());
    expect(r.json.amount_usd).toBe(250);
    expect(r.json.payUrl).toBe(`/api/x402/pay/u_pay/${codigo.toLowerCase()}`);

    // x402_resources row exists, kind=invoice, price matches, invoice_status pendiente.
    const res = db.raw.prepare(`SELECT * FROM x402_resources WHERE id = ?`).get(r.json.resourceId) as any;
    expect(res.kind).toBe('invoice');
    expect(res.price_usd).toBe(250);
    expect(res.invoice_status).toBe('pendiente');
    expect(res.client_name).toBe('Farmacia Test');

    // factura stamped.
    const fac = db.raw.prepare(`SELECT x402_resource_id, x402_slug FROM sum_facturas WHERE id = ?`).get(facId) as any;
    expect(fac.x402_resource_id).toBe(r.json.resourceId);
    expect(fac.x402_slug).toBe(codigo.toLowerCase());
  });

  it('is idempotent: re-generating reuses the same resource (no duplicate)', async () => {
    makeUser('u_pay');
    const { facId } = await seedInvoice({ payee: 'u_pay' });
    const a = await call(app, 'POST', `${FAC}/${facId}/generar-enlace-pago`, env);
    const b = await call(app, 'POST', `${FAC}/${facId}/generar-enlace-pago`, env);
    expect(a.json.resourceId).toBe(b.json.resourceId);
    const n = db.raw.prepare(`SELECT COUNT(*) AS n FROM x402_resources`).get() as any;
    expect(n.n).toBe(1);
  });

  it('409 when the proveedor has no payee', async () => {
    const { facId } = await seedInvoice({ payee: null });
    const r = await call(app, 'POST', `${FAC}/${facId}/generar-enlace-pago`, env);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('no_payee');
  });

  it('409 when the payee is not x402-receiving', async () => {
    makeUser('u_off', 0); // x402_enabled = 0
    const { facId } = await seedInvoice({ payee: 'u_off' });
    const r = await call(app, 'POST', `${FAC}/${facId}/generar-enlace-pago`, env);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('recipient_not_receiving');
  });

  it('409 when x402 payments are not live in the environment', async () => {
    makeUser('u_pay');
    const { facId } = await seedInvoice({ payee: 'u_pay' });
    const offEnv = makeEnv(db); // no facilitator / flag
    const r = await call(app, 'POST', `${FAC}/${facId}/generar-enlace-pago`, offEnv);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('payments_unavailable');
  });
});

describe('facturas: /pagar payment requirements (Option A)', () => {
  it('returns payment_required + a full payment block, auto-creating the link', async () => {
    makeUser('u_pay');
    const { facId, codigo } = await seedInvoice({ payee: 'u_pay', monto: 99 });
    const r = await call(app, 'POST', `${FAC}/${facId}/pagar`, env);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('payment_required');
    expect(r.json.payment.slug).toBe(codigo.toLowerCase());
    expect(r.json.payment.amount_usd).toBe(99);
    expect(r.json.payment.payee_wallet).toBe('0xWALLETu_pay');
    expect(r.json.payment.x402_network).toMatch(/^eip155:/);
    expect(r.json.payment.x402_asset).toMatch(/^0x/);
    expect(r.json.receipt).toBeNull();
  });

  it('reports settled + a receipt once an on-chain settlement exists', async () => {
    makeUser('u_pay');
    const { facId } = await seedInvoice({ payee: 'u_pay', monto: 99 });
    const gen = await call(app, 'POST', `${FAC}/${facId}/generar-enlace-pago`, env);
    // Simulate a settled x402 payment against the invoice resource.
    db.raw.prepare(
      `INSERT INTO x402_payments (id, payee_user_id, resource_id, resource_url, network, asset, amount,
         amount_usd, pay_to, payer, status, tx_hash, settled_ms, created_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run('x4p_1', 'u_pay', gen.json.resourceId, 'https://x/pay', 'eip155:8453',
      '0xASSET', '99000000', 99, '0xWALLETu_pay', '0xPAYER', 'settled', '0xTX', Date.now(), Date.now());

    const r = await call(app, 'POST', `${FAC}/${facId}/pagar`, env);
    expect(r.json.status).toBe('settled');
    expect(r.json.receipt.tx_hash).toBe('0xTX');
    expect(r.json.receipt.payer).toBe('0xPAYER');
  });

  it('reports already_paid when an operator marked it pagada manually', async () => {
    makeUser('u_pay');
    const { facId } = await seedInvoice({ payee: 'u_pay' });
    await call(app, 'POST', `${FAC}/${facId}/generar-enlace-pago`, env);
    await call(app, 'PATCH', `${FAC}/${facId}`, env, { estado: 'pagada' });
    const r = await call(app, 'POST', `${FAC}/${facId}/pagar`, env);
    expect(r.json.status).toBe('already_paid');
  });
});

describe('facturas: manual paid sync + detail', () => {
  it('marking estado=pagada syncs the linked x402 resource to pagada', async () => {
    makeUser('u_pay');
    const { facId } = await seedInvoice({ payee: 'u_pay' });
    const gen = await call(app, 'POST', `${FAC}/${facId}/generar-enlace-pago`, env);
    await call(app, 'PATCH', `${FAC}/${facId}`, env, { estado: 'pagada' });
    const res = db.raw.prepare(`SELECT invoice_status, paid_ms FROM x402_resources WHERE id = ?`).get(gen.json.resourceId) as any;
    expect(res.invoice_status).toBe('pagada');
    expect(res.paid_ms).toBeGreaterThan(0);
    const fac = db.raw.prepare(`SELECT estado, pagada_ms FROM sum_facturas WHERE id = ?`).get(facId) as any;
    expect(fac.estado).toBe('pagada');
    expect(fac.pagada_ms).toBeGreaterThan(0);
  });

  it('GET /:id includes a pago block with payee + payUrl', async () => {
    makeUser('u_pay');
    const { facId, codigo } = await seedInvoice({ payee: 'u_pay' });
    await call(app, 'POST', `${FAC}/${facId}/generar-enlace-pago`, env);
    const d = await call(app, 'GET', `${FAC}/${facId}`, env);
    expect(d.json.pago.payUrl).toBe(`/api/x402/pay/u_pay/${codigo.toLowerCase()}`);
    expect(d.json.pago.payee.user_id).toBe('u_pay');
    expect(d.json.pago.payee.wallet).toBe('0xWALLETu_pay');
    expect(d.json.pago.x402_live).toBe(true);
  });
});

describe('GET /api/suministros/pagos ledger', () => {
  it('returns a summary, the invoice ledger, and settlements; honours x402_live', async () => {
    makeUser('u_pay');
    const { facId } = await seedInvoice({ payee: 'u_pay', monto: 400 });
    const gen = await call(app, 'POST', `${FAC}/${facId}/generar-enlace-pago`, env);
    db.raw.prepare(
      `INSERT INTO x402_payments (id, payee_user_id, resource_id, resource_url, network, asset, amount,
         amount_usd, pay_to, payer, status, tx_hash, settled_ms, created_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run('x4p_a', 'u_pay', gen.json.resourceId, 'https://x/pay', 'eip155:8453',
      '0xASSET', '400000000', 400, '0xWALLETu_pay', '0xPAYER', 'settled', '0xTX9', Date.now(), Date.now());

    const r = await call(app, 'GET', `/api/suministros/pagos`, env);
    expect(r.status).toBe(200);
    expect(r.json.x402_live).toBe(true);
    expect(r.json.summary.facturas_total).toBeGreaterThanOrEqual(1);
    expect(r.json.summary.pendientes).toBeGreaterThanOrEqual(1);
    expect(r.json.summary.monto_pendiente_usd).toBeGreaterThanOrEqual(400);
    expect(r.json.summary.settlements.length).toBe(1);
    expect(r.json.summary.settlements[0].tx_hash).toBe('0xTX9');
    const led = r.json.facturas.find((f: any) => f.id === facId);
    expect(led.settled_usd).toBe(400);
    expect(led.last_tx_hash).toBe('0xTX9');
    expect(led.payee_name).toBe('User u_pay');
  });

  it('still returns the ledger with x402_live=false when payments are off', async () => {
    await seedInvoice({ payee: null });
    const offEnv = makeEnv(db);
    const r = await call(app, 'GET', `/api/suministros/pagos`, offEnv);
    expect(r.status).toBe(200);
    expect(r.json.x402_live).toBe(false);
    expect(r.json.summary.facturas_total).toBeGreaterThanOrEqual(1);
  });
});

describe('GET /api/suministros/tablero/mapa', () => {
  it('returns active located sites with lat/lng + total_unidades', async () => {
    db.raw.prepare(
      `INSERT INTO sum_ubicaciones (id, nombre, tipo, lat, lon, activa, created_ms, updated_ms)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run('ubi_map1', 'Depósito Mapa', 'deposito', 10.5, -66.9, 1, Date.now(), Date.now());
    db.raw.prepare(
      `INSERT INTO sum_existencias (ubicacion_id, item_id, cantidad, updated_ms) VALUES (?,?,?,?)`
    ).run('ubi_map1', 'item_x', 42, Date.now());

    const r = await call(app, 'GET', `/api/suministros/tablero/mapa`, env);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json)).toBe(true);
    const m = r.json.find((x: any) => x.id === 'ubi_map1');
    expect(m).toMatchObject({ nombre: 'Depósito Mapa', tipo: 'deposito', lat: 10.5, lng: -66.9, total_unidades: 42 });
  });

  it('omits sites without coordinates', async () => {
    db.raw.prepare(
      `INSERT INTO sum_ubicaciones (id, nombre, tipo, lat, lon, activa, created_ms, updated_ms)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run('ubi_nocoord', 'Sin Coord', 'deposito', null, null, 1, Date.now(), Date.now());
    const r = await call(app, 'GET', `/api/suministros/tablero/mapa`, env);
    expect(r.json.find((x: any) => x.id === 'ubi_nocoord')).toBeUndefined();
  });
});
