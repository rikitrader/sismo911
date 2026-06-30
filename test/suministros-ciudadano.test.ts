import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { makeDb, makeEnv, RBAC_MIGRATIONS, type D1Mock } from './helpers/d1';
import { suministrosCiudadano } from '../src/routes/suministros-ciudadano';

// Citizen Suministros enrollment + requests — auth, scoping, validation, state
// machine, and the admin review surface. Real SQL via the better-sqlite3 harness.
// The full RBAC migration set lets the engine resolve a citizen's (empty) perms
// to a clean 403 on /admin/* — instead of throwing on missing rbac tables.
const MIGRATIONS = [...RBAC_MIGRATIONS, 'migrations/0075_suministros_citizen.sql'];

function setup() {
  const db: D1Mock = makeDb(MIGRATIONS);
  // getUserFromRequest also selects these columns (added by migrations NOT in the
  // canonical RBAC set: 0016 wallet, 0049 must_change_pw, 0055 mfa_required).
  for (const sql of [
    'ALTER TABLE users ADD COLUMN wallet_address TEXT',
    'ALTER TABLE users ADD COLUMN must_change_pw INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN mfa_required INTEGER NOT NULL DEFAULT 0',
  ]) db.raw.exec(sql);

  const env = makeEnv(db);
  const app = new Hono();
  app.route('/api/suministros-ciudadano', suministrosCiudadano);

  const now = Date.now();
  // Citizen + admin (super_admin) users, each with a live session.
  const ins = db.raw.prepare(`INSERT INTO users (id,email,name,role,status,pw_hash,pw_salt,created_ms) VALUES (?,?,?,?,?,?,?,?)`);
  ins.run('usr_c', 'c@s.com', 'Carlos Citizen', 'citizen', 'active', 'x', 'x', now);
  ins.run('usr_op', 'op@s.com', 'Olga Operadora', 'admin', 'active', 'x', 'x', now);
  db.raw.prepare(`INSERT INTO sessions (token,user_id,expires_ms,created_ms) VALUES (?,?,?,?)`)
    .run('tok_c', 'usr_c', now + 86_400_000, now);
  db.raw.prepare(`INSERT INTO sessions (token,user_id,expires_ms,created_ms) VALUES (?,?,?,?)`)
    .run('tok_op', 'usr_op', now + 86_400_000, now);
  return { db, env, app };
}

const cit = { headers: { Cookie: 'sismo_session=tok_c', 'content-type': 'application/json' } };
const adm = { headers: { Cookie: 'sismo_session=tok_op', 'content-type': 'application/json' } };

