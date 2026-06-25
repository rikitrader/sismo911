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
