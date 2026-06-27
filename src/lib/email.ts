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

// ---- Telemedicine ----------------------------------------------------------

// Sent to a physician right after they register as a volunteer telemedicine doctor.
export function telemedDoctorWelcomeEmail(name: string, panelUrl: string): EmailMsg {
  const hi = name ? `Dr(a). ${name},` : 'Hola,';
  const html = layout('Tu registro médico en SISMO911 Telemedicina',
    h2('Gracias por sumarte a la red médica') +
    p(hi) +
    p('Tu registro como <b>médico voluntario de SISMO911 Telemedicina</b> quedó activo. Desde tu panel podrás ver las solicitudes de pacientes en Venezuela, aceptarlas, agendar una videoconsulta y atender de forma remota desde cualquier parte del mundo.') +
    `<p style="margin:0 0 20px">${button(panelUrl, 'Abrir mi panel médico')}</p>` +
    p('<b>Guarda este enlace:</b> incluye tu acceso privado al panel. No lo compartas. Tu cuenta atiende a personas en una emergencia — gracias por tu servicio.'));
  const text = `${hi}\n\nTu registro como médico voluntario de SISMO911 Telemedicina está activo.\nAbre tu panel (enlace privado, no lo compartas):\n${panelUrl}`;
  return { subject: 'Tu panel médico — SISMO911 Telemedicina', html, text };
}

// Sent to the patient/relative right after they submit a help request.
export function telemedRequestReceivedEmail(opts: { name?: string; refId: string; manageUrl: string; specialty?: string }): EmailMsg {
  const hi = opts.name ? `Hola ${opts.name},` : 'Hola,';
  const ref = opts.refId.toUpperCase();
  const spec = opts.specialty ? `<tr><td style="padding:4px 14px;color:#6b7280">Especialidad</td><td style="padding:4px 14px;text-align:right;font-weight:600">${opts.specialty}</td></tr>` : '';
  const html = layout('Tu solicitud de telemedicina fue recibida — SISMO911',
    h2('✓ Solicitud recibida') +
    p(hi) +
    p('Recibimos tu solicitud de <b>atención médica remota</b>. Un médico voluntario la revisará y, al aceptarla, agendará una videoconsulta. Te avisaremos por este correo en cada paso.') +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-size:14px">
       <tr><td colspan="2" style="background:#13284f;color:#fff;padding:10px 14px;font-weight:700;letter-spacing:.04em">COMPROBANTE DE SOLICITUD</td></tr>
       <tr><td style="padding:10px 14px 4px;color:#6b7280">N.º de referencia</td><td style="padding:10px 14px 4px;text-align:right;font-weight:800;color:#13284f;font-family:monospace">${ref}</td></tr>
       ${spec}
       <tr><td style="padding:4px 14px 12px;color:#6b7280">Estado</td><td style="padding:4px 14px 12px;text-align:right;font-weight:700;color:#9a6400">Esperando médico</td></tr>
     </table>` +
    `<p style="margin:0 0 20px">${button(opts.manageUrl, 'Ver el estado de mi solicitud')}</p>` +
    p('<b>¿Emergencia con vida en riesgo?</b> La telemedicina no sustituye al 911. Si hay riesgo inmediato, llama al <b>911</b> o acude al centro de salud más cercano.'));
  const text = `${hi}\n\nTu solicitud de telemedicina fue recibida.\nN.º de referencia: ${ref}\nEstado: Esperando médico\nSigue el estado aquí: ${opts.manageUrl}\n\n¿Vida en riesgo? Llama al 911.`;
  return { subject: `Solicitud de telemedicina recibida (${ref}) — SISMO911`, html, text };
}

// Sent to the patient when a doctor accepts (claims) their request.
export function telemedClaimedEmail(opts: { patientName?: string; doctorName: string; specialty?: string; manageUrl: string }): EmailMsg {
  const hi = opts.patientName ? `Hola ${opts.patientName},` : 'Hola,';
  const spec = opts.specialty ? ` (${opts.specialty})` : '';
  const html = layout('Un médico aceptó tu solicitud — SISMO911',
    h2('Un médico aceptó tu caso') +
    p(hi) +
    p(`<b>Dr(a). ${opts.doctorName}</b>${spec} aceptó tu solicitud de telemedicina y agendará tu videoconsulta. Recibirás un nuevo correo con el día, la hora y el enlace de la videollamada.`) +
    `<p style="margin:0 0 20px">${button(opts.manageUrl, 'Ver mi solicitud')}</p>`);
  const text = `${hi}\n\nDr(a). ${opts.doctorName}${spec} aceptó tu solicitud de telemedicina y agendará la videoconsulta. Sigue el estado: ${opts.manageUrl}`;
  return { subject: 'Un médico aceptó tu solicitud — SISMO911', html, text };
}

// Sent to BOTH patient and doctor when the consult is scheduled. forDoctor flips the copy.
export function telemedScheduledEmail(opts: { toName?: string; counterpartName: string; whenText: string; videoUrl: string; icsUrl: string; manageUrl: string; forDoctor: boolean }): EmailMsg {
  const hi = opts.toName ? `Hola ${opts.toName},` : 'Hola,';
  const who = opts.forDoctor ? `paciente <b>${opts.counterpartName}</b>` : `Dr(a). <b>${opts.counterpartName}</b>`;
  const html = layout('Tu videoconsulta está agendada — SISMO911',
    h2('🎥 Videoconsulta agendada') +
    p(hi) +
    p(`Tu videoconsulta de telemedicina con ${who} está confirmada.`) +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-size:14px">
       <tr><td colspan="2" style="background:#13284f;color:#fff;padding:10px 14px;font-weight:700;letter-spacing:.04em">CITA</td></tr>
       <tr><td style="padding:10px 14px 4px;color:#6b7280">Cuándo</td><td style="padding:10px 14px 4px;text-align:right;font-weight:700;color:#13284f">${opts.whenText}</td></tr>
       <tr><td style="padding:4px 14px 12px;color:#6b7280">Modalidad</td><td style="padding:4px 14px 12px;text-align:right;font-weight:600">Videollamada (navegador, sin instalar nada)</td></tr>
     </table>` +
    `<p style="margin:0 0 12px">${button(opts.videoUrl, 'Entrar a la videoconsulta')}</p>` +
    p(`A la hora de la cita, abre el botón de arriba desde tu teléfono o computadora. Si el botón no funciona, copia y pega este enlace:<br><span style="color:#13284f;word-break:break-all">${opts.videoUrl}</span>`) +
    p(`<a href="${opts.icsUrl}" style="color:#13284f;font-weight:600">📅 Agregar a mi calendario (Google / Apple / Outlook)</a> &nbsp;·&nbsp; <a href="${opts.manageUrl}" style="color:#13284f;font-weight:600">Ver detalles</a>`));
  const text = `${hi}\n\nVideoconsulta de telemedicina con ${opts.forDoctor ? 'el paciente' : 'el Dr(a).'} ${opts.counterpartName}.\nCuándo: ${opts.whenText}\nEntrar a la videollamada: ${opts.videoUrl}\nAgregar al calendario: ${opts.icsUrl}\nDetalles: ${opts.manageUrl}`;
  return { subject: `Videoconsulta agendada — ${opts.whenText} — SISMO911`, html, text };
}

