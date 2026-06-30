import { Hono } from 'hono';
import type { Env } from '../types';
import { getUserFromRequest } from '../lib/auth';
import { requirePermission, currentUser } from '../rbac/middleware';
import { uid } from '../lib/db';

// SUMINISTROS — citizen enrollment + supply requests. Mounted at
// /api/suministros-ciudadano.
//   • Citizen side — self-authenticated via getUserFromRequest, scoped to the
//     caller's own user_id (like /api/profile, /api/support citizen endpoints).
//   • Admin side   — /admin/* gated by requirePermission('ops:console') exactly
//     like src/routes/support.ts (legacy operator + super_admin).
// NOTE: this prefix is deliberately separate from /api/suministros (the operator
// inventory ledger). It is excluded from the suministros:read / :manage gates in
// route-policy.ts so citizens can reach their own intake without staff access.

export const suministrosCiudadano = new Hono<{ Bindings: Env }>();

const str = (v: unknown, max: number) => (v == null ? '' : String(v).trim().slice(0, max));
const clampInt = (v: unknown, min: number, max: number, dflt: number) => {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};

const TIPOS_SOLICITANTE = ['beneficiario', 'coordinador_refugio', 'lider_comunitario', 'organizacion'] as const;
const TIPOS_PEDIDO = ['alimentos', 'agua', 'medicinas', 'higiene', 'abrigo', 'otro'] as const;
const URGENCIAS = ['baja', 'normal', 'alta'] as const;

function enrollmentDTO(r: any) {
  if (!r) return null;
  return {
    id: r.id, nombre: r.nombre, cedula: r.cedula, contacto: r.contacto, ubicacion: r.ubicacion,
    tipo: r.tipo, personas: r.personas, necesidad: r.necesidad, status: r.status,
    review_note: r.review_note ?? null, reviewer: r.reviewer ?? null,
    created_ms: r.created_ms, reviewed_ms: r.reviewed_ms ?? null,
  };
}
function adminEnrollmentDTO(r: any) {
  return { ...enrollmentDTO(r), user_id: r.user_id };
}
function requestDTO(r: any) {
  return {
    id: r.id, tipo: r.tipo, cantidad: r.cantidad, urgencia: r.urgencia,
    descripcion: r.descripcion, status: r.status, note: r.note ?? null,
    created_ms: r.created_ms, updated_ms: r.updated_ms,
  };
}

async function loadEnrollment(env: Env, userId: string): Promise<any | null> {
  return env.DB.prepare(`SELECT * FROM sum_citizen_enrollments WHERE user_id = ?`).bind(userId).first();
}

// ─────────────────────────────── CITIZEN SIDE ───────────────────────────────

// GET /estado — the caller's enrollment + (if approved) their requests.
suministrosCiudadano.get('/estado', async (c) => {
  const user = await getUserFromRequest(c.env, c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const enr = await loadEnrollment(c.env, user.id);
  let requests: any[] = [];
  if (enr && enr.status === 'aprobada') {
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM sum_citizen_requests WHERE user_id = ? ORDER BY created_ms DESC LIMIT 200`
    ).bind(user.id).all();
    requests = ((results ?? []) as any[]).map(requestDTO);
  }
  return c.json({ ok: true, enrollment: enrollmentDTO(enr), requests });
});

// POST /solicitud — create (or re-apply for) an enrollment for this user.
suministrosCiudadano.post('/solicitud', async (c) => {
  const user = await getUserFromRequest(c.env, c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const existing = await loadEnrollment(c.env, user.id);
  if (existing && (existing.status === 'pendiente' || existing.status === 'aprobada')) {
    return c.json({ error: 'already_enrolled', status: existing.status }, 409);
  }
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const nombre = str(b.nombre, 120);
  const cedula = str(b.cedula, 30);
  const contacto = str(b.contacto, 120);
  const ubicacion = str(b.ubicacion, 160);
  const necesidad = str(b.necesidad, 1000);
  const tipo = (TIPOS_SOLICITANTE as readonly string[]).includes(String(b.tipo)) ? String(b.tipo) : 'beneficiario';
  const personas = clampInt(b.personas, 1, 100000, 1);
  if (!nombre) return c.json({ error: 'missing_fields', need: ['nombre'] }, 400);

  const now = Date.now();
  const id = uid('enr');
  if (existing) {
    // Re-apply after a rejection: reset the SAME row back to 'pendiente'.
    await c.env.DB.prepare(
      `UPDATE sum_citizen_enrollments
          SET nombre = ?, cedula = ?, contacto = ?, ubicacion = ?, tipo = ?, personas = ?,
              necesidad = ?, status = 'pendiente', review_note = NULL, reviewer = NULL,
              reviewed_ms = NULL, created_ms = ?
        WHERE user_id = ?`
    ).bind(nombre, cedula, contacto, ubicacion, tipo, personas, necesidad, now, user.id).run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO sum_citizen_enrollments
         (id, user_id, nombre, cedula, contacto, ubicacion, tipo, personas, necesidad, status, created_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?)`
    ).bind(id, user.id, nombre, cedula, contacto, ubicacion, tipo, personas, necesidad, now).run();
  }
  const row = await loadEnrollment(c.env, user.id);
  return c.json({ ok: true, enrollment: enrollmentDTO(row) }, 201);
});

