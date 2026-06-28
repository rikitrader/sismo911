// Admin/operator REST surface for the live-GPS system. Mounted at /api/admin/flota
// and gated operator/admin-only for ALL methods (src/index.ts isFlotaAdminApi).
// Units, scoped tokens (issue/revoke), and the live snapshot / admin WS feed.

import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { getUserFromRequest } from '../lib/auth';
import { issueUnitToken, revokeUnitToken, revokeUnitTokensFor } from '../lib/flota-token';
import { audit } from '../lib/flota-audit';

export const flotaAdmin = new Hono<{ Bindings: Env }>();

const UNIT_TYPES = ['ambulancia', 'rescate', 'bomberos', 'carga', 'moto', 'dron', 'otro'];
const UNIT_STATUS = ['active', 'inactive', 'suspended'];
const str = (v: unknown, max: number) => (v == null ? null : String(v).trim().slice(0, max) || null);
const intOf = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

async function actorId(c: any): Promise<string | null> {
  const u = await getUserFromRequest(c.env, c).catch(() => null);
  return u?.id ?? null;
}

// POST /units — create a live unit.
flotaAdmin.post('/units', async (c) => {
  const b = await c.req.json().catch(() => null);
  const name = str(b?.name, 120);
  if (!name) return c.json({ error: 'name requerido' }, 400);
  const type = UNIT_TYPES.includes(b?.type) ? b.type : 'rescate';
  const status = UNIT_STATUS.includes(b?.status) ? b.status : 'active';
  const operator = await actorId(c);
  const id = uid('unit');
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO flota_units (id, name, type, status, operator_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`
  ).bind(id, name, type, status, operator, now, now).run();
  await audit(c.env, { actorId: operator, unitId: id, action: 'unit.create', meta: { name, type } });
  return c.json({ ok: true, id, name, type, status }, 201);
});

// GET /units — list units (newest first), with token count + last fix.
flotaAdmin.get('/units', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT u.*,
       (SELECT COUNT(*) FROM flota_unit_tokens t WHERE t.unit_id = u.id AND t.revoked_at IS NULL) AS active_tokens,
       (SELECT MAX(recorded_at) FROM flota_locations l WHERE l.unit_id = u.id) AS last_fix_at
     FROM flota_units u ORDER BY u.created_at DESC LIMIT 1000`
  ).all();
  return c.json({ results: results ?? [] });
});

// POST /units/:id/token — issue a scoped, expiring token. Plaintext shown ONCE.
flotaAdmin.post('/units/:id/token', async (c) => {
  const id = c.req.param('id');
  const unit = await c.env.DB.prepare(`SELECT id FROM flota_units WHERE id = ?`).bind(id).first();
  if (!unit) return c.json({ error: 'unit no encontrada' }, 404);
  const b = await c.req.json().catch(() => ({} as any));
  const label = str(b?.label, 120);
  const expiresInHours = b?.expiresInHours != null ? Math.max(0, intOf(b.expiresInHours) ?? 12) : 12; // default 12h
  const createdBy = await actorId(c);
  const issued = await issueUnitToken(c.env, id, { label, expiresInHours, createdBy });
  // Audit WITHOUT the raw token (flota-audit also strips secret keys defensively).
  await audit(c.env, { actorId: createdBy, unitId: id, action: 'token.issue', meta: { tokenId: issued.id, label, expiresAt: issued.expiresAt } });
  return c.json({
    ok: true, tokenId: issued.id, token: issued.token, expiresAt: issued.expiresAt,
    trackUrl: `/flota/track/${issued.token}`,
    aviso: 'Guarde este token: no se mostrará de nuevo.',
  }, 201);
});

// POST /units/:id/revoke-token — revoke one token ({tokenId}) or ALL for the unit.
flotaAdmin.post('/units/:id/revoke-token', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => ({} as any));
  const tokenId = str(b?.tokenId, 64);
  const by = await actorId(c);
  if (tokenId) {
    const ok = await revokeUnitToken(c.env, tokenId);
    if (!ok) return c.json({ error: 'token no encontrado o ya revocado' }, 404);
    await audit(c.env, { actorId: by, unitId: id, action: 'token.revoke', meta: { tokenId } });
    return c.json({ ok: true, tokenId, revoked: true });
  }
  const n = await revokeUnitTokensFor(c.env, id);
  await audit(c.env, { actorId: by, unitId: id, action: 'token.revoke', meta: { revokedCount: n } });
  return c.json({ ok: true, revokedCount: n });
});

