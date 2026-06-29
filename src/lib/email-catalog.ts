// ---------------------------------------------------------------------------
// Spanish (es-VE) transactional email templates. Every builder returns the
// rendered { subject, html, text } via the SISMO911 branded shell, so the whole
// suite looks identical to the approved sign-in sample. Variables are passed in;
// the shell escapes them.
// ---------------------------------------------------------------------------
import { renderBranded } from './email-brand';

type Rendered = { subject: string; html: string; text: string };

// AUTH-13 — passwordless sign-in (the canonical sample)
export function signInEmail(v: { name?: string; url: string; sample?: boolean }): Rendered {
  return renderBranded({
    subject: 'Inicia sesión en SISMO911 — enlace de acceso',
    eyebrow: 'Acceso · Iniciar sesión',
    heading: 'Inicia sesión en SISMO911.',
    paras: [
      v.name ? `Hola ${v.name}:` : 'Hola:',
      'Usa el enlace de abajo para entrar al Centro de Operaciones. Es de un solo uso y vence en 15 minutos. Si no lo solicitaste, puedes ignorar este mensaje con tranquilidad.',
    ],
    securityNote: 'Cualquiera con este enlace puede acceder a tu panel. No lo reenvíes. Nunca te lo pediremos por teléfono.',
    button: { label: 'Iniciar sesión', url: v.url },
    afterButtonNote: 'El enlace es válido por 15 minutos · Un solo uso',
    pasteUrl: v.url,
    isSample: v.sample,
  });
}

// AUTH-01 — email verification
export function verifyEmail(v: { name?: string; url: string; sample?: boolean }): Rendered {
  return renderBranded({
    subject: 'Verifica tu correo de SISMO911',
    eyebrow: 'Cuenta · Verificación',
    heading: 'Verifica tu correo.',
    paras: [v.name ? `Hola ${v.name}:` : 'Hola:', 'Gracias por registrarte en SISMO911. Para activar tu cuenta, confirma tu dirección de correo con el botón de abajo.'],
    button: { label: 'Verificar correo', url: v.url },
    afterButtonNote: 'El enlace vence en 30 minutos · Un solo uso',
    pasteUrl: v.url,
    footerNote: 'Si no creaste esta cuenta, ignora este mensaje.',
    isSample: v.sample,
  });
}

// AUTH-02 — welcome
export function welcomeEmail(v: { name?: string; url: string; sample?: boolean }): Rendered {
  return renderBranded({
    subject: 'Bienvenido a SISMO911 — tu cuenta está activa',
    eyebrow: 'Cuenta · Bienvenida',
    heading: 'Tu cuenta está activa.',
    paras: [v.name ? `Hola ${v.name}:` : 'Hola:', 'Tu cuenta de SISMO911 quedó verificada. Ya puedes ingresar al Centro de Operaciones.', 'Por tu seguridad, activa la verificación en dos pasos (2FA) desde tu perfil.'],
    button: { label: 'Ir al panel', url: v.url },
    isSample: v.sample,
  });
}

// NOTIF-01 — generic in-app notification mirrored to email (payments, withdrawals).
export function notificationEmail(v: { title: string; body?: string; name?: string; url: string; sample?: boolean }): Rendered {
  return renderBranded({
    subject: v.title,
    eyebrow: 'Notificación · SISMO911',
    heading: v.title,
    paras: [v.name ? `Hola ${v.name}:` : 'Hola:', ...(v.body ? [v.body] : [])],
    button: { label: 'Ver en mi cuenta', url: v.url },
    isSample: v.sample,
  });
}

// AUTH-03 — password reset
export function passwordResetEmail(v: { url: string; sample?: boolean }): Rendered {
  return renderBranded({
    subject: 'Restablece tu contraseña de SISMO911',
    eyebrow: 'Cuenta · Recuperación',
    heading: 'Restablece tu contraseña.',
    paras: ['Hola:', 'Recibimos una solicitud para restablecer la contraseña de tu cuenta SISMO911. Crea una nueva contraseña con el botón de abajo.'],
    securityNote: 'Si no lo solicitaste, ignora este correo: tu contraseña no cambiará.',
    button: { label: 'Crear nueva contraseña', url: v.url },
    afterButtonNote: 'El enlace vence en 15 minutos · Un solo uso',
    pasteUrl: v.url,
    isSample: v.sample,
  });
}

// AUTH-04 — password changed confirmation
export function passwordChangedEmail(v: { when: string; device?: string; secureUrl: string; sample?: boolean }): Rendered {
  return renderBranded({
    subject: 'Tu contraseña de SISMO911 fue cambiada',
    eyebrow: 'Cuenta · Seguridad',
    heading: 'Tu contraseña fue cambiada.',
    paras: ['Hola:', `Te confirmamos que la contraseña de tu cuenta SISMO911 se cambió el ${v.when}${v.device ? ` desde ${v.device}` : ''}.`],
    securityNote: '¿No fuiste tú? Asegura tu cuenta de inmediato con el botón de abajo.',
    button: { label: 'No fui yo — asegurar cuenta', url: v.secureUrl },
    isSample: v.sample,
  });
}

