import { Hono } from 'hono';
import type { Env } from '../types';
import { requirePermission } from '../rbac/middleware';
import { uid } from '../lib/db';
import { sendEmail } from '../lib/email';

// Guardianes founding-ally profile backend. Mounted at /api/guardianes.
//   • POST /mensaje    — PUBLIC. The /guardianes contact form posts here. Stores
//     the message and emails it to Guardianes (GUARDIANES_CONTACT_EMAIL) or, if
//     that is not configured yet, to the SISMO911 ops relay so nothing is lost.
//   • POST /asistente  — PUBLIC. Real Workers-AI assistant (env.AI) that answers
//     visitor questions about Guardianes and child protection and helps draft a
//     message. Guardrailed: child-safety emergencies are redirected to 911 / SOS.
//   • GET  /admin/mensajes — ops:console. Operator inbox of received messages.
export const guardianes = new Hono<{ Bindings: Env }>();

const ASUNTOS = ['alianza', 'donacion', 'voluntariado', 'caso', 'prensa', 'otro'] as const;
type Asunto = (typeof ASUNTOS)[number];
const ASUNTO_LABELS: Record<Asunto, string> = {
  alianza: 'Alianza / colaboración',
  donacion: 'Donación',
  voluntariado: 'Voluntariado',
  caso: 'Reportar un caso',
  prensa: 'Prensa / medios',
  otro: 'Otro',
};
const ESTADOS = ['nuevo', 'leido', 'respondido', 'archivado'] as const;

const str = (v: unknown, max: number) => (v == null ? '' : String(v).trim().slice(0, max));
const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function ref(): string {
  const s = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (const n of crypto.getRandomValues(new Uint8Array(6))) out += s[n % s.length];
  return `GUA-${out}`;
}
const guardianesEmail = (env: Env) =>
  (env as unknown as { GUARDIANES_CONTACT_EMAIL?: string }).GUARDIANES_CONTACT_EMAIL || '';

// ── POST /api/guardianes/mensaje — contact Guardianes (public, anonymous) ──────
guardianes.post('/mensaje', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (str(b.website, 200)) return c.json({ ok: true, ref: ref() }, 201); // honeypot

  const nombre = str(b.nombre, 120);
  const email = str(b.email, 160).toLowerCase();
  const telefono = str(b.telefono, 60);
  const organizacion = str(b.organizacion, 160);
  const asuntoRaw = str(b.asunto, 40) as Asunto;
  const asunto: Asunto = (ASUNTOS as readonly string[]).includes(asuntoRaw) ? asuntoRaw : 'otro';
  const mensaje = str(b.mensaje, 4000);

  const missing: string[] = [];
  if (!nombre) missing.push('nombre');
  if (!isEmail(email)) missing.push('email');
  if (!mensaje) missing.push('mensaje');
  if (missing.length) return c.json({ error: 'missing_fields', need: missing }, 400);

  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
  const ipHash = (await sha256Hex(`guardianes:${ip}`)).slice(0, 32);
  try {
    const since = Date.now() - 3600_000;
    const row: any = await c.env.DB
      .prepare(`SELECT COUNT(*) AS n FROM guardianes_mensajes WHERE ip_hash = ? AND created_ms > ?`)
      .bind(ipHash, since).first();
    if (Number(row?.n) >= 6) return c.json({ error: 'rate_limited' }, 429);
  } catch { /* fail-open */ }

  const now = Date.now();
  const id = uid('gua');
  const r = ref();

  // Forward to Guardianes (or the ops relay) — capture delivery for the record.
  const to = guardianesEmail(c.env) || c.env.OPS_ALERT_EMAIL || '';
  let delivered = 0;
  if (to) {
    const relayNote = guardianesEmail(c.env) ? '' :
      '<p style="color:#777;font-size:12px">(Entregado vía relé de la Alianza SISMO911 — configurar GUARDIANES_CONTACT_EMAIL para entrega directa.)</p>';
    const ok = await sendEmail(c.env, to, {
      subject: `Guardianes · nuevo mensaje [${r}] — ${ASUNTO_LABELS[asunto]}`,
      text: `Nuevo mensaje para Guardianes (${r})\n\nDe: ${nombre} <${email}>\nTeléfono: ${telefono || '—'}\nOrganización: ${organizacion || '—'}\nAsunto: ${ASUNTO_LABELS[asunto]}\n\n${mensaje}`,
      html: `<p>Nuevo mensaje para <b>Guardianes</b> <code>${r}</code></p>`
        + `<ul><li><b>De:</b> ${esc(nombre)} &lt;${esc(email)}&gt;</li>`
        + `<li><b>Teléfono:</b> ${esc(telefono || '—')}</li>`
        + `<li><b>Organización:</b> ${esc(organizacion || '—')}</li>`
        + `<li><b>Asunto:</b> ${ASUNTO_LABELS[asunto]}</li></ul>`
        + `<p style="white-space:pre-wrap">${esc(mensaje)}</p>${relayNote}`,
    }, { replyTo: { email, name: nombre } }).catch(() => false);
    delivered = ok ? 1 : 0;
  }

  await c.env.DB.prepare(
    `INSERT INTO guardianes_mensajes
       (id, ref, nombre, email, telefono, organizacion, asunto, mensaje, estado, entregado, ip_hash, created_ms, updated_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'nuevo', ?, ?, ?, ?)`
  ).bind(id, r, nombre, email, telefono || null, organizacion || null, asunto, mensaje, delivered, ipHash, now, now).run();

  return c.json({ ok: true, ref: r, delivered: Boolean(delivered) }, 201);
});