const req = (app: Hono, env: any, method: string, path: string, auth: any, body?: unknown) =>
  app.request(path, {
    method,
    headers: auth.headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, env);

describe('suministros-ciudadano — citizen enrollment + requests', () => {
  it('GET /estado without auth → 401', async () => {
    const { app, env } = setup();
    const r = await app.request('/api/suministros-ciudadano/estado', {}, env);
    expect(r.status).toBe(401);
  });

  it('GET /estado with no enrollment → enrollment:null, requests:[]', async () => {
    const { app, env } = setup();
    const r = await req(app, env, 'GET', '/api/suministros-ciudadano/estado', cit);
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.ok).toBe(true);
    expect(j.enrollment).toBeNull();
    expect(j.requests).toEqual([]);
  });

  it('POST /solicitud creates a pendiente enrollment', async () => {
    const { app, env } = setup();
    const r = await req(app, env, 'POST', '/api/suministros-ciudadano/solicitud', cit, {
      nombre: 'Carlos C', cedula: 'V-123', contacto: '0412', tipo: 'coordinador_refugio',
      personas: 8, ubicacion: 'Catia La Mar', necesidad: 'Agua y alimentos',
    });
    expect(r.status).toBe(201);
    const j = await r.json() as any;
    expect(j.enrollment.status).toBe('pendiente');
    expect(j.enrollment.tipo).toBe('coordinador_refugio');
    expect(j.enrollment.personas).toBe(8);

    const est = await (await req(app, env, 'GET', '/api/suministros-ciudadano/estado', cit)).json() as any;
    expect(est.enrollment.status).toBe('pendiente');
    expect(est.requests).toEqual([]); // requests hidden until approved
  });

  it('rejects an unknown tipo → defaults to beneficiario; clamps personas', async () => {
    const { app, env } = setup();
    const j = await (await req(app, env, 'POST', '/api/suministros-ciudadano/solicitud', cit, {
      nombre: 'X', tipo: 'hacker', personas: 999999999,
    })).json() as any;
    expect(j.enrollment.tipo).toBe('beneficiario');
    expect(j.enrollment.personas).toBe(100000);
  });

  it('POST /solicitud without nombre → 400', async () => {
    const { app, env } = setup();
    const r = await req(app, env, 'POST', '/api/suministros-ciudadano/solicitud', cit, { nombre: '  ' });
    expect(r.status).toBe(400);
  });

  it('duplicate /solicitud while pendiente → 409', async () => {
    const { app, env } = setup();
    await req(app, env, 'POST', '/api/suministros-ciudadano/solicitud', cit, { nombre: 'Carlos' });
    const r = await req(app, env, 'POST', '/api/suministros-ciudadano/solicitud', cit, { nombre: 'Carlos otra vez' });
    expect(r.status).toBe(409);
  });

  it('POST /pedido before approval → 403', async () => {
    const { app, env } = setup();
    await req(app, env, 'POST', '/api/suministros-ciudadano/solicitud', cit, { nombre: 'Carlos' });
    const r = await req(app, env, 'POST', '/api/suministros-ciudadano/pedido', cit, { tipo: 'agua', cantidad: 5 });
    expect(r.status).toBe(403);
  });

  it('after approval: /pedido creates a request and /estado returns it', async () => {
    const { app, env, db } = setup();
    await req(app, env, 'POST', '/api/suministros-ciudadano/solicitud', cit, { nombre: 'Carlos' });
    // approve directly (admin path is covered separately)
    db.raw.prepare(`UPDATE sum_citizen_enrollments SET status='aprobada' WHERE user_id=?`).run('usr_c');

    const pr = await req(app, env, 'POST', '/api/suministros-ciudadano/pedido', cit, {
      tipo: 'medicinas', cantidad: 3, urgencia: 'alta', descripcion: 'Insulina',
    });
    expect(pr.status).toBe(201);
    const pj = await pr.json() as any;
    expect(pj.request.tipo).toBe('medicinas');
    expect(pj.request.status).toBe('pendiente');

    const est = await (await req(app, env, 'GET', '/api/suministros-ciudadano/estado', cit)).json() as any;
    expect(est.enrollment.status).toBe('aprobada');
    expect(est.requests).toHaveLength(1);
    expect(est.requests[0].urgencia).toBe('alta');
  });

  it('POST /pedido with invalid tipo → 400', async () => {
    const { app, env, db } = setup();
    await req(app, env, 'POST', '/api/suministros-ciudadano/solicitud', cit, { nombre: 'Carlos' });
    db.raw.prepare(`UPDATE sum_citizen_enrollments SET status='aprobada' WHERE user_id=?`).run('usr_c');
    const r = await req(app, env, 'POST', '/api/suministros-ciudadano/pedido', cit, { tipo: 'oro' });
    expect(r.status).toBe(400);
  });

  it('re-applies after a rejection (rechazada → pendiente, same row)', async () => {
    const { app, env, db } = setup();
    await req(app, env, 'POST', '/api/suministros-ciudadano/solicitud', cit, { nombre: 'Carlos' });
    db.raw.prepare(`UPDATE sum_citizen_enrollments SET status='rechazada', review_note='falta cédula' WHERE user_id=?`).run('usr_c');
    const r = await req(app, env, 'POST', '/api/suministros-ciudadano/solicitud', cit, { nombre: 'Carlos', cedula: 'V-9' });
    expect(r.status).toBe(201);
    const j = await r.json() as any;
    expect(j.enrollment.status).toBe('pendiente');
    expect(j.enrollment.cedula).toBe('V-9');
    const cnt: any = db.raw.prepare(`SELECT COUNT(*) AS n FROM sum_citizen_enrollments WHERE user_id=?`).get('usr_c');
    expect(cnt.n).toBe(1); // re-applied in place, not a second row
  });
});