// AUTH-05 — confirm new email
export function confirmNewEmailEmail(v: { url: string; sample?: boolean }): Rendered {
  return renderBranded({
    subject: 'Confirma tu nuevo correo de SISMO911',
    eyebrow: 'Cuenta · Cambio de correo',
    heading: 'Confirma tu nuevo correo.',
    paras: ['Hola:', 'Solicitaste cambiar el correo de tu cuenta SISMO911 a esta dirección. Confírmalo con el botón de abajo.'],
    button: { label: 'Confirmar correo', url: v.url },
    afterButtonNote: 'El enlace vence en 30 minutos · Un solo uso',
    pasteUrl: v.url,
    footerNote: 'Si no lo solicitaste, ignora este mensaje.',
    isSample: v.sample,
  });
}

// AUTH-06 — email change notice to the OLD address
export function emailChangeNoticeEmail(v: { oldEmail: string; newEmail: string; when: string; revertUrl: string; sample?: boolean }): Rendered {
  return renderBranded({
    subject: 'Se está cambiando el correo de tu cuenta SISMO911',
    eyebrow: 'Cuenta · Alerta',
    heading: 'Se está cambiando tu correo.',
    paras: ['Hola:', `Se solicitó cambiar el correo de tu cuenta SISMO911 de ${v.oldEmail} a ${v.newEmail} el ${v.when}.`],
    securityNote: 'Si no fuiste tú, revierte el cambio ahora con el botón de abajo.',
    button: { label: 'Revertir el cambio', url: v.revertUrl },
    isSample: v.sample,
  });
}

// AUTH-07 — MFA enrolled/disabled
export function mfaChangedEmail(v: { action: 'activada' | 'desactivada'; when: string; secureUrl: string; sample?: boolean }): Rendered {
  return renderBranded({
    subject: `La verificación en dos pasos fue ${v.action} en tu cuenta`,
    eyebrow: 'Cuenta · Seguridad',
    heading: `2FA ${v.action}.`,
    paras: ['Hola:', `La verificación en dos pasos (2FA) fue ${v.action} en tu cuenta SISMO911 el ${v.when}.`],
    securityNote: '¿No fuiste tú? Asegura tu cuenta de inmediato.',
    button: { label: 'Asegurar cuenta', url: v.secureUrl },
    isSample: v.sample,
  });
}

// AUTH-08 — new sign-in alert
export function newLoginEmail(v: { when: string; device: string; location: string; secureUrl: string; sample?: boolean }): Rendered {
  return renderBranded({
    subject: 'Nuevo inicio de sesión en tu cuenta SISMO911',
    eyebrow: 'Cuenta · Seguridad',
    heading: 'Nuevo inicio de sesión.',
    paras: ['Hola:', 'Detectamos un inicio de sesión en tu cuenta SISMO911:'],
    details: [
      { label: 'Fecha', value: v.when },
      { label: 'Dispositivo', value: v.device },
      { label: 'Ubicación aprox.', value: v.location },
    ],
    securityNote: 'Si fuiste tú, ignora este mensaje. Si no, asegura tu cuenta.',
    button: { label: 'No fui yo', url: v.secureUrl },
    isSample: v.sample,
  });
}

// AUTH-09 — account locked
export function accountLockedEmail(v: { minutes: number; resetUrl: string; sample?: boolean }): Rendered {
  return renderBranded({
    subject: 'Tu cuenta SISMO911 fue bloqueada temporalmente',
    eyebrow: 'Cuenta · Seguridad',
    heading: 'Cuenta bloqueada.',
    paras: ['Hola:', `Por seguridad, bloqueamos temporalmente tu cuenta SISMO911 tras varios intentos de inicio de sesión fallidos. Podrás reintentar en ${v.minutes} minutos, o restablecer tu contraseña ahora.`],
    button: { label: 'Restablecer contraseña', url: v.resetUrl },
    isSample: v.sample,
  });
}

// AUTH-10 — operator invitation
export function operatorInviteEmail(v: { inviter: string; role: string; url: string; sample?: boolean }): Rendered {
  return renderBranded({
    subject: 'Te invitaron al Centro de Operaciones SISMO911',
    eyebrow: 'Acceso · Invitación',
    heading: 'Has sido invitado.',
    paras: ['Hola:', `${v.inviter} te invitó a unirte al Centro de Operaciones SISMO911 con el rol de ${v.role}.`],
    button: { label: 'Aceptar invitación', url: v.url },
    afterButtonNote: 'La invitación vence en 7 días',
    isSample: v.sample,
  });
}

