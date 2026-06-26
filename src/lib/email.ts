import type { Env } from '../types';

export interface EmailMsg { subject: string; html: string; text: string; }

// --- Token helpers (also used by the password-reset flow) ---
export function randomToken(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// --- Send via the native Cloudflare Email Sending binding (env.EMAIL). ---
// No API keys: the `send_email` binding sends from an onboarded domain.
// Returns false (and logs) if the binding is absent or the send fails, so a
// missing email never breaks the request flow.
export async function sendEmail(env: Env, to: string, msg: EmailMsg): Promise<boolean> {
  const from = { email: (env.EMAIL_FROM || 'no-reply@sismo911.com'), name: 'SISMO911' };
  if (!env.EMAIL) {
    console.warn('[email] EMAIL binding missing — not sent:', msg.subject, '→', to);
    return false;
  }
  try {
    await env.EMAIL.send({ to, from, subject: msg.subject, html: msg.html, text: msg.text });
    return true;
  } catch (e: any) {
    console.error('[email] send failed:', e?.message ?? e);
    return false;
  }
}

// --- Branded HTML layout (institutional navy) ---
function layout(preheader: string, bodyHtml: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#1f2430">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${preheader}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px">
 <tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
   <tr><td style="background:#13284f;padding:20px 28px">
     <span style="color:#fff;font-size:21px;font-weight:800;letter-spacing:.3px">SISMO911</span>
     <div style="color:#cdd6ea;font-size:11px;letter-spacing:.12em;text-transform:uppercase">Comando Sísmico Nacional</div>
   </td></tr>
   <tr><td style="padding:28px 28px 8px">${bodyHtml}</td></tr>
   <tr><td style="padding:18px 28px 24px;background:#f9fafb;border-top:1px solid #eee;color:#6b7280;font-size:12px;line-height:1.5">
     Plataforma nacional de emergencia sísmica de Venezuela · <a href="https://sismo911.com" style="color:#13284f">sismo911.com</a><br>
     Si no solicitaste esto, ignora este correo; tu cuenta sigue segura.
   </td></tr>
  </table>
 </td></tr>
</table></body></html>`;
}
function button(href: string, label: string): string {
  return `<a href="${href}" style="display:inline-block;background:#13284f;color:#fff;text-decoration:none;font-weight:bold;font-size:15px;padding:13px 26px;border-radius:8px">${label}</a>`;
}
const h2 = (t: string) => `<h1 style="margin:0 0 12px;font-size:20px;color:#13284f">${t}</h1>`;
const p = (t: string) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151">${t}</p>`;

// --- Templates ---
export function resetEmail(name: string, link: string): EmailMsg {
  const hi = name ? `Hola ${name},` : 'Hola,';
  const html = layout('Restablece tu contraseña de SISMO911',
    h2('Restablece tu contraseña') +
    p(hi) +
    p('Recibimos una solicitud para restablecer la contraseña de tu cuenta SISMO911. Haz clic en el botón para crear una nueva contraseña:') +
    `<p style="margin:0 0 20px">${button(link, 'Restablecer contraseña')}</p>` +
    p('Este enlace <b>expira en 1 hora</b> y solo puede usarse una vez.') +
    p(`Si el botón no funciona, copia y pega este enlace:<br><span style="color:#13284f;word-break:break-all">${link}</span>`));
  const text = `${hi}\n\nRestablece tu contraseña de SISMO911 con este enlace (expira en 1 hora):\n${link}\n\nSi no lo solicitaste, ignora este correo.`;
  return { subject: 'Restablece tu contraseña — SISMO911', html, text };
}

export function welcomeEmail(name: string): EmailMsg {
  const hi = name ? `Hola ${name},` : 'Hola,';
  const html = layout('Bienvenido a SISMO911',
    h2('Tu cuenta está lista') +
    p(hi) +
    p('Bienvenido a <b>SISMO911</b>, la plataforma nacional de emergencia sísmica de Venezuela. Ya puedes monitorear sismos en tiempo real, reportar daños, enviar SOS y reconectar con tu familia.') +
    `<p style="margin:0 0 20px">${button('https://sismo911.com/', 'Abrir SISMO911')}</p>` +
    p('Ante un sismo: protégete, conserva la calma y sigue las indicaciones oficiales. Para emergencias marca <b>911</b>.'));
  const text = `${hi}\n\nBienvenido a SISMO911. Abre la plataforma: https://sismo911.com/\nEmergencias: 911.`;
  return { subject: 'Bienvenido a SISMO911', html, text };
}

export function passwordChangedEmail(name: string): EmailMsg {
  const hi = name ? `Hola ${name},` : 'Hola,';
  const html = layout('Tu contraseña de SISMO911 fue cambiada',
    h2('Tu contraseña fue cambiada') +
    p(hi) +
    p('La contraseña de tu cuenta SISMO911 acaba de actualizarse y todas tus sesiones se cerraron por seguridad.') +
    p('<b>¿No fuiste tú?</b> Restablece tu contraseña de inmediato y revisa tu cuenta:') +
    `<p style="margin:0 0 20px">${button('https://sismo911.com/login', 'Ir a iniciar sesión')}</p>`);
  const text = `${hi}\n\nTu contraseña de SISMO911 fue cambiada y tus sesiones se cerraron. Si no fuiste tú, restablécela: https://sismo911.com/login`;
  return { subject: 'Tu contraseña fue cambiada — SISMO911', html, text };
}

// Confirmation sent to a citizen after a damage report is received (status=pending).
export function reportReceivedEmail(opts: { name?: string; refId: string; categoryLabel: string; place?: string }): EmailMsg {
  const hi = opts.name ? `Hola ${opts.name},` : 'Hola,';
  const ref = opts.refId.toUpperCase();
  const placeLine = opts.place ? `<tr><td style="padding:4px 0;color:#6b7280">Ubicación</td><td style="padding:4px 0;text-align:right;font-weight:600">${opts.place}</td></tr>` : '';
  const html = layout('Tu reporte fue recibido — SISMO911',
    h2('✓ Reporte recibido') +
    p(hi) +
    p('Gracias por reportar. Tu reporte ciudadano fue recibido y está <b>en revisión por un operador</b> del Comando Sísmico Nacional. Una vez verificado, se publicará en el mapa de emergencia.') +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-size:14px">
       <tr><td colspan="2" style="background:#13284f;color:#fff;padding:10px 14px;font-weight:700;letter-spacing:.04em">COMPROBANTE DE REPORTE</td></tr>
       <tr><td style="padding:10px 14px 4px;color:#6b7280">N.º de referencia</td><td style="padding:10px 14px 4px;text-align:right;font-weight:800;color:#13284f;font-family:monospace">${ref}</td></tr>
       <tr><td style="padding:4px 14px;color:#6b7280">Tipo</td><td style="padding:4px 14px;text-align:right;font-weight:600">${opts.categoryLabel}</td></tr>
       ${placeLine ? placeLine.replace(/padding:4px 0/g, 'padding:4px 14px') : ''}
       <tr><td style="padding:4px 14px 12px;color:#6b7280">Estado</td><td style="padding:4px 14px 12px;text-align:right;font-weight:700;color:#9a6400">En revisión</td></tr>
     </table>` +
    p('<b>Qué sigue:</b> un operador verifica tu reporte. Si necesitas atención inmediata con vida en riesgo, no esperes — usa el botón SOS o llama al <b>911</b>.') +
    `<p style="margin:0 0 20px">${button('https://sismo911.com/mapa', 'Ver el mapa de emergencia')}</p>` +
    p('Guarda tu número de referencia por si necesitas dar seguimiento. Tu ubicación exacta nunca se publica: se redondea a ~100 m.'));
  const text = `${hi}\n\nTu reporte ciudadano fue recibido y está en revisión por un operador de SISMO911.\n\nN.º de referencia: ${ref}\nTipo: ${opts.categoryLabel}${opts.place ? `\nUbicación: ${opts.place}` : ''}\nEstado: En revisión\n\n¿Vida en riesgo? Usa el botón SOS o llama al 911.\nMapa de emergencia: https://sismo911.com/mapa`;
  return { subject: `Reporte recibido (${ref}) — SISMO911`, html, text };
}