// POST /pedido — file a supply request (only for an APPROVED enrollment).
suministrosCiudadano.post('/pedido', async (c) => {
  const user = await getUserFromRequest(c.env, c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const enr = await loadEnrollment(c.env, user.id);
  if (!enr || enr.status !== 'aprobada') return c.json({ error: 'not_approved' }, 403);

  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const tipo = (TIPOS_PEDIDO as readonly string[]).includes(String(b.tipo)) ? String(b.tipo) : '';
  if (!tipo) return c.json({ error: 'invalid_tipo', allowed: TIPOS_PEDIDO }, 400);
  const cantidad = clampInt(b.cantidad, 1, 100000, 1);
  const urgencia = (URGENCIAS as readonly string[]).includes(String(b.urgencia)) ? String(b.urgencia) : 'normal';
  const descripcion = str(b.descripcion, 1000);

  const now = Date.now();
  const id = uid('req');
  await c.env.DB.prepare(
    `INSERT INTO sum_citizen_requests
       (id, user_id, tipo, cantidad, urgencia, descripcion, status, created_ms, updated_ms)
     VALUES (?, ?, ?, ?, ?, ?, 'pendiente', ?, ?)`
  ).bind(id, user.id, tipo, cantidad, urgencia, descripcion, now, now).run();
  const row: any = await c.env.DB.prepare(`SELECT * FROM sum_citizen_requests WHERE id = ?`).bind(id).first();
  return c.json({ ok: true, request: requestDTO(row) }, 201);
});

// ──────────────────────────────── ADMIN SIDE ────────────────────────────────
// All /admin/* gated by ops:console (legacy operator + super_admin), exactly
// like the support inbox staff endpoints.

// GET /admin/solicitudes?status= — enrollment applications, newest first.
suministrosCiudadano.get('/admin/solicitudes', requirePermission('ops:console'), async (c) => {
  const status = c.req.query('status');
  const where: string[] = []; const binds: unknown[] = [];
  if (status && (['pendiente', 'aprobada', 'rechazada'] as string[]).includes(status)) {
    where.push('status = ?'); binds.push(status);
  }
  const sql = `SELECT * FROM sum_citizen_enrollments ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_ms DESC LIMIT 200`;
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all();
  return c.json({ ok: true, solicitudes: ((results ?? []) as any[]).map(adminEnrollmentDTO) });
});

// POST /admin/solicitudes/:id/aprobar — approve an enrollment application.
suministrosCiudadano.post('/admin/solicitudes/:id/aprobar', requirePermission('ops:console'), async (c) => {
  return reviewEnrollment(c, 'aprobada');
});

// POST /admin/solicitudes/:id/rechazar — reject an enrollment application.
suministrosCiudadano.post('/admin/solicitudes/:id/rechazar', requirePermission('ops:console'), async (c) => {
  return reviewEnrollment(c, 'rechazada');
});

async function reviewEnrollment(c: any, status: 'aprobada' | 'rechazada') {
  const staff = currentUser(c);
  const id = c.req.param('id');
  const enr: any = await c.env.DB.prepare(`SELECT * FROM sum_citizen_enrollments WHERE id = ?`).bind(id).first();
  if (!enr) return c.json({ error: 'not_found' }, 404);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const note = str(b.note, 500) || null;
  const reviewer = staff?.email || staff?.id || null;
  await c.env.DB.prepare(
    `UPDATE sum_citizen_enrollments SET status = ?, reviewer = ?, review_note = ?, reviewed_ms = ? WHERE id = ?`
  ).bind(status, reviewer, note, Date.now(), id).run();
  const row: any = await c.env.DB.prepare(`SELECT * FROM sum_citizen_enrollments WHERE id = ?`).bind(id).first();
  return c.json({ ok: true, solicitud: adminEnrollmentDTO(row) });
}

// ── Supply-request lifecycle (operator) ──────────────────────────────────────
// Operators move a citizen's pedido through pendiente → aprobada → en_camino →
// entregada (or rechazada); the citizen sees each change on their /estado feed.
const PEDIDO_STATUSES = ['pendiente', 'aprobada', 'en_camino', 'entregada', 'rechazada'] as const;
function adminRequestDTO(r: any) {
  return { ...requestDTO(r), user_id: r.user_id, nombre: r.nombre ?? null };
}

// GET /admin/pedidos?status= — supply requests across all citizens, newest first.
suministrosCiudadano.get('/admin/pedidos', requirePermission('ops:console'), async (c) => {
  const status = c.req.query('status');
  const where: string[] = []; const binds: unknown[] = [];
  if (status && (PEDIDO_STATUSES as readonly string[]).includes(status)) {
    where.push('r.status = ?'); binds.push(status);
  }
  const sql = `SELECT r.*, e.nombre AS nombre
                 FROM sum_citizen_requests r
                 LEFT JOIN sum_citizen_enrollments e ON e.user_id = r.user_id
                ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY r.created_ms DESC LIMIT 200`;
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all();
  return c.json({ ok: true, pedidos: ((results ?? []) as any[]).map(adminRequestDTO) });
});

// POST /admin/pedidos/:id/estado — advance a supply request's status.
suministrosCiudadano.post('/admin/pedidos/:id/estado', requirePermission('ops:console'), async (c) => {
  const id = c.req.param('id');
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const status = str(b.status, 20);
  if (!(PEDIDO_STATUSES as readonly string[]).includes(status)) {
    return c.json({ error: 'invalid_status', allowed: PEDIDO_STATUSES }, 400);
  }
  const existing: any = await c.env.DB.prepare(`SELECT id FROM sum_citizen_requests WHERE id = ?`).bind(id).first();
  if (!existing) return c.json({ error: 'not_found' }, 404);
  const note = str(b.note, 500) || null;
  await c.env.DB.prepare(
    `UPDATE sum_citizen_requests SET status = ?, note = ?, updated_ms = ? WHERE id = ?`
  ).bind(status, note, Date.now(), id).run();
  const row: any = await c.env.DB.prepare(`SELECT * FROM sum_citizen_requests WHERE id = ?`).bind(id).first();
  return c.json({ ok: true, pedido: requestDTO(row) });
});
