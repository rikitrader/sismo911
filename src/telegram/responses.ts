// SISMO911 — Telegram bot: deterministic response builder.
// ---------------------------------------------------------------------------
// The ONLY place that turns a (already-resolved) QueryResult into chat text.
// 100% deterministic: given the same QueryResult + viewer it always produces the
// same string. No LLM, no inference. Factual fields come straight from the DB
// record via redaction.toPublicView. Defaults to Spanish; English on request.

import type { PublicStatus, QueryResult, ViewerRole } from './types';
import { toPublicView } from './redaction';

export interface BuildOpts {
  lang: 'es' | 'en';
  role: ViewerRole;
  canSeeSensitive: boolean;
}

function fmtDate(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  // YYYY-MM-DD HH:mm (UTC) — stable, locale-independent.
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

// Recommended next action per public status (kept short + non-committal).
const NEXT_ACTION: Record<PublicStatus, { es: string; en: string }> = {
  ALIVE: { es: 'Para detalles, contacte a un operador autorizado.', en: 'For details, contact an authorized operator.' },
  DEATH: { es: 'Información sensible: contacte a un operador autorizado.', en: 'Sensitive information: contact an authorized operator.' },
  MISSING: { es: 'Si tiene información, repórtela a un operador o por los canales oficiales.', en: 'If you have information, report it to an operator or official channels.' },
  HOSPITALIZED: { es: 'Para detalles del centro, contacte a un operador autorizado.', en: 'For facility details, contact an authorized operator.' },
  LOCATED: { es: 'Caso localizado. Para más datos, contacte a un operador.', en: 'Case located. For more, contact an operator.' },
  SHELTERED: { es: 'En refugio. Para detalles, contacte a un operador.', en: 'In a shelter. For details, contact an operator.' },
  EVACUATED: { es: 'Evacuado/a. Para detalles, contacte a un operador.', en: 'Evacuated. For details, contact an operator.' },
  UNKNOWN: { es: 'Estado no confirmado. Contacte a un operador para seguimiento.', en: 'Status not confirmed. Contact an operator for follow-up.' },
  PENDING_VERIFICATION: { es: 'Registro aún sin verificar. No representa un estado final.', en: 'Record not yet verified. Not a final status.' },
};

const HELP_ES = [
  'SISMO911 — consultas de casos (solo datos verificados):',
  '/buscar cedula V12345678',
  '/buscar nombre "Maria Perez" nacimiento 1980-05-12',
  '/caso EXP-2026-0123',
  '/status EXP-2026-0123',
  '/hospitalizados nombre "Jose Garcia"',
  '/missing nombre "Ana Rodriguez"',
  '/ayuda',
  '',
  'El bot solo responde en grupos aprobados y nunca expone datos personales sensibles.',
].join('\n');

const HELP_EN = [
  'SISMO911 — case lookups (verified data only):',
  '/search id V12345678',
  '/search name "Maria Perez" dob 1980-05-12',
  '/case EXP-2026-0123',
  '/status EXP-2026-0123',
  '/hospitalized name "Jose Garcia"',
  '/missing name "Ana Rodriguez"',
  '/help',
  '',
  'The bot only replies in approved groups and never exposes sensitive personal data.',
].join('\n');

/** Build the final chat text for a resolved query. Pure + total over QueryResult. */
export function buildTelegramResponse(result: QueryResult, opts: BuildOpts): string {
  const es = opts.lang === 'es';
  switch (result.kind) {
    case 'help':
      return es ? HELP_ES : HELP_EN;

    case 'unauthorized':
      return es
        ? 'No autorizado. Este bot solo responde en grupos aprobados de SISMO911.'
        : 'Not authorized. This bot only replies in approved SISMO911 groups.';

    case 'rate_limited': {
      const n = result.retryAfterSec ?? 30;
      return es
        ? `Has hecho demasiadas consultas. Espera ${n}s e inténtalo de nuevo.`
        : `Too many requests. Wait ${n}s and try again.`;
    }

    case 'bad_input':
      return es
        ? 'No entendí la consulta. Escribe /ayuda para ver los formatos válidos.'
        : 'I could not parse that. Send /help for valid formats.';

    case 'need_more':
      if (result.reason === 'phone_requires_admin') {
        return es
          ? 'La búsqueda por teléfono es información sensible y solo está disponible para operadores autorizados.'
          : 'Phone lookups are sensitive and only available to authorized operators.';
      }
      return es
        ? 'El nombre es muy general. Envía el nombre completo más un dato (fecha de nacimiento, ciudad o ID de caso).'
        : 'That name is too general. Send the full name plus one more detail (date of birth, city, or case ID).';

    case 'no_match':
      return es
        ? 'No se encontró un registro verificado con esos datos. Agrega más información o contacta a un operador.'
        : 'No verified record found. Add more information or contact an operator.';

    case 'multiple':
      return es
        ? 'Se encontraron varios posibles registros. Para proteger la privacidad, envía más datos: fecha de nacimiento, ciudad o ID de caso.'
        : 'Several possible records were found. To protect privacy, send more data: date of birth, city, or case ID.';

    case 'error':
      return es
        ? 'No pude completar la consulta de forma segura. Inténtalo de nuevo o contacta a un operador.'
        : 'I could not complete the query safely. Try again or contact an operator.';

    case 'match': {
      const view = toPublicView(result.record, opts.role, opts.canSeeSensitive);
      // Unverified record → never assert a final status.
      if (view.status === 'PENDING_VERIFICATION') {
        return es
          ? `Existe un registro pendiente, pero aún no está verificado.\nCaso: ${view.caseId}\nEstado público: PENDING_VERIFICATION.`
          : `A record exists but is not yet verified.\nCase: ${view.caseId}\nPublic status: PENDING_VERIFICATION.`;
      }
      const next = NEXT_ACTION[view.status][opts.lang];
      const lines = es
        ? [
            'Registro verificado:',
            `Caso: ${view.caseId}`,
            `Estado: ${view.status}`,
            `Ubicación general: ${view.generalLocation ?? 'no disponible'}`,
            `Última verificación: ${fmtDate(view.lastVerifiedMs)}`,
            `Nivel: ${view.verification}`,
            `Nota: ${next}`,
          ]
        : [
            'Verified record:',
            `Case: ${view.caseId}`,
            `Status: ${view.status}`,
            `General location: ${view.generalLocation ?? 'not available'}`,
            `Last verified: ${fmtDate(view.lastVerifiedMs)}`,
            `Level: ${view.verification}`,
            `Note: ${next}`,
          ];
      if (view.privileged) {
        const p = view.privileged;
        lines.push('');
        lines.push(es ? '— Detalle restringido (operador) —' : '— Restricted detail (operator) —');
        lines.push((es ? 'Nombre: ' : 'Name: ') + p.fullName);
        if (p.cedula) lines.push((es ? 'Cédula: ' : 'ID: ') + p.cedula);
        if (p.phone) lines.push((es ? 'Teléfono: ' : 'Phone: ') + p.phone);
        if (p.hospital) lines.push((es ? 'Centro: ' : 'Facility: ') + p.hospital);
        if (p.address) lines.push((es ? 'Dirección: ' : 'Address: ') + p.address);
        if (p.medicalNotes) lines.push((es ? 'Notas: ' : 'Notes: ') + p.medicalNotes);
        if (p.familyContact) lines.push((es ? 'Contacto familiar: ' : 'Family contact: ') + p.familyContact);
      }
      return lines.join('\n');
    }
  }
}
