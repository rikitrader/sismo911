import { Hono } from 'hono';
import type { Env } from '../types';
import { requirePermission } from '../rbac/middleware';
import { getUserFromRequest } from '../lib/auth';
import { sendEmail } from '../lib/email';
import { audit } from '../lib/audit';

// "Send as ricardo@sismo911.com" — a gated outbound mailer that sends through the
// Worker's native send_email binding (env.EMAIL), no third-party SMTP. Every
// endpoint is operator-only (ops:console). Mounted at /api/send-as.
//   • POST /        — send an email as ricardo@sismo911.com to any recipient.
//   • POST /draft   — Workers-AI drafts {subject, body} from a short prompt.
export const sendas = new Hono<{ Bindings: Env }>();

// The fixed sender identity for this tool. Any address on the onboarded
// sismo911.com zone is allowed by the send_email binding.
const FROM_EMAIL = 'ricardo@sismo911.com';
const FROM_NAME = 'Ricardo Prieto';

const str = (v: unknown, max: number) => (v == null ? '' : String(v).trim().slice(0, max));
const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
// Preserve the writer's line breaks as a simple, personal-looking HTML body.
const toHtml = (body: string) =>
  `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1f2430">${esc(body).replace(/\n/g, '<br>')}</div>`;

// POST /api/send-as — send as ricardo@sismo911.com (ops:console).
sendas.post('/', requirePermission('ops:console'), async (c) => {
  const me = await getUserFromRequest(c.env, c);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const to = str(b.to, 200).toLowerCase();
  const subject = str(b.subject, 200);
  const body = str(b.body ?? b.text ?? b.mensaje, 20000);
  const replyToRaw = str(b.replyTo, 200).toLowerCase();
  const name = str(b.fromName, 80) || FROM_NAME;

  const missing: string[] = [];
  if (!isEmail(to)) missing.push('to');
  if (!subject) missing.push('subject');
  if (!body) missing.push('body');
  if (missing.length) return c.json({ error: 'missing_fields', need: missing }, 400);

  const replyTo = isEmail(replyToRaw) ? replyToRaw : FROM_EMAIL;
  const ok = await sendEmail(
    c.env, to,
    { subject, text: body, html: toHtml(body) },
    { from: { email: FROM_EMAIL, name }, replyTo: { email: replyTo, name } },
  );
  if (!ok) return c.json({ error: 'send_failed' }, 502);

  // Audit trail for the outbound mailer (who sent to whom).
  c.executionCtx?.waitUntil?.(
    audit(c, 'send_as_email', { to, subject, from: FROM_EMAIL, by: me?.id ?? 'unknown' }).catch(() => {}),
  );
  return c.json({ ok: true, from: FROM_EMAIL, to });
});

// POST /api/send-as/draft — Workers-AI email drafter (ops:console).
const DRAFT_SYSTEM = `Eres un asistente que redacta correos electrónicos profesionales y claros en nombre de Ricardo Prieto (ricardo@sismo911.com), fundador de SISMO911. Respondes SIEMPRE y ÚNICAMENTE con un objeto JSON válido: {"subject":"...","body":"..."}. El "body" es texto plano con saltos de línea (\\n), sin firmas duplicadas ni marcadores de posición como [nombre]. Escribe en el idioma del pedido (por defecto español). Sé conciso y cordial. No inventes datos que no te den.`;

sendas.post('/draft', requirePermission('ops:console'), async (c) => {
  const ai = c.env.AI;
  if (!ai) return c.json({ error: 'ai_unavailable' }, 503);
  const b = (await c.req.json().catch(() => ({}))) as { prompt?: string; to?: string };
  const prompt = str(b.prompt, 3000);
  if (!prompt) return c.json({ error: 'no_prompt' }, 400);

  const model = (c.env as unknown as { GUARDIANES_AI_MODEL?: string }).GUARDIANES_AI_MODEL
    || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  const userMsg = `Redacta el correo que describo. ${b.to ? `Destinatario: ${str(b.to, 200)}. ` : ''}Pedido: ${prompt}`;
  try {
    const resp: any = await ai.run(model, {
      messages: [{ role: 'system', content: DRAFT_SYSTEM }, { role: 'user', content: userMsg }],
      max_tokens: 800, temperature: 0.4,
    });
    const raw = String(resp?.response ?? resp?.choices?.[0]?.message?.content ?? '');
    // Pull the first {...} block and parse it; fall back to using the whole text as the body.
    const m = raw.match(/\{[\s\S]*\}/);
    let subject = '', body = '';
    if (m) {
      try { const j = JSON.parse(m[0]); subject = str(j.subject, 200); body = str(j.body, 20000); } catch { /* fall through */ }
    }
    if (!body) body = str(raw, 20000);
    return c.json({ ok: true, subject, body });
  } catch {
    return c.json({ error: 'ai_error' }, 502);
  }
});