// ── POST /api/guardianes/asistente — real Workers-AI assistant (public) ────────
const GUARDIANES_SYSTEM = `Eres el asistente virtual de GUARDIANES, una organización venezolana de protección de la niñez y aliado fundador de la Alianza Humanitaria de SISMO911. Lema: "Vigilamos · Protegemos · Apoyamos — Cada infancia".

Tu rol:
- Responder con calidez y claridad, en español, preguntas sobre Guardianes: su misión (vigilar, proteger y apoyar a la niñez), cómo colaborar, donar, ser voluntario, o aliarse.
- Ayudar a la persona a redactar el mensaje que enviará a Guardianes por el formulario de contacto de la página.
- Explicar que Guardianes trabaja junto a SISMO911 para integrar la protección de la niñez en la respuesta ante emergencias.

Reglas estrictas:
- Céntrate SOLO en Guardianes, protección infantil y la Alianza Humanitaria. Si preguntan algo ajeno, redirige amablemente.
- NO inventes datos de contacto (correos, teléfonos, direcciones), cifras, ni nombres de personas. Si no sabes un dato, di que pueden escribir por el formulario o por Instagram @guardianes.vzla.
- EMERGENCIA / NIÑO EN PELIGRO INMEDIATO: si alguien reporta un menor en riesgo inminente, indícale con prioridad contactar de inmediato a las autoridades (911 / protección civil) y usar el SOS de SISMO911 en sismo911.com/sos. No sustituyes a los servicios de emergencia.
- Sé breve (2-5 frases). No uses formato markdown pesado.`;

guardianes.post('/asistente', async (c) => {
  const ai = c.env.AI;
  if (!ai) return c.json({ error: 'ai_unavailable' }, 503);
  const b = (await c.req.json().catch(() => ({}))) as { messages?: Array<{ role: string; content: string }>; message?: string };

  // Accept either a single message or a short history; cap size to bound cost.
  let history = Array.isArray(b.messages) ? b.messages : [];
  if (b.message) history = [...history, { role: 'user', content: String(b.message) }];
  history = history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-8)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 1500) }));
  if (!history.length || history[history.length - 1].role !== 'user') {
    return c.json({ error: 'no_message' }, 400);
  }

  const model = (c.env as unknown as { GUARDIANES_AI_MODEL?: string }).GUARDIANES_AI_MODEL
    || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  try {
    const resp: any = await ai.run(model, {
      messages: [{ role: 'system', content: GUARDIANES_SYSTEM }, ...history],
      max_tokens: 400, temperature: 0.4,
    });
    const reply = String(resp?.response ?? resp?.choices?.[0]?.message?.content ?? '').trim();
    if (!reply) return c.json({ error: 'empty' }, 502);
    return c.json({ ok: true, reply });
  } catch (e) {
    return c.json({ error: 'ai_error' }, 502);
  }
});

// ── GET /api/guardianes/admin/mensajes — operator inbox (ops:console) ──────────
guardianes.get('/admin/mensajes', requirePermission('ops:console'), async (c) => {
  const estado = str(c.req.query('estado'), 20);
  const where = ESTADOS.includes(estado as any) ? `WHERE estado = ?` : '';
  const stmt = c.env.DB.prepare(
    `SELECT id, ref, nombre, email, telefono, organizacion, asunto, mensaje, estado, entregado, created_ms
       FROM guardianes_mensajes ${where} ORDER BY created_ms DESC LIMIT 300`
  );
  const { results } = await (where ? stmt.bind(estado) : stmt).all();
  return c.json({ ok: true, mensajes: results ?? [] });
});