describe('suministros-ciudadano — admin review (ops:console / super_admin)', () => {
  it('admin list returns the enrollment; citizen is forbidden', async () => {
    const { app, env } = setup();
    await req(app, env, 'POST', '/api/suministros-ciudadano/solicitud', cit, { nombre: 'Carlos' });

    const denied = await req(app, env, 'GET', '/api/suministros-ciudadano/admin/solicitudes', cit);
    expect(denied.status).toBe(403);

    const r = await req(app, env, 'GET', '/api/suministros-ciudadano/admin/solicitudes?status=pendiente', adm);
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.solicitudes).toHaveLength(1);
    expect(j.solicitudes[0].user_id).toBe('usr_c');
  });

  it('admin aprobar flips the enrollment and unlocks /pedido', async () => {
    const { app, env } = setup();
    const enr = await (await req(app, env, 'POST', '/api/suministros-ciudadano/solicitud', cit, { nombre: 'Carlos' })).json() as any;
    const id = enr.enrollment.id;

    const r = await req(app, env, 'POST', `/api/suministros-ciudadano/admin/solicitudes/${id}/aprobar`, adm, { note: 'ok' });
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.solicitud.status).toBe('aprobada');
    expect(j.solicitud.reviewer).toBe('op@s.com');

    const pr = await req(app, env, 'POST', '/api/suministros-ciudadano/pedido', cit, { tipo: 'agua' });
    expect(pr.status).toBe(201);
  });

  it('admin rechazar records the note', async () => {
    const { app, env } = setup();
    const enr = await (await req(app, env, 'POST', '/api/suministros-ciudadano/solicitud', cit, { nombre: 'Carlos' })).json() as any;
    const r = await req(app, env, 'POST', `/api/suministros-ciudadano/admin/solicitudes/${enr.enrollment.id}/rechazar`, adm, { note: 'datos incompletos' });
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.solicitud.status).toBe('rechazada');
    expect(j.solicitud.review_note).toBe('datos incompletos');
  });

  it('admin aprobar on a missing id → 404', async () => {
    const { app, env } = setup();
    const r = await req(app, env, 'POST', '/api/suministros-ciudadano/admin/solicitudes/enr_nope/aprobar', adm, {});
    expect(r.status).toBe(404);
  });
});

describe('suministros-ciudadano — pedido lifecycle (operator tracking)', () => {
  // helper: an approved citizen with one pendiente pedido; returns its id
  async function seedPedido(app: Hono, env: any, db: D1Mock): Promise<string> {
    await req(app, env, 'POST', '/api/suministros-ciudadano/solicitud', cit, { nombre: 'Carlos' });
    db.raw.prepare(`UPDATE sum_citizen_enrollments SET status='aprobada' WHERE user_id=?`).run('usr_c');
    const pr = await (await req(app, env, 'POST', '/api/suministros-ciudadano/pedido', cit, { tipo: 'agua', cantidad: 5 })).json() as any;
    return pr.request.id;
  }

  it('admin /pedidos lists the request with the requester name; citizen is forbidden', async () => {
    const { app, env, db } = setup();
    await seedPedido(app, env, db);
    const denied = await req(app, env, 'GET', '/api/suministros-ciudadano/admin/pedidos', cit);
    expect(denied.status).toBe(403);
    const r = await req(app, env, 'GET', '/api/suministros-ciudadano/admin/pedidos?status=pendiente', adm);
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.pedidos).toHaveLength(1);
    expect(j.pedidos[0].tipo).toBe('agua');
    expect(j.pedidos[0].nombre).toBe('Carlos'); // joined from the enrollment
  });

  it('operator advances status; the citizen sees it in /estado', async () => {
    const { app, env, db } = setup();
    const id = await seedPedido(app, env, db);
    for (const status of ['aprobada', 'en_camino', 'entregada']) {
      const r = await req(app, env, 'POST', `/api/suministros-ciudadano/admin/pedidos/${id}/estado`, adm, { status });
      expect(r.status).toBe(200);
      expect((await r.json() as any).pedido.status).toBe(status);
    }
    const est = await (await req(app, env, 'GET', '/api/suministros-ciudadano/estado', cit)).json() as any;
    expect(est.requests[0].status).toBe('entregada');
  });

  it('invalid status → 400, missing id → 404, and citizen cannot set estado', async () => {
    const { app, env, db } = setup();
    const id = await seedPedido(app, env, db);
    expect((await req(app, env, 'POST', `/api/suministros-ciudadano/admin/pedidos/${id}/estado`, adm, { status: 'volando' })).status).toBe(400);
    expect((await req(app, env, 'POST', '/api/suministros-ciudadano/admin/pedidos/req_nope/estado', adm, { status: 'entregada' })).status).toBe(404);
    expect((await req(app, env, 'POST', `/api/suministros-ciudadano/admin/pedidos/${id}/estado`, cit, { status: 'entregada' })).status).toBe(403);
  });
});