// MP-01 — missing-person case registered (to reporter)
export function caseRegisteredEmail(v: { caseRef: string; when: string; caseUrl: string; sample?: boolean }): Rendered {
  return renderBranded({
    subject: `Tu reporte de persona desaparecida — ${v.caseRef}`,
    eyebrow: 'Familia · Caso registrado',
    heading: 'Tu reporte fue registrado.',
    roleTag: 'CASO',
    paras: ['Hola:', 'Registramos tu reporte de persona desaparecida. Un operador lo revisará. Por seguridad, no compartas datos sensibles por correo.'],
    details: [
      { label: 'Caso', value: v.caseRef },
      { label: 'Fecha', value: v.when },
    ],
    button: { label: 'Ver el estado del caso', url: v.caseUrl },
    isSample: v.sample,
  });
}

// MP-04 — public tip acknowledgement
export function tipReceivedEmail(v: { sample?: boolean }): Rendered {
  return renderBranded({
    subject: 'Recibimos tu información — gracias',
    eyebrow: 'Familia · Colaboración',
    heading: 'Gracias por tu información.',
    roleTag: 'CASO',
    paras: ['Hola:', 'Gracias por enviar información sobre un caso SISMO911. Tu aporte fue recibido y será revisado por un operador. Por seguridad, no incluimos detalles del caso en este correo.'],
    isSample: v.sample,
  });
}

// FIN-01 — donation receipt
export function donationReceiptEmail(v: { name?: string; amount: string; when: string; ref: string; method: string; sample?: boolean }): Rendered {
  return renderBranded({
    subject: `Tu recibo de donación SISMO911 — ${v.amount}`,
    eyebrow: 'Finanzas · Recibo',
    heading: 'Gracias por tu donación.',
    roleTag: 'RECIBO',
    paras: [v.name ? `Hola ${v.name}:` : 'Hola:', 'Gracias por tu donación a SISMO911. Este correo es tu recibo oficial; conserva la referencia para tus registros.'],
    details: [
      { label: 'Monto', value: v.amount },
      { label: 'Fecha', value: v.when },
      { label: 'Referencia', value: v.ref },
      { label: 'Método', value: v.method },
    ],
    isSample: v.sample,
  });
}

// FIN-02 — payment confirmation
export function paymentConfirmedEmail(v: { amount: string; when: string; ref: string; sample?: boolean }): Rendered {
  return renderBranded({
    subject: `Pago confirmado — ${v.amount}`,
    eyebrow: 'Finanzas · Pago',
    heading: 'Pago confirmado.',
    roleTag: 'RECIBO',
    paras: ['Hola:', 'Confirmamos tu pago a SISMO911.'],
    details: [
      { label: 'Monto', value: v.amount },
      { label: 'Fecha', value: v.when },
      { label: 'Referencia', value: v.ref },
    ],
    securityNote: 'Si no reconoces este cargo, contacta a soporte de inmediato.',
    isSample: v.sample,
  });
}

// FIN-09 — payment failed / retry
export function paymentFailedEmail(v: { amount: string; when: string; payUrl: string; sample?: boolean }): Rendered {
  return renderBranded({
    subject: 'Acción requerida: tu pago SISMO911 falló',
    eyebrow: 'Finanzas · Acción requerida',
    heading: 'No pudimos procesar tu pago.',
    roleTag: 'RECIBO',
    paras: ['Hola:', `No pudimos procesar tu pago de ${v.amount} del ${v.when}. Por favor actualiza tu método de pago e inténtalo de nuevo.`],
    button: { label: 'Actualizar pago', url: v.payUrl },
    afterButtonNote: 'Reintentaremos automáticamente hasta 3 veces',
    isSample: v.sample,
  });
}

// VOL-01 — volunteer application received
export function volunteerApplicationEmail(v: { name?: string; ref: string; sample?: boolean }): Rendered {
  return renderBranded({
    subject: 'Recibimos tu solicitud de voluntariado SISMO911',
    eyebrow: 'Voluntariado · Solicitud',
    heading: 'Tu solicitud está en revisión.',
    roleTag: 'VOLUNTARIO',
    paras: [v.name ? `Hola ${v.name}:` : 'Hola:', 'Recibimos tu solicitud para ser voluntario de SISMO911. Nuestro equipo la revisará y te contactará con los siguientes pasos.'],
    details: [{ label: 'Referencia', value: v.ref }],
    isSample: v.sample,
  });
}

// Generic operational alert — covers OPS-04..07, MED-*, LOG-*, AVM-*, SHL-*,
// SEC-*, INT-*, SYS-* (any internal notification). Same branded shell.
export function operationalAlert(v: {
  subject: string;
  eyebrow: string;
  heading: string;
  roleTag?: string;
  paras?: string[];
  details?: { label: string; value: string }[];
  button?: { label: string; url: string };
  sample?: boolean;
}): Rendered {
  return renderBranded({
    subject: v.subject,
    eyebrow: v.eyebrow,
    heading: v.heading,
    roleTag: v.roleTag ?? 'OPERACIONES',
    paras: v.paras,
    details: v.details,
    button: v.button,
    isSample: v.sample,
  });
}
