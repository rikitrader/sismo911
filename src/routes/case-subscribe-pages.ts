// Public confirm / unsubscribe landing pages for case email alerts. Mounted at
// `/s` (non-/api ⇒ open under route-policy). These are the GET links inside the
// double-opt-in + change-alert emails. Server-rendered HTML (no inline script ⇒
// no CSP hash needed) styled to match the SISMO911 institutional navy.

import { Hono } from 'hono';
import type { Env } from '../types';
import { confirmSubscription, unsubscribeByToken } from '../lib/case-subscribe';

export const caseSubscribePages = new Hono<{ Bindings: Env }>();

const esc = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page(opts: { title: string; emoji: string; heading: string; body: string; cta?: { href: string; label: string } }): string {
  const cta = opts.cta
    ? `<a href="${esc(opts.cta.href)}" style="display:inline-block;background:#13284f;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 26px;border-radius:9px;margin-top:8px">${esc(opts.cta.label)}</a>`
    : '';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(opts.title)} — SISMO911</title></head>
<body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#1f2430">
<div style="max-width:520px;margin:48px auto;padding:0 16px">
  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden">
    <div style="background:#13284f;padding:20px 28px">
      <span style="color:#fff;font-size:21px;font-weight:800;letter-spacing:.3px">SISMO911</span>
      <div style="color:#cdd6ea;font-size:11px;letter-spacing:.12em;text-transform:uppercase">Comando Sísmico Nacional</div>
    </div>
    <div style="padding:32px 28px">
      <div style="font-size:40px;line-height:1;margin-bottom:14px">${opts.emoji}</div>
      <h1 style="margin:0 0 12px;font-size:22px;color:#13284f">${esc(opts.heading)}</h1>
      <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#374151">${opts.body}</p>
      ${cta}
    </div>
    <div style="padding:16px 28px;background:#f9fafb;border-top:1px solid #eee;color:#6b7280;font-size:12px">
      <a href="https://sismo911.com" style="color:#13284f">sismo911.com</a> · Plataforma nacional de emergencia sísmica
    </div>
  </div>
</div></body></html>`;
}

const html = (c: any, s: string, status = 200) => c.html(s, status);

// GET /s/verify/:token — confirm a subscription (double opt-in).
caseSubscribePages.get('/verify/:token', async (c) => {
  const origin = new URL(c.req.url).origin;
  const r = await confirmSubscription(c.env, c.req.param('token'), origin);
  if (!r.ok) {
    return html(c, page({
      title: 'Enlace no válido', emoji: '⚠️', heading: 'Enlace no válido o vencido',
      body: 'Este enlace de confirmación no es válido o ya fue usado. Vuelve al caso e inténtalo de nuevo.',
      cta: { href: `${origin}/casos`, label: 'Ir a los casos' },
    }), 404);
  }
  const who = r.caseName ? ` de <b>${esc(r.caseName)}</b>` : '';
  return html(c, page({
    title: 'Avisos activados', emoji: '✅', heading: 'Avisos activados',
    body: `Listo. Te avisaremos por correo cuando haya una novedad en el caso${who}: un cambio de estado, una nueva pista verificada o un cambio en los datos.`,
    cta: { href: r.caseUrl || `${origin}/casos`, label: 'Ver el caso' },
  }));
});

// GET /s/unsub/:token — one-click unsubscribe.
caseSubscribePages.get('/unsub/:token', async (c) => {
  const origin = new URL(c.req.url).origin;
  const r = await unsubscribeByToken(c.env, c.req.param('token'));
  const who = r.caseName ? ` del caso de <b>${esc(r.caseName)}</b>` : '';
  return html(c, page({
    title: 'Suscripción cancelada', emoji: '🔕', heading: 'Suscripción cancelada',
    body: `Ya no recibirás más avisos por correo${who}. Puedes volver a seguirlo cuando quieras desde la página del caso.`,
    cta: { href: r.caseId ? `${origin}/casos#caso=${encodeURIComponent(r.caseId)}` : `${origin}/casos`, label: 'Ver el caso' },
  }));
});
