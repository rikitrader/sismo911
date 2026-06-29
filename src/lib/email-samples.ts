// ---------------------------------------------------------------------------
// SISMO911 transactional-email SAMPLE registry — the full 77-email catalog from
// the source-of-truth sheet ("AIDRC — Transactional Email System", which ships on
// the SISMO911 brand/domain). Every catalogued email (AUTH/OPS/MED/LOG/FIN/VOL/
// MP/PA/SEC/AVM/SHL/CMP/INT/SYS) has a live, branded sample here. Dedicated
// builders render their real template; the rest render through operationalAlert
// with the sheet's exact subject. Used by GET /api/notify/preview to preview the
// whole suite without an anonymous send vector.
//
// Subjects are copied verbatim from the sheet; %placeholders% are filled with
// representative sample values so the preview shows a realistic message.
// ---------------------------------------------------------------------------
import {
  signInEmail, verifyEmail, welcomeEmail, passwordResetEmail, passwordChangedEmail,
  confirmNewEmailEmail, emailChangeNoticeEmail, mfaChangedEmail, newLoginEmail,
  accountLockedEmail, operatorInviteEmail, caseRegisteredEmail, tipReceivedEmail,
  donationReceiptEmail, paymentConfirmedEmail, paymentFailedEmail, volunteerApplicationEmail,
  operationalAlert,
} from './email-catalog';

type Rendered = { subject: string; html: string; text: string };

const VERIFY_URL = 'https://sismo911.com/api/auth/verify?token=muestra_ejemplo_no_valido';
const SECURE_URL = 'https://sismo911.com/cuenta/seguridad';

export interface SampleMeta {
  id: string;        // sheet ID, e.g. AUTH-01
  dept: string;      // department
  name: string;      // internal email name
  render: () => Rendered;
}

// Helper for the generic (operationalAlert-backed) catalog entries.
const op = (
  subject: string, roleTag: string, eyebrow: string, heading: string,
  paras: string[], details?: { label: string; value: string }[],
): (() => Rendered) => () => operationalAlert({ subject, roleTag, eyebrow, heading, paras, details, sample: true });