// GET /live — admin WebSocket subscription (Upgrade) OR JSON snapshot of active
// units + their latest fix + active dispatch (for initial map render).
flotaAdmin.get('/live', async (c) => {
  if (c.req.header('Upgrade') === 'websocket') {
    const id = c.env.FLEET_LIVE.idFromName('global');
    const headers = new Headers(c.req.raw.headers);
    headers.set('x-flota-role', 'admin');
    const fwd = new Request(c.req.url, { method: 'GET', headers });
    return c.env.FLEET_LIVE.get(id).fetch(fwd);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.type, u.status,
       l.lat, l.lng, l.accuracy_m, l.heading, l.speed_mps, l.battery_pct, l.recorded_at, l.received_at,
       d.case_id AS dispatch_case_id, d.status AS dispatch_status
     FROM flota_units u
     LEFT JOIN flota_locations l ON l.id = (SELECT id FROM flota_locations WHERE unit_id = u.id ORDER BY recorded_at DESC LIMIT 1)
     LEFT JOIN flota_dispatches d ON d.id = (SELECT id FROM flota_dispatches WHERE unit_id = u.id AND status != 'cleared' ORDER BY assigned_at DESC LIMIT 1)
     WHERE u.status = 'active' ORDER BY u.name`
  ).all();
  return c.json({ units: results ?? [], now: Date.now() });
});

// ── Dispatches (assign a unit to a case/emergency) ───────────────────────────

const DISPATCH_STATUS = ['assigned', 'enroute', 'onscene', 'cleared'];

// POST /units/:id/dispatch — assign the unit to a case. The unit must exist and
// be active, and must not already have an open (non-cleared) dispatch.
flotaAdmin.post('/units/:id/dispatch', async (c) => {
  const unitId = c.req.param('id');
  const unit = await c.env.DB.prepare(`SELECT status FROM flota_units WHERE id = ?`).bind(unitId)
    .first() as { status: string } | null;
  if (!unit) return c.json({ error: 'unit no encontrada' }, 404);
  if (unit.status !== 'active') return c.json({ error: 'unit_inactive' }, 409);

  const open = await c.env.DB.prepare(
    `SELECT id FROM flota_dispatches WHERE unit_id = ? AND status != 'cleared' LIMIT 1`
  ).bind(unitId).first();
  if (open) return c.json({ error: 'unit_ya_despachada' }, 409);

  const b = await c.req.json().catch(() => ({} as any));
  const case_id = str(b?.case_id, 120);
  const status = DISPATCH_STATUS.includes(b?.status) && b.status !== 'cleared' ? b.status : 'assigned';
  const by = await actorId(c);
  const id = uid('dsp');
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO flota_dispatches (id, unit_id, case_id, status, assigned_by, assigned_at) VALUES (?,?,?,?,?,?)`
  ).bind(id, unitId, case_id, status, by, now).run();
  await audit(c.env, { actorId: by, unitId, action: 'unit.update', meta: { dispatch: id, case_id, status } });
  return c.json({ ok: true, id, unit_id: unitId, case_id, status, assigned_at: now }, 201);
});

// PATCH /dispatches/:id — advance status; 'cleared' stamps cleared_at.
flotaAdmin.patch('/dispatches/:id', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => ({} as any));
  const status = str(b?.status, 20);
  if (!status || !DISPATCH_STATUS.includes(status)) return c.json({ error: 'status inválido' }, 400);
  const row = await c.env.DB.prepare(`SELECT unit_id, status FROM flota_dispatches WHERE id = ?`).bind(id)
    .first() as { unit_id: string; status: string } | null;
  if (!row) return c.json({ error: 'no encontrado' }, 404);
  if (row.status === 'cleared') return c.json({ error: 'despacho_cerrado' }, 409);

  const cleared = status === 'cleared' ? Date.now() : null;
  await c.env.DB.prepare(
    `UPDATE flota_dispatches SET status = ?, cleared_at = COALESCE(?, cleared_at) WHERE id = ?`
  ).bind(status, cleared, id).run();
  const by = await actorId(c);
  await audit(c.env, { actorId: by, unitId: row.unit_id, action: 'unit.update', meta: { dispatch: id, status } });
  return c.json({ ok: true, id, status, cleared_at: cleared });
});

// GET /dispatches — list; ?status= and ?unit_id= filters; ?open=1 for non-cleared.
flotaAdmin.get('/dispatches', async (c) => {
  const where: string[] = [];
  const vals: unknown[] = [];
  const status = c.req.query('status');
  if (status && DISPATCH_STATUS.includes(status)) { where.push('d.status = ?'); vals.push(status); }
  const unitId = c.req.query('unit_id');
  if (unitId) { where.push('d.unit_id = ?'); vals.push(unitId); }
  if (c.req.query('open') === '1') where.push("d.status != 'cleared'");
  const sql =
    `SELECT d.*, u.name AS unit_name, u.type AS unit_type
     FROM flota_dispatches d LEFT JOIN flota_units u ON u.id = d.unit_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY d.assigned_at DESC LIMIT 500`;
  const { results } = await c.env.DB.prepare(sql).bind(...vals).all();
  return c.json({ results: results ?? [] });
});
