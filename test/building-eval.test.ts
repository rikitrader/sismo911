import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { makeDb, makeEnv, type D1Mock, RBAC_MIGRATIONS } from './helpers/d1';
import { hashPassword } from '../src/lib/auth';
import { buildings } from '../src/routes/buildings';
import {
  signEvent, verifyEventSignature, levelOrderViolation, summarizeEval, type EvalEventRow,
} from '../src/lib/building-eval';

// ── Pure invariants (no DB) — same style as building-score.test.ts ────────────

const baseEv = (over: Partial<EvalEventRow> = {}): EvalEventRow => ({
  building_id: 'b1', level: 1, status: 'en_curso', event_kind: 'inicio',
  note: 'arranque', actor_name: 'Ing. Pérez', actor_role: 'Estructural',
  signed_by: 'Ing. Pérez', user_id: 'usr_1', user_name: 'Op',
  voids_event_id: null, created_at: '2026-07-02T12:00:00.000Z', ...over,
});

describe('building-eval — signatures', () => {
  it('sign → verify round-trips', async () => {
    const ev = baseEv();
    ev.signature = await signEvent(ev);
    expect(await verifyEventSignature(ev)).toBe(true);
  });
  it('tampering any signed field breaks verification', async () => {
    const ev = baseEv();
    ev.signature = await signEvent(ev);
    expect(await verifyEventSignature({ ...ev, note: 'alterado' })).toBe(false);
    expect(await verifyEventSignature({ ...ev, status: 'completada' })).toBe(false);
    expect(await verifyEventSignature({ ...ev, user_id: 'usr_2' })).toBe(false);
    expect(await verifyEventSignature({ ...ev, signature: undefined })).toBe(false);
  });
});

describe('building-eval — level order rule', () => {
  const P = { 1: 'pendiente', 2: 'pendiente', 3: 'pendiente' } as Record<number, string>;
  const C1 = { 1: 'completada', 2: 'pendiente', 3: 'pendiente' } as Record<number, string>;
  const C12 = { 1: 'completada', 2: 'completada', 3: 'pendiente' } as Record<number, string>;
  it('level 1 can always start/complete', () => {
    expect(levelOrderViolation(P, 1, 'en_curso')).toBeNull();
    expect(levelOrderViolation(P, 1, 'completada')).toBeNull();
  });
  it('level N requires all lower levels completada', () => {
    expect(levelOrderViolation(P, 2, 'en_curso')).toMatch(/Nivel 1 no está completado/);
    expect(levelOrderViolation(P, 3, 'completada')).toMatch(/Nivel 1 no está completado/);
    expect(levelOrderViolation(C1, 2, 'en_curso')).toBeNull();
    expect(levelOrderViolation(C1, 3, 'en_curso')).toMatch(/Nivel 2 no está completado/);
    expect(levelOrderViolation(C12, 3, 'completada')).toBeNull();
  });
  it('pendiente/bloqueada/no-status events are allowed at any level', () => {
    expect(levelOrderViolation(P, 3, 'bloqueada')).toBeNull();
    expect(levelOrderViolation(P, 3, 'pendiente')).toBeNull();
    expect(levelOrderViolation(P, 3, null)).toBeNull();
    expect(levelOrderViolation(P, 3, undefined)).toBeNull();
  });
});

describe('building-eval — summarizeEval with annulments', () => {
  it('voided status events stop counting; annulments never drive status', () => {
    // Newest-first, as the SQL returns them.
    const rows: EvalEventRow[] = [
      baseEv({ id: 3, level: 1, event_kind: 'anulacion', status: null, voids_event_id: 2, created_at: '2026-07-02T14:00:00Z' }),
      baseEv({ id: 2, level: 1, status: 'completada', event_kind: 'cambio_estado', created_at: '2026-07-02T13:00:00Z' }),
      baseEv({ id: 1, level: 1, status: 'en_curso', event_kind: 'inicio', created_at: '2026-07-02T12:00:00Z' }),
    ];
    const s = summarizeEval(rows);
    expect(s.eventCount).toBe(3);                              // full trail kept
    expect(s.events.find((e) => e.id === 2)?.voided).toBe(true);
    expect(s.levels[0].status).toBe('en_curso');               // completada was annulled
    expect(s.levels[0].events).toBe(1);                        // only the live, non-annulment event
    expect(s.progress).toBe(0);
    expect(s.currentLevel).toBe(1);
  });
  it('all three completada ⇒ progress 100, no current level', () => {
    const rows: EvalEventRow[] = [3, 2, 1].map((l, i) =>
      baseEv({ id: 10 + i, level: l, status: 'completada', created_at: `2026-07-02T1${i}:00:00Z` }));
    const s = summarizeEval(rows);
    expect(s.progress).toBe(100);
    expect(s.currentLevel).toBeNull();
  });
});