// Sent to the patient on key appointment status changes (telemedicine v2 lifecycle).
export function telemedApptStatusEmail(opts: {
  toName?: string; kind: 'in_progress' | 'completed' | 'cancelled' | 'no_show';
  doctorName?: string; whenText?: string; videoUrl?: string; manageUrl: string;
}): EmailMsg {
  const hi = opts.toName ? `Hola ${opts.toName},` : 'Hola,';
  const dr = opts.doctorName ? `Dr(a). ${opts.doctorName}` : 'tu médico';
  const map = {
    in_progress: {
      subject: 'Tu médico te está esperando — entra ahora — SISMO911',
      title: '🟢 Tu consulta está por comenzar',
      body: p(`${dr} ya está en la sala. <b>Entra ahora</b> a tu videoconsulta.`) +
        (opts.videoUrl ? `<p style="margin:0 0 12px">${button(opts.videoUrl, 'Entrar a la videoconsulta')}</p>` : ''),
    },
    completed: {
      subject: 'Tu consulta finalizó — SISMO911',
      title: '✓ Consulta completada',
      body: p(`Tu videoconsulta con ${dr} finalizó. Gracias por usar SISMO911 Telemedicina. Cuídate y sigue las indicaciones de tu médico.`),
    },
    cancelled: {
      subject: 'Tu cita fue cancelada — SISMO911',
      title: 'Cita cancelada',
      body: p(`Tu cita${opts.whenText ? ` del <b>${opts.whenText}</b>` : ''} fue cancelada. Puedes agendar una nueva cuando quieras.`) +
        `<p style="margin:0 0 12px">${button('https://sismo911.com/telemedicina', 'Agendar otra cita')}</p>`,
    },
    no_show: {
      subject: 'No pudimos realizar tu consulta — SISMO911',
      title: 'No asististe a tu cita',
      body: p(`Tu médico marcó la cita${opts.whenText ? ` del <b>${opts.whenText}</b>` : ''} como no asistida. Si aún necesitas atención, agenda una nueva cita.`) +
        `<p style="margin:0 0 12px">${button('https://sismo911.com/telemedicina', 'Agendar otra cita')}</p>`,
    },
  }[opts.kind];
  const html = layout(map.subject, h2(map.title) + p(hi) + map.body +
    p(`<a href="${opts.manageUrl}" style="color:#13284f;font-weight:600">Ver el estado de mi cita</a>`));
  const text = `${hi}\n\n${map.title}\nVer tu cita: ${opts.manageUrl}` + (opts.videoUrl && opts.kind === 'in_progress' ? `\nEntrar: ${opts.videoUrl}` : '');
  return { subject: map.subject, html, text };
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