// The full 77-email catalog. Order mirrors the sheet's Master Email Catalog.
export const CATALOG: SampleMeta[] = [
  // ---- Identity & Access (AUTH) ----
  { id: 'AUTH-01', dept: 'Identity & Access', name: 'Email verification', render: () => verifyEmail({ name: 'Ricardo', url: VERIFY_URL, sample: true }) },
  { id: 'AUTH-02', dept: 'Identity & Access', name: 'Welcome / account ready', render: () => welcomeEmail({ name: 'Ricardo', url: 'https://sismo911.com/cuenta', sample: true }) },
  { id: 'AUTH-03', dept: 'Identity & Access', name: 'Password reset link', render: () => passwordResetEmail({ url: VERIFY_URL, sample: true }) },
  { id: 'AUTH-04', dept: 'Identity & Access', name: 'Password changed confirmation', render: () => passwordChangedEmail({ when: '28/06/2026 21:00', device: 'Chrome · macOS', secureUrl: SECURE_URL, sample: true }) },
  { id: 'AUTH-05', dept: 'Identity & Access', name: 'Confirm new email', render: () => confirmNewEmailEmail({ url: VERIFY_URL, sample: true }) },
  { id: 'AUTH-06', dept: 'Identity & Access', name: 'Email change notice (revert)', render: () => emailChangeNoticeEmail({ oldEmail: 'r@old.com', newEmail: 'r@new.com', when: '28/06/2026 21:00', revertUrl: SECURE_URL, sample: true }) },
  { id: 'AUTH-07', dept: 'Identity & Access', name: 'MFA status changed', render: () => mfaChangedEmail({ action: 'activada', when: '28/06/2026 21:00', secureUrl: SECURE_URL, sample: true }) },
  { id: 'AUTH-08', dept: 'Identity & Access', name: 'New sign-in alert', render: () => newLoginEmail({ when: '28/06/2026 21:00', device: 'Chrome · macOS', location: 'Caracas, VE', secureUrl: SECURE_URL, sample: true }) },
  { id: 'AUTH-09', dept: 'Identity & Access', name: 'Account locked', render: () => accountLockedEmail({ minutes: 15, resetUrl: VERIFY_URL, sample: true }) },
  { id: 'AUTH-10', dept: 'Identity & Access', name: 'Operator invitation', render: () => operatorInviteEmail({ inviter: 'J. Pérez', role: 'Operador', url: VERIFY_URL, sample: true }) },
  { id: 'AUTH-11', dept: 'Identity & Access', name: 'Access granted', render: op('Tu acceso a SISMO911 fue aprobado', 'ACCESO', 'Acceso · Aprobación', 'Tu acceso fue aprobado.', ['Hola:', 'Tu acceso al Centro de Operaciones SISMO911 fue aprobado por un administrador. Ya puedes ingresar con tu cuenta.'], [{ label: 'Rol', value: 'Operador' }]) },
  { id: 'AUTH-12', dept: 'Identity & Access', name: 'Account status changed', render: op('El acceso a tu cuenta SISMO911 ha cambiado', 'ACCESO', 'Acceso · Estado', 'El estado de tu cuenta cambió.', ['Hola:', 'El acceso a tu cuenta SISMO911 ha cambiado. Si crees que es un error, contacta a tu administrador.'], [{ label: 'Estado', value: 'Suspendida' }]) },
  { id: 'AUTH-13', dept: 'Identity & Access', name: 'Magic sign-in link', render: () => signInEmail({ name: 'Ricardo', url: VERIFY_URL, sample: true }) },

  // ---- Incident & Operations (OPS) ----
  { id: 'OPS-01', dept: 'Incident & Operations', name: 'Incident activation alert', render: op('[SISMO911] ACTIVADO — TERREMOTO — M6.2 La Guaira', 'OPERACIONES', 'Operaciones · Incidente activado', 'Incidente activado.', ['Se activó un incidente en el Centro de Operaciones. Abre el panel para revisar las propuestas de los agentes y aprobar acciones de riesgo vital.'], [{ label: 'Amenaza', value: 'Terremoto' }, { label: 'Región', value: 'La Guaira, VE' }, { label: 'Estado', value: 'activado' }]) },
  { id: 'OPS-02', dept: 'Incident & Operations', name: 'Approval needed (life-safety)', render: op('[SISMO911] ⚠ APROBACIÓN REQUERIDA — riesgo vital — Agente Logística', 'OPERACIONES', 'Operaciones · Aprobación requerida', 'Se requiere aprobación humana.', ['ACCIÓN DE RIESGO VITAL — aprueba o rechaza pronto.', 'Esta acción NO se ejecutará hasta que un humano responsable la apruebe.'], [{ label: 'Propuesta', value: 'prop_8821' }]) },
  { id: 'OPS-03', dept: 'Incident & Operations', name: 'Decision confirmation', render: op('[SISMO911] APROBADO — desplegar brigada', 'OPERACIONES', 'Operaciones · Decisión', 'Decisión registrada.', ['Una propuesta fue resuelta.'], [{ label: 'Acción', value: 'Desplegar brigada' }, { label: 'Decisión', value: 'APROBADO por IC' }]) },
  { id: 'OPS-04', dept: 'Incident & Operations', name: 'Incident escalation notice', render: op('[SISMO911] Incidente M6.2 La Guaira escalado a Nivel 3', 'OPERACIONES', 'Operaciones · Escalamiento', 'Incidente escalado.', ['El incidente fue escalado de nivel.'], [{ label: 'Nivel', value: 'Nivel 3' }]) },
  { id: 'OPS-05', dept: 'Incident & Operations', name: 'Unit dispatch order', render: op('[SISMO911] Despacho — Unidad B-04 → Sector Maiquetía', 'OPERACIONES', 'Operaciones · Despacho', 'Orden de despacho.', ['Se asignó una unidad a una tarea.'], [{ label: 'Unidad', value: 'B-04' }, { label: 'Sector', value: 'Maiquetía' }]) },
  { id: 'OPS-06', dept: 'Incident & Operations', name: 'SITREP digest', render: op('[SISMO911] SITREP — M6.2 La Guaira — periodo 3', 'OPERACIONES', 'Operaciones · SITREP', 'Reporte de situación.', ['Resumen del periodo operacional.'], [{ label: 'Periodo', value: '3' }]) },
  { id: 'OPS-07', dept: 'Incident & Operations', name: 'Incident closed / AAR ready', render: op('[SISMO911] Incidente cerrado — informe final disponible', 'OPERACIONES', 'Operaciones · Cierre', 'Incidente cerrado.', ['El incidente fue cerrado y el informe final está disponible.']) },

  // ---- Medical (MED) ----
  { id: 'MED-01', dept: 'Medical', name: 'Triage callout', render: op('[SISMO911-MED] Llamado de triaje — Hospital Vargas', 'MÉDICO', 'Médico · Triaje', 'Llamado de triaje.', ['Se solicita equipo médico en el sitio indicado.'], [{ label: 'Sitio', value: 'Hospital Vargas' }]) },
  { id: 'MED-02', dept: 'Medical', name: 'Hospital capacity alert', render: op('[SISMO911-MED] Capacidad crítica — Hospital Vargas', 'MÉDICO', 'Médico · Capacidad', 'Capacidad crítica.', ['Una instalación alcanzó capacidad crítica.'], [{ label: 'Instalación', value: 'Hospital Vargas' }]) },
  { id: 'MED-03', dept: 'Medical', name: 'Medical supply request', render: op('[SISMO911-MED] Solicitud de insumos — Sangre O-', 'MÉDICO', 'Médico · Insumos', 'Solicitud de insumos.', ['Se levantó una solicitud de insumos médicos.'], [{ label: 'Insumo', value: 'Sangre O-' }]) },
  { id: 'MED-04', dept: 'Medical', name: 'Patient transfer confirmation', render: op('[SISMO911-MED] Traslado confirmado — REF-4471', 'MÉDICO', 'Médico · Traslado', 'Traslado confirmado.', ['Se confirmó un traslado de paciente.'], [{ label: 'Referencia', value: 'REF-4471' }]) },
  { id: 'MED-05', dept: 'Medical', name: 'Epidemic watch alert', render: op('[SISMO911-MED] Vigilancia de brote — La Guaira', 'MÉDICO', 'Médico · Epidemiología', 'Vigilancia de brote.', ['Se cruzó un umbral epidemiológico en la región.'], [{ label: 'Región', value: 'La Guaira' }]) },

  // ---- Logistics & Supply (LOG) ----
  { id: 'LOG-01', dept: 'Logistics & Supply', name: 'Supply request ack', render: op('[SISMO911-LOG] Solicitud recibida — REF-2210', 'LOGÍSTICA', 'Logística · Solicitud', 'Solicitud recibida.', ['Recibimos tu solicitud de suministros.'], [{ label: 'Referencia', value: 'REF-2210' }]) },
  { id: 'LOG-02', dept: 'Logistics & Supply', name: 'Purchase order confirmation', render: op('[SISMO911-LOG] Orden de compra PO-118 confirmada', 'LOGÍSTICA', 'Logística · Compras', 'Orden de compra confirmada.', ['Se emitió una orden de compra.'], [{ label: 'OC', value: 'PO-118' }]) },
  { id: 'LOG-03', dept: 'Logistics & Supply', name: 'Low-stock / reorder alert', render: op('[SISMO911-LOG] Stock bajo — Agua 5L', 'LOGÍSTICA', 'Logística · Inventario', 'Stock bajo.', ['Un artículo cayó por debajo del punto de reorden.'], [{ label: 'Artículo', value: 'Agua 5L' }]) },
  { id: 'LOG-04', dept: 'Logistics & Supply', name: 'Shipment dispatched', render: op('[SISMO911-LOG] Envío SHP-77 despachado', 'LOGÍSTICA', 'Logística · Envío', 'Envío despachado.', ['Un envío fue despachado.'], [{ label: 'Envío', value: 'SHP-77' }]) },
  { id: 'LOG-05', dept: 'Logistics & Supply', name: 'Proof of delivery', render: op('[SISMO911-LOG] Entregado — SHP-77', 'LOGÍSTICA', 'Logística · Entrega', 'Entrega confirmada.', ['Se confirmó la entrega de un envío.'], [{ label: 'Envío', value: 'SHP-77' }]) },

  // ---- Finance & Donations (FIN) ----
  { id: 'FIN-01', dept: 'Finance & Donations', name: 'Donation receipt (tax)', render: () => donationReceiptEmail({ name: 'Ricardo', amount: '$50,00', when: '28/06/2026', ref: 'DON-77123', method: 'Tarjeta', sample: true }) },
  { id: 'FIN-02', dept: 'Finance & Donations', name: 'Payment confirmation', render: () => paymentConfirmedEmail({ amount: '$50,00', when: '28/06/2026', ref: 'PAY-88231', sample: true }) },
  { id: 'FIN-03', dept: 'Finance & Donations', name: 'Crypto payment receipt', render: op('Pago en USDC recibido — $50,00', 'RECIBO', 'Finanzas · USDC', 'Pago en USDC recibido.', ['Hola:', 'Recibimos tu pago en USDC. Gracias por tu aporte.'], [{ label: 'Monto', value: '$50,00' }, { label: 'Red', value: 'Base' }, { label: 'Transacción', value: '0x57cb…' }]) },
  { id: 'FIN-04', dept: 'Finance & Donations', name: 'Payout initiated', render: op('Tu pago SISMO911 está en camino — $50,00', 'RECIBO', 'Finanzas · Pago', 'Tu pago está en camino.', ['Hola:', 'Iniciamos el pago hacia tu cuenta.'], [{ label: 'Monto', value: '$50,00' }]) },
  { id: 'FIN-05', dept: 'Finance & Donations', name: 'Payout completed', render: op('Pago completado — $50,00', 'RECIBO', 'Finanzas · Pago', 'Pago completado.', ['Hola:', 'Tu pago se completó.'], [{ label: 'Monto', value: '$50,00' }]) },
  { id: 'FIN-06', dept: 'Finance & Donations', name: 'Refund confirmation', render: op('Tu reembolso de SISMO911 — $50,00', 'RECIBO', 'Finanzas · Reembolso', 'Reembolso emitido.', ['Hola:', 'Emitimos tu reembolso.'], [{ label: 'Monto', value: '$50,00' }]) },
  { id: 'FIN-07', dept: 'Finance & Donations', name: 'Invoice / billing', render: op('Factura SISMO911 INV-301 — vence 15/07/2026', 'RECIBO', 'Finanzas · Factura', 'Factura emitida.', ['Hola:', 'Se emitió una factura a tu nombre.'], [{ label: 'Factura', value: 'INV-301' }, { label: 'Vence', value: '15/07/2026' }]) },
  { id: 'FIN-08', dept: 'Finance & Donations', name: 'Grant disbursement confirmation', render: op('Desembolso de subvención confirmado — GR-12', 'RECIBO', 'Finanzas · Subvención', 'Desembolso confirmado.', ['Hola:', 'Se confirmó el desembolso de una subvención.'], [{ label: 'Referencia', value: 'GR-12' }]) },
  { id: 'FIN-09', dept: 'Finance & Donations', name: 'Payment failed / retry', render: () => paymentFailedEmail({ amount: '$50,00', when: '28/06/2026', payUrl: 'https://sismo911.com/cuenta/pago', sample: true }) },

  // ---- Volunteer Mgmt (VOL) ----
  { id: 'VOL-01', dept: 'Volunteer Mgmt', name: 'Application received', render: () => volunteerApplicationEmail({ name: 'Ricardo', ref: 'VOL-3321', sample: true }) },
  { id: 'VOL-02', dept: 'Volunteer Mgmt', name: 'Volunteer approved', render: op('Estás aprobado para desplegarte con SISMO911', 'VOLUNTARIO', 'Voluntariado · Aprobación', 'Estás aprobado.', ['Hola:', 'Fuiste aprobado para desplegarte con SISMO911. Te contactaremos con los próximos pasos.']) },
  { id: 'VOL-03', dept: 'Volunteer Mgmt', name: 'Application decision', render: op('Actualización sobre tu solicitud de voluntariado SISMO911', 'VOLUNTARIO', 'Voluntariado · Solicitud', 'Actualización de tu solicitud.', ['Hola:', 'Tenemos una actualización sobre tu solicitud de voluntariado.']) },
  { id: 'VOL-04', dept: 'Volunteer Mgmt', name: 'Shift assignment', render: op('[SISMO911] Tu turno — Refugio Maiquetía · 08:00', 'VOLUNTARIO', 'Voluntariado · Turno', 'Tu turno fue asignado.', ['Hola:', 'Se te asignó un turno.'], [{ label: 'Sitio', value: 'Refugio Maiquetía' }, { label: 'Hora', value: '08:00' }]) },
  { id: 'VOL-05', dept: 'Volunteer Mgmt', name: 'Shift reminder', render: op('[SISMO911] Recordatorio — turno mañana', 'VOLUNTARIO', 'Voluntariado · Recordatorio', 'Recordatorio de turno.', ['Hola:', 'Te recordamos tu turno de mañana.']) },
  { id: 'VOL-06', dept: 'Volunteer Mgmt', name: 'Thank-you / debrief', render: op('Gracias por servir con SISMO911', 'VOLUNTARIO', 'Voluntariado · Cierre', 'Gracias por servir.', ['Hola:', 'Gracias por tu despliegue con SISMO911.']) },

  // ---- Missing Persons (MP) ----
  { id: 'MP-01', dept: 'Missing Persons', name: 'Case registered', render: () => caseRegisteredEmail({ caseRef: 'CASO-10482', when: '28/06/2026', caseUrl: 'https://sismo911.com/familia', sample: true }) },
  { id: 'MP-02', dept: 'Missing Persons', name: 'Possible match — review', render: op('[SISMO911] Posible coincidencia — caso CASO-10482', 'CASO', 'Familia · Coincidencia', 'Posible coincidencia.', ['Se detectó una posible coincidencia para un caso. Revisa en el panel de operador.'], [{ label: 'Caso', value: 'CASO-10482' }]) },
  { id: 'MP-03', dept: 'Missing Persons', name: 'Reunification confirmed', render: op('Buenas noticias sobre tu caso SISMO911 CASO-10482', 'CASO', 'Familia · Reunificación', 'Buenas noticias.', ['Hola:', 'Tenemos buenas noticias sobre tu caso.'], [{ label: 'Caso', value: 'CASO-10482' }]) },
  { id: 'MP-04', dept: 'Missing Persons', name: 'Tip received (ack)', render: () => tipReceivedEmail({ sample: true }) },
  { id: 'MP-05', dept: 'Missing Persons', name: 'Case status update', render: op('[SISMO911] Actualización del caso CASO-10482', 'CASO', 'Familia · Caso', 'Actualización del caso.', ['Hola:', 'Hay una actualización en tu caso.'], [{ label: 'Caso', value: 'CASO-10482' }]) },

  // ---- Public Affairs (PA) ----
  { id: 'PA-01', dept: 'Public Affairs', name: 'Alert dispatch confirmation', render: op('[SISMO911] Alerta pública enviada — La Guaira', 'PRENSA', 'Asuntos Públicos · Alerta', 'Alerta pública enviada.', ['Se envió una alerta pública al área indicada.'], [{ label: 'Área', value: 'La Guaira' }]) },
  { id: 'PA-02', dept: 'Public Affairs', name: 'Press published', render: op('[SISMO911] Comunicado de prensa publicado', 'PRENSA', 'Asuntos Públicos · Prensa', 'Comunicado publicado.', ['Se publicó un comunicado de prensa.']) },
  { id: 'PA-03', dept: 'Public Affairs', name: 'Public emergency alert', render: op('[SISMO911] Alerta de emergencia — La Guaira', 'PRENSA', 'Asuntos Públicos · Emergencia', 'Alerta de emergencia.', ['Alerta de emergencia para suscriptores del área.'], [{ label: 'Área', value: 'La Guaira' }]) },
  { id: 'PA-04', dept: 'Public Affairs', name: 'Rumor flagged', render: op('[SISMO911] Desinformación detectada — revisar', 'PRENSA', 'Asuntos Públicos · Rumores', 'Desinformación detectada.', ['Se marcó una posible desinformación para revisión.']) },

  // ---- Security & Cyber (SEC) ----
  { id: 'SEC-01', dept: 'Security & Cyber', name: 'Security alert', render: op('[SISMO911] Alerta de seguridad en tu cuenta', 'SEGURIDAD', 'Seguridad · Cuenta', 'Alerta de seguridad.', ['Hola:', 'Detectamos actividad sospechosa en tu cuenta.']) },
  { id: 'SEC-02', dept: 'Security & Cyber', name: 'Rotation notice', render: op('[SISMO911] Credencial rotada — Stripe', 'SEGURIDAD', 'Seguridad · Secretos', 'Credencial rotada.', ['Se rotó una credencial de servicio.'], [{ label: 'Servicio', value: 'Stripe' }]) },
  { id: 'SEC-03', dept: 'Security & Cyber', name: 'SOC incident page', render: op('[SISMO911-SOC] Incidente ALTO — API', 'SEGURIDAD', 'Seguridad · SOC', 'Incidente de seguridad.', ['Se detectó un incidente de seguridad.'], [{ label: 'Severidad', value: 'ALTO' }, { label: 'Sistema', value: 'API' }]) },
  { id: 'SEC-04', dept: 'Security & Cyber', name: 'Breach notification', render: op('[SISMO911] Aviso importante de seguridad', 'SEGURIDAD', 'Seguridad · Aviso', 'Aviso importante de seguridad.', ['Hola:', 'Te escribimos para informarte sobre un asunto de seguridad que afecta tu cuenta.']) },

  // ---- Aviation & Maritime (AVM) ----
  { id: 'AVM-01', dept: 'Aviation & Maritime', name: 'Flight tasking order', render: op('[SISMO911-AIR] Asignación — Misión Recon-1', 'AÉREO', 'Aéreo · Asignación', 'Asignación de vuelo.', ['Se asignó una misión de vuelo.'], [{ label: 'Misión', value: 'Recon-1' }]) },
  { id: 'AVM-02', dept: 'Aviation & Maritime', name: 'Drone sortie order', render: op('[SISMO911-AIR] Vuelo de dron — Maiquetía', 'AÉREO', 'Aéreo · Dron', 'Vuelo de dron asignado.', ['Se asignó una salida de dron.'], [{ label: 'Área', value: 'Maiquetía' }]) },
  { id: 'AVM-03', dept: 'Aviation & Maritime', name: 'Airspace notice', render: op('[SISMO911-AIR] Aviso de espacio aéreo — Zona 4', 'AÉREO', 'Aéreo · Espacio aéreo', 'Aviso de espacio aéreo.', ['Aviso de deconflicción para activos aéreos.'], [{ label: 'Zona', value: 'Zona 4' }]) },
  { id: 'AVM-04', dept: 'Aviation & Maritime', name: 'Maritime rescue order', render: op('[SISMO911-SEA] Asignación de rescate — Sector Norte', 'MARÍTIMO', 'Marítimo · Rescate', 'Asignación de rescate.', ['Se asignó una misión de rescate marítimo.'], [{ label: 'Sector', value: 'Sector Norte' }]) },

  // ---- Shelter & Recovery (SHL) ----
  { id: 'SHL-01', dept: 'Shelter & Recovery', name: 'Shelter online', render: op('[SISMO911] Refugio en operación — Maiquetía', 'REFUGIO', 'Refugio · Operación', 'Refugio en operación.', ['Un refugio entró en operación.'], [{ label: 'Refugio', value: 'Maiquetía' }]) },
  { id: 'SHL-02', dept: 'Shelter & Recovery', name: 'Shelter capacity alert', render: op('[SISMO911] Capacidad de refugio crítica — Maiquetía', 'REFUGIO', 'Refugio · Capacidad', 'Capacidad crítica.', ['Un refugio alcanzó capacidad crítica.'], [{ label: 'Refugio', value: 'Maiquetía' }]) },
  { id: 'SHL-03', dept: 'Shelter & Recovery', name: 'Intake confirmation', render: op('[SISMO911] Ingreso registrado — REF-9001', 'REFUGIO', 'Refugio · Ingreso', 'Ingreso registrado.', ['Se registró un ingreso en el refugio.'], [{ label: 'Referencia', value: 'REF-9001' }]) },
  { id: 'SHL-04', dept: 'Shelter & Recovery', name: 'Reconstruction task', render: op('[SISMO911] Tarea de reconstrucción — REF-9001', 'REFUGIO', 'Refugio · Reconstrucción', 'Tarea de reconstrucción.', ['Se asignó una tarea de reconstrucción.'], [{ label: 'Referencia', value: 'REF-9001' }]) },

  // ---- Compliance & Privacy (CMP) ----
  { id: 'CMP-01', dept: 'Compliance & Privacy', name: 'Consent confirmation', render: op('Tus preferencias de consentimiento SISMO911', 'PRIVACIDAD', 'Privacidad · Consentimiento', 'Preferencias guardadas.', ['Hola:', 'Guardamos tus preferencias de consentimiento.']) },
  { id: 'CMP-02', dept: 'Compliance & Privacy', name: 'Data export ready', render: op('Tu exportación de datos SISMO911 está lista', 'PRIVACIDAD', 'Privacidad · Exportación', 'Tu exportación está lista.', ['Hola:', 'Tu exportación de datos personales está lista. Descárgala de forma segura (requiere iniciar sesión).']) },
  { id: 'CMP-03', dept: 'Compliance & Privacy', name: 'Deletion confirmation', render: op('La eliminación de tus datos SISMO911 está completa', 'PRIVACIDAD', 'Privacidad · Eliminación', 'Eliminación completa.', ['Hola:', 'La eliminación de tus datos personales fue completada.']) },
  { id: 'CMP-04', dept: 'Compliance & Privacy', name: 'Policy update notice', render: op('Actualizaciones de los términos / privacidad de SISMO911', 'PRIVACIDAD', 'Privacidad · Políticas', 'Actualización de políticas.', ['Hola:', 'Actualizamos nuestros términos y política de privacidad.']) },

  // ---- Intelligence & Hazard (INT) ----
  { id: 'INT-01', dept: 'Intelligence & Hazard', name: 'Hazard threshold alert', render: op('[SISMO911-INT] Alerta de amenaza — Sismo La Guaira', 'INTELIGENCIA', 'Inteligencia · Amenaza', 'Alerta de amenaza.', ['Se cruzó un umbral de amenaza.'], [{ label: 'Amenaza', value: 'Sismo' }, { label: 'Región', value: 'La Guaira' }]) },
  { id: 'INT-02', dept: 'Intelligence & Hazard', name: 'Damage assessment ready', render: op('[SISMO911-INT] Evaluación de daños — M6.2 La Guaira', 'INTELIGENCIA', 'Inteligencia · Daños', 'Evaluación de daños lista.', ['La evaluación de daños está disponible.'], [{ label: 'Incidente', value: 'M6.2 La Guaira' }]) },
  { id: 'INT-03', dept: 'Intelligence & Hazard', name: 'Hazard briefing digest', render: op('[SISMO911-INT] Boletín diario de amenazas', 'INTELIGENCIA', 'Inteligencia · Boletín', 'Boletín diario.', ['Resumen diario de amenazas.']) },

  // ---- System & DevOps (SYS) ----
  { id: 'SYS-01', dept: 'System & DevOps', name: 'Deploy notification', render: op('[SISMO911-SYS] Despliegue OK — v2.31', 'SISTEMA', 'Sistema · Despliegue', 'Despliegue completado.', ['Un despliegue finalizó.'], [{ label: 'Versión', value: 'v2.31' }]) },
  { id: 'SYS-02', dept: 'System & DevOps', name: 'Job failure alert', render: op('[SISMO911-SYS] Trabajo fallido — usgs-poll', 'SISTEMA', 'Sistema · Trabajos', 'Trabajo fallido.', ['Un trabajo programado falló.'], [{ label: 'Trabajo', value: 'usgs-poll' }]) },
  { id: 'SYS-03', dept: 'System & DevOps', name: 'Quota warning', render: op('[SISMO911-SYS] Aviso de cuota — D1 lecturas', 'SISTEMA', 'Sistema · Cuotas', 'Aviso de cuota.', ['Un recurso se acerca a su límite.'], [{ label: 'Recurso', value: 'D1 lecturas' }]) },
  { id: 'SYS-04', dept: 'System & DevOps', name: 'Uptime/health alert', render: op('[SISMO911-SYS] Salud degradada — API', 'SISTEMA', 'Sistema · Salud', 'Salud degradada.', ['Un servicio reporta salud degradada.'], [{ label: 'Servicio', value: 'API' }]) },
];

// Lookup by sheet ID (case-insensitive).
export function sampleById(id: string): SampleMeta | undefined {
  const want = id.trim().toUpperCase();
  return CATALOG.find((s) => s.id === want);
}
