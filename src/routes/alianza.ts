import { Hono } from 'hono';
import type { Env } from '../types';
import { requirePermission } from '../rbac/middleware';
import { uid } from '../lib/db';
import { sendEmail } from '../lib/email';

// Alliance ("Alianza Humanitaria") partnership intake. Mounted at /api/alianza.
//   • POST /              — PUBLIC. The /alianza CTA page posts partner requests
//     here (anonymous — a prospective partner has no SISMO911 session). Writes
//     one row to alianza_solicitudes and alerts ops by email. Honeypot + length
//     caps + a light per-IP throttle keep it from being a spam sink.
//   • GET  /admin/list    — ops:console. Operator review queue.
//   • POST /admin/:id/estado — ops:console. Advance a request's status.
export const alianza = new Hono<{ Bindings: Env }>();

const TIPOS = [
  'empresa', 'ong', 'medico', 'logistica', 'acopio',
  'voluntario', 'donante', 'gobierno', 'otro',
] as const;
type Tipo = (typeof TIPOS)[number];
const TIPO_LABELS: Record<Tipo, string> = {
  empresa: 'Empresa privada',
  ong: 'ONG / Fundación',
  medico: 'Médico / Hospital',
  logistica: 'Transporte y logística',
  acopio: 'Centro de acopio',
  voluntario: 'Voluntario certificado',
  donante: 'Donante institucional',
  gobierno: 'Gobierno local',
  otro: 'Otro aliado',
};
const ESTADOS = ['nueva', 'revisando', 'aceptada', 'archivada'] as const;

const str = (v: unknown, max: number) => (v == null ? '' : String(v).trim().slice(0, max));
const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function ref(): string {
  const s = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const rnd = crypto.getRandomValues(new Uint8Array(6));
  for (const n of rnd) out += s[n % s.length];
  return `ALI-${out}`;
}

const OPS_URL = 'https://sismo911.com/console/#/alianza';

// POST /api/alianza — open a partnership request (public, anonymous).
alianza.post('/', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  // Honeypot: bots fill hidden fields humans never see. Pretend success.
  if (str(b.website, 200) || str(b.fax, 200)) return c.json({ ok: true, ref: ref() }, 201);

  const nombre = str(b.nombre, 120);
  const organizacion = str(b.organizacion, 160);
  const tipoRaw = str(b.tipo, 40) as Tipo;
  const tipo: Tipo = (TIPOS as readonly string[]).includes(tipoRaw) ? tipoRaw : 'otro';
  const email = str(b.email, 160).toLowerCase();
  const telefono = str(b.telefono, 60);
  const ubicacion = str(b.ubicacion, 120);
  const area = str(b.area, 160);
  const mensaje = str(b.mensaje, 4000);

  const missing: string[] = [];
  if (!nombre) missing.push('nombre');
  if (!organizacion) missing.push('organizacion');
  if (!isEmail(email)) missing.push('email');
  if (missing.length) return c.json({ error: 'missing_fields', need: missing }, 400);

  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
  const ipHash = (await sha256Hex(`alianza:${ip}`)).slice(0, 32);

  // Light throttle: at most 5 requests per IP-hash per hour (fail-open on DB error).
  try {
    const since = Date.now() - 3600_000;
    const row: any = await c.env.DB
      .prepare(`SELECT COUNT(*) AS n FROM alianza_solicitudes WHERE ip_hash = ? AND created_ms > ?`)
      .bind(ipHash, since).first();
    if (Number(row?.n) >= 5) return c.json({ error: 'rate_limited' }, 429);
  } catch { /* fail-open */ }

  const now = Date.now();
  const id = uid('ali');
  const r = ref();
  await c.env.DB.prepare(
    `INSERT INTO alianza_solicitudes
       (id, ref, nombre, organizacion, tipo, email, telefono, ubicacion, area, mensaje, estado, ip_hash, created_ms, updated_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'nueva', ?, ?, ?)`
  ).bind(id, r, nombre, organizacion, tipo, email, telefono || null, ubicacion || null, area || null, mensaje || null, ipHash, now, now).run();

  // Alert ops so a partnership request doesn't sit unseen. Fail-open on email error.
  if (c.env.OPS_ALERT_EMAIL) {
    const esc = (s: string) => s.replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch] as string));
    c.executionCtx?.waitUntil?.(sendEmail(c.env, c.env.OPS_ALERT_EMAIL, {
      subject: `Nueva solicitud de alianza [${r}] — ${organizacion}`,
      text: `Nueva solicitud de alianza ${r}\n\nContacto: ${nombre}\nOrganización: ${organizacion}\nTipo: ${TIPO_LABELS[tipo]}\nEmail: ${email}\nTeléfono: ${telefono || '—'}\nUbicación: ${ubicacion || '—'}\nÁrea de apoyo: ${area || '—'}\n\nMensaje:\n${mensaje || '—'}\n\nRevisar: ${OPS_URL}`,
      html: `<p>Nueva solicitud de alianza <b>${r}</b></p>`
        + `<ul><li><b>Contacto:</b> ${esc(nombre)}</li><li><b>Organización:</b> ${esc(organizacion)}</li>`
        + `<li><b>Tipo:</b> ${TIPO_LABELS[tipo]}</li><li><b>Email:</b> ${esc(email)}</li>`
        + `<li><b>Teléfono:</b> ${esc(telefono || '—')}</li><li><b>Ubicación:</b> ${esc(ubicacion || '—')}</li>`
        + `<li><b>Área de apoyo:</b> ${esc(area || '—')}</li></ul>`
        + `<p><b>Mensaje:</b></p><pre style="white-space:pre-wrap">${esc(mensaje || '—')}</pre>`
        + `<p><a href="${OPS_URL}">Abrir en la consola</a></p>`,
    }).catch(() => {}));
  }

  return c.json({ ok: true, ref: r }, 201);
});

// GET /api/alianza/admin/list — operator review queue (ops:console).
alianza.get('/admin/list', requirePermission('ops:console'), async (c) => {
  const estado = str(c.req.query('estado'), 20);
  const where = ESTADOS.includes(estado as any) ? `WHERE estado = ?` : '';
  const stmt = c.env.DB.prepare(
    `SELECT id, ref, nombre, organizacion, tipo, email, telefono, ubicacion, area, mensaje, estado, created_ms, updated_ms
       FROM alianza_solicitudes ${where} ORDER BY created_ms DESC LIMIT 300`
  );
  const { results } = await (where ? stmt.bind(estado) : stmt).all();
  return c.json({ ok: true, solicitudes: results ?? [] });
});

// POST /api/alianza/admin/:id/estado — advance a request's status (ops:console).
alianza.post('/admin/:id/estado', requirePermission('ops:console'), async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const estado = str(b.estado, 20);
  if (!ESTADOS.includes(estado as any)) return c.json({ error: 'bad_estado' }, 400);
  const res = await c.env.DB
    .prepare(`UPDATE alianza_solicitudes SET estado = ?, updated_ms = ? WHERE id = ?`)
    .bind(estado, Date.now(), c.req.param('id')).run();
  if (!res.meta.changes) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});
