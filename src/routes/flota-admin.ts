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