// ── Route-level (real SQLite via D1Mock + real migrations) ────────────────────

const MIGRATIONS = [...RBAC_MIGRATIONS, 'migrations/0093_building_eval.sql', 'migrations/0094_building_eval_v2.sql'];

async function setup() {
  const db: D1Mock = makeDb(MIGRATIONS);
  db.raw.exec('ALTER TABLE users ADD COLUMN wallet_address TEXT');
  db.raw.exec('ALTER TABLE users ADD COLUMN must_change_pw INTEGER NOT NULL DEFAULT 0');
  db.raw.exec('ALTER TABLE users ADD COLUMN mfa_required INTEGER NOT NULL DEFAULT 0');
  db.raw.exec(`CREATE TABLE tv_buildings (id TEXT PRIMARY KEY, name TEXT)`);
  db.raw.exec(`INSERT INTO tv_buildings (id, name) VALUES ('b1', 'Edificio Prueba')`);
  const env = makeEnv(db);
  const app = new Hono();
  app.route('/api/buildings', buildings);
  const now = Date.now();
  const op = await hashPassword('oppw');
  db.raw.prepare(`INSERT INTO users (id,email,name,role,pw_hash,pw_salt,status,created_ms) VALUES (?,?,?,?,?,?,?,?)`)
    .run('usr_op', 'op@s.com', 'Operadora Uno', 'operator', op.hash, op.salt, 'active', now);
  db.raw.prepare(`INSERT INTO sessions (token,user_id,expires_ms,created_ms) VALUES (?,?,?,?)`)
    .run('tok_op', 'usr_op', now + 86_400_000, now);
  return { db, env, app };
}

const OP = { Authorization: 'Bearer tok_op', 'content-type': 'application/json' };
const post = (app: Hono, env: any, body: unknown, headers: any = OP) =>
  app.request('/api/buildings/reported/b1/eval/events', { method: 'POST', headers, body: JSON.stringify(body) }, env);

describe('eval routes — user binding, order, annulment, verify', () => {
  it('POST without a session → 401 (identity is stamped, not free text)', async () => {
    const { env, app } = await setup();
    const r = await post(app, env, { level: 1, note: 'x' }, { 'content-type': 'application/json' });
    expect(r.status).toBe(401);
  });

  it('POST stamps the authenticated user and signs it', async () => {
    const { env, app } = await setup();
    const r = await post(app, env, { level: 1, event_kind: 'inicio', status: 'en_curso', actor_name: 'Ing. P' });
    expect(r.status).toBe(201);
    const j: any = await r.json();
    expect(j.user_name).toBe('Operadora Uno');
    expect(j.signature).toMatch(/^[0-9a-f]{64}$/);
    const g: any = await (await app.request('/api/buildings/reported/b1/eval', {}, env)).json();
    expect(g.eventCount).toBe(1);
    expect(g.events[0].user_id).toBe('usr_op');
    expect(g.levels[0].status).toBe('en_curso');
  });

  it('out-of-order status → 409; in order → 201', async () => {
    const { env, app } = await setup();
    expect((await post(app, env, { level: 2, status: 'en_curso' })).status).toBe(409);
    expect((await post(app, env, { level: 1, status: 'completada' })).status).toBe(201);
    expect((await post(app, env, { level: 2, status: 'en_curso' })).status).toBe(201);
  });

  it('anulacion voids an event and re-derives status; bad target → 400', async () => {
    const { env, app } = await setup();
    await post(app, env, { level: 1, status: 'completada' });
    const g1: any = await (await app.request('/api/buildings/reported/b1/eval', {}, env)).json();
    const evId = g1.events[0].id;
    expect((await post(app, env, { level: 1, event_kind: 'anulacion', voids_event_id: 999 })).status).toBe(400);
    expect((await post(app, env, { level: 1, event_kind: 'anulacion', voids_event_id: evId })).status).toBe(201);
    const g2: any = await (await app.request('/api/buildings/reported/b1/eval', {}, env)).json();
    expect(g2.levels[0].status).toBe('pendiente');
    expect(g2.events.find((e: any) => e.id === evId).voided).toBe(true);
  });

  it('verify endpoint flags a tampered row', async () => {
    const { db, env, app } = await setup();
    await post(app, env, { level: 1, status: 'en_curso', note: 'original' });
    let v: any = await (await app.request('/api/buildings/reported/b1/eval/verify', {}, env)).json();
    expect(v.total).toBe(1);
    expect(v.valid).toBe(1);
    db.raw.exec(`UPDATE building_eval_events SET note = 'adulterado' WHERE building_id = 'b1'`);
    v = await (await app.request('/api/buildings/reported/b1/eval/verify', {}, env)).json();
    expect(v.valid).toBe(0);
    expect(v.invalid.length).toBe(1);
  });
});
