// SISMO911 — Telegram bot: deterministic response builder.
// ---------------------------------------------------------------------------
// The ONLY place that turns a (already-resolved) QueryResult into chat text.
// 100% deterministic: given the same QueryResult + viewer it always produces the
// same string. No LLM, no inference. Factual fields come straight from the DB
// record via redaction.toPublicView. Defaults to Spanish; English on request.

import type { CaseRecord, PublicStatus, QueryResult, ViewerRole } from './types';
import type { UpdateResult } from './update';
import type { MuroPost, MuroPostResult } from './muro';
import { toPublicView } from './redaction';

export interface BuildOpts {
  lang: 'es' | 'en';
  role: ViewerRole;
  canSeeSensitive: boolean;
  baseUrl?: string;
}

function fmtDate(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  // YYYY-MM-DD HH:mm (UTC) — stable, locale-independent.
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

/** Escape DB-derived text for Telegram parse_mode:'HTML' (& < > only). */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Humanized status label + icon per public status — the "card" vocabulary the
// web UI uses (e.g. HOSPITALIZED → "En un hospital"), never the raw enum.
const STATUS_LABEL: Record<PublicStatus, { icon: string; es: string; en: string }> = {
  ALIVE: { icon: '🟢', es: 'Con vida', en: 'Alive' },
  DEATH: { icon: '⚫', es: 'Fallecido(a)', en: 'Deceased' },
  MISSING: { icon: '🔴', es: 'Desaparecido(a)', en: 'Missing' },
  HOSPITALIZED: { icon: '🏥', es: 'En un hospital', en: 'In a hospital' },
  LOCATED: { icon: '🟢', es: 'Localizado(a)', en: 'Located' },
  SHELTERED: { icon: '⛺', es: 'En un refugio', en: 'In a shelter' },
  EVACUATED: { icon: '🟠', es: 'Evacuado(a)', en: 'Evacuated' },
  UNKNOWN: { icon: '⚪', es: 'Sin confirmar', en: 'Unconfirmed' },
  PENDING_VERIFICATION: { icon: '⏳', es: 'Pendiente de verificación', en: 'Pending verification' },
};

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
  '👋 ¡Hola! Soy el bot de SISMO911. Consulto el estado de casos con datos verificados.',
  '',
  'Comandos disponibles:',
  '• /buscar nombre "Moisés Carpio" — buscar por nombre (sin/with acentos, mayús o minús)',
  '• /buscar cedula V12345678 — buscar por cédula',
  '• /buscar nombre "Maria Perez" nacimiento 1980-05-12 — nombre + fecha de nacimiento',
  '• /caso EXP-2026-0123 — ver un caso por su ID',
  '• /status EXP-2026-0123 — estado de un caso',
  '• /hospitalizados nombre "Jose Garcia" — buscar en el registro de hospitales',
  '• /missing nombre "Ana Rodriguez" — buscar personas desaparecidas',
  '• /muro Vi a Maria Perez en el refugio de Catia — publicar un mensaje en el Muro de Emergencia (sismo911.com/muro)',
  '• /muro — ver los últimos mensajes del Muro',
  '• /ayuda — mostrar esta ayuda',
  '',
  '📎 CÓMO REPORTAR CON UNA FOTO O UN PDF (crear o actualizar un caso):',
  'No necesitas ningún comando: solo envíame el archivo y yo hago el resto.',
  '',
  'Paso a paso:',
  '1) Toca el clip 📎 (adjuntar) en Telegram.',
  '2) Elige una FOTO (galería o cámara) o un ARCHIVO PDF. Sirve una cédula, un volante de desaparecido o un reporte/constancia.',
  '3) En el mismo mensaje escribe todo lo que sepas: nombre completo, cédula, edad, última ubicación, fecha de desaparición y un teléfono de contacto.',
  '4) Envíalo. Leo el archivo automáticamente y te respondo con un código de seguimiento (ITK-XXXXXX). Guárdalo.',
  '',
  'Qué pasa después:',
  '• Si los datos coinciden con un caso existente, adjunto tu envío a ese caso.',
  '• Si no hay coincidencia, creo un caso nuevo en borrador.',
  '• Un operador de SISMO911 revisa y verifica cada envío antes de publicarlo. Nada se publica automáticamente.',
  '',
  'Consejos para que salga bien:',
  '• Una persona por envío. Foto nítida, de frente y bien iluminada.',
  '• Si el PDF tiene varias páginas, mándalo como ARCHIVO (no como foto) para no perder texto.',
  '• Tamaño máximo 20 MB. Formatos: JPG, PNG o PDF.',
  '• Si no logro leer un nombre o una cédula, te pediré que los escribas por texto.',
  '',
  'Solo respondo con registros verificados. En grupos oculto los datos sensibles; para el detalle completo, escríbeme en privado (solo operadores autorizados).',
].join('\n');

const HELP_EN = [
  "👋 Hi! I'm the SISMO911 bot. I look up case status using verified data only.",
  '',
  'Available commands:',
  '• /search name "Moises Carpio" — search by name (accents/case-insensitive)',
  '• /search id V12345678 — search by national ID',
  '• /search name "Maria Perez" dob 1980-05-12 — name + date of birth',
  '• /case EXP-2026-0123 — view a case by its ID',
  '• /status EXP-2026-0123 — case status',
  '• /hospitalized name "Jose Garcia" — search the hospital registry',
  '• /missing name "Ana Rodriguez" — search missing persons',
  '• /muro I saw Maria Perez at the Catia shelter — post to the public Emergency Wall (sismo911.com/muro)',
  '• /muro — show the latest Wall posts',
  '• /help — show this help',
  '',
  '📎 HOW TO REPORT WITH A PHOTO OR PDF (create or update a case):',
  'No command needed — just send me the file and I do the rest.',
  '',
  'Step by step:',
  '1) Tap the clip 📎 (attach) in Telegram.',
  '2) Choose a PHOTO (gallery or camera) or a PDF FILE. An ID card, a missing-person flyer, or a report all work.',
  '3) In the same message, type everything you know: full name, ID number, age, last-known location, date last seen, and a contact phone.',
  '4) Send it. I read the file automatically and reply with a tracking code (ITK-XXXXXX). Keep it.',
  '',
  'What happens next:',
  '• If the details match an existing case, I attach your submission to it.',
  '• If there is no match, I create a new draft case.',
  '• A SISMO911 operator reviews and verifies every submission before it is published. Nothing is published automatically.',
  '',
  'Tips for best results:',
  '• One person per submission. Clear, front-facing, well-lit photo.',
  '• If the PDF has several pages, send it as a FILE (not as a photo) so no text is lost.',
  '• Max size 20 MB. Formats: JPG, PNG, or PDF.',
  "• If I can't read a name or an ID number, I'll ask you to type them.",
  '',
  'I only reply with verified records. In groups sensitive data is hidden; for full detail, DM me (authorized operators only).',
].join('\n');

// Operator-only write command help (appended to /ayuda for operators/admins).
const OPERATOR_HELP_ES = [
  '🛠️ Operadores — actualizar un caso desde el chat:',
  '• /actualizar <ID> estado localizado — cambiar el estado (sin-contacto, localizado, aparecido, hospitalizado, fallecido)',
  '• /actualizar <ID> nota "Visto en el refugio de Catia" — agregar una nota verificada al caso',
  '• /actualizar <ID> ubicacion "Caracas, Distrito Capital" — actualizar la ubicación',
  '• /actualizar <ID> contacto 0412-5551234 — actualizar el contacto',
  '• /actualizar <ID> edad 34 — actualizar la edad',
  '• /actualizar <ID> nombre "Juan Pérez Gómez" — corregir el nombre',
  '• /actualizar <ID> aprobar  /  rechazar — publicar u ocultar un caso (solo nivel ejecutivo/admin)',
  '• /aprobar ITK-XXXX  /  /rechazar ITK-XXXX — aprobar u ocultar un envío del bot por su código de recibo (admin)',
  'Un campo por comando. Solo casos del registro de SISMO911 (no hospitales/oficiales).',
].join('\n');
const OPERATOR_HELP_EN = [
  '🛠️ Operators — update a case from chat:',
  '• /actualizar <ID> estado localizado — change status (sin-contacto, localizado, aparecido, hospitalizado, fallecido)',
  '• /actualizar <ID> nota "Seen at the Catia shelter" — add a verified note to the case',
  '• /actualizar <ID> ubicacion "Caracas, Distrito Capital" — update location',
  '• /actualizar <ID> contacto 0412-5551234 — update contact',
  '• /actualizar <ID> edad 34 — update age',
  '• /actualizar <ID> nombre "Juan Pérez Gómez" — fix the name',
  '• /actualizar <ID> aprobar  /  rechazar — publish or hide a case (executive/admin only)',
  '• /aprobar ITK-XXXX  /  /rechazar ITK-XXXX — approve or hide a bot submission by its receipt code (admin)',
  'One field per command. Only SISMO911-registry cases (not hospital/official).',
].join('\n');

/**
 * Formal "card" per list item, mirroring the web search UI (parse_mode:'HTML'):
 *
 *   🏥 MUSONI YOLANDA                                  ← bold name
 *   En un hospital — Hospital Dr. José María Vargas (La Guaira)
 *   HOSP-123 · Verificado 2026-07-01 · Ver ficha       ← linked profile
 *
 * Humanized status (never the raw enum); facility only when it is public-tier
 * (hospital registry — see PublicView.facility). Unverified rows never assert
 * a final status. No sensitive PII (public-tier). All DB text HTML-escaped.
 */
function caseBlock(record: CaseRecord, opts: BuildOpts): string {
  const es = opts.lang === 'es';
  const v = toPublicView(record, opts.role, false, opts.baseUrl);
  const label = STATUS_LABEL[v.status];

  // "Hospital Dr. José María Vargas (La Guaira)" | "La Guaira" | fallback.
  const where = v.facility
    ? v.facility + (v.generalLocation ? ` (${v.generalLocation})` : '')
    : v.generalLocation;
  const statusLine =
    `${es ? label.es : label.en}` +
    (where ? ` — ${escapeHtml(where)}` : es ? ' — ubicación no disponible' : ' — location not available');

  const link = `<a href="${v.profileUrl}">${es ? 'Ver ficha' : 'View profile'}</a>`;
  const verified =
    v.status === 'PENDING_VERIFICATION' || v.verification !== 'VERIFIED'
      ? es ? 'Sin verificar' : 'Unverified'
      : `${es ? 'Verificado' : 'Verified'} ${fmtDate(v.lastVerifiedMs).slice(0, 10)}`;
  const metaLine = `${escapeHtml(v.caseId)} · ${verified} · ${link}`;

  return `${label.icon} <b>${escapeHtml(v.name)}</b>\n${statusLine}\n${metaLine}`;
}

const LIST_PAGE_MAX = 3500; // per-message char budget (Telegram cap is 4096)

/**
 * Render a match-list as one or MORE Telegram messages. Each message is
 * self-contained: its own header (`🔎 «query» — N registros (parte i/total)`)
 * followed by unnumbered cards separated by a blank line, mirroring the web
 * search results UI.
 */
export function buildListMessages(
  records: Parameters<typeof caseBlock>[0][],
  opts: BuildOpts,
  query?: string,
): string[] {
  const es = opts.lang === 'es';
  const blocks = records.map((r) => caseBlock(r, opts));
  // Paginate blocks by char budget (keep whole blocks together).
  const pages: string[][] = [];
  let cur: string[] = [];
  let curLen = 0;
  for (const b of blocks) {
    const add = b.length + 6; // numbering prefix + separators
    if (cur.length && curLen + add > LIST_PAGE_MAX) {
      pages.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(b);
    curLen += add;
  }
  if (cur.length) pages.push(cur);
  if (!pages.length) pages.push([]);

  const total = pages.length;
  const q = query ? `«${query}» — ` : '';
  const noun = (n: number) => (es ? `registro${n === 1 ? '' : 's'}` : `record${n === 1 ? '' : 's'}`);
  return pages.map((pageBlocks, pi) => {
    const part = total > 1 ? (es ? ` (parte ${pi + 1}/${total})` : ` (part ${pi + 1}/${total})`) : '';
    const header = `🔎 ${escapeHtml(q)}${records.length} ${noun(records.length)}${part}:`;
    return [header, '', pageBlocks.join('\n\n')].join('\n');
  });
}

/** Build the final chat text for a resolved query. Pure + total over QueryResult. */
export function buildTelegramResponse(result: QueryResult, opts: BuildOpts): string {
  const es = opts.lang === 'es';
  switch (result.kind) {
    case 'help': {
      const base = es ? HELP_ES : HELP_EN;
      // Operators additionally see the write command (/actualizar). Public users don't.
      if (opts.role !== 'public') return base + '\n\n' + (es ? OPERATOR_HELP_ES : OPERATOR_HELP_EN);
      return base;
    }

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

    case 'list':
      // Rendered as one-or-more messages by buildListMessages (each self-numbered
      // + its own header). Joined here only for non-route callers.
      return buildListMessages(result.records, opts, result.query).join('\n\n');

    case 'error':
      return es
        ? 'No pude completar la consulta de forma segura. Inténtalo de nuevo o contacta a un operador.'
        : 'I could not complete the query safely. Try again or contact an operator.';

    case 'match': {
      const view = toPublicView(result.record, opts.role, opts.canSeeSensitive, opts.baseUrl);
      const mode = result.detail ?? 'summary';
      const label = STATUS_LABEL[view.status];
      const statusTxt = `${label.icon} ${es ? label.es : label.en}`;

      // /status → short status line (no detail body).
      if (mode === 'status') {
        return es
          ? `Caso: ${escapeHtml(view.caseId)}\nEstado: ${statusTxt}\nNivel: ${view.verification}\nFicha: ${view.profileUrl}`
          : `Case: ${escapeHtml(view.caseId)}\nStatus: ${statusTxt}\nLevel: ${view.verification}\nProfile: ${view.profileUrl}`;
      }

      // Unverified record → never assert a final status (but still link the case).
      if (view.status === 'PENDING_VERIFICATION') {
        const nameLine = mode === 'full' ? (es ? `\nNombre: ${escapeHtml(view.name)}` : `\nName: ${escapeHtml(view.name)}`) : '';
        return es
          ? `Existe un registro pendiente, pero aún no está verificado.\nCaso: ${escapeHtml(view.caseId)}${nameLine}\nEstado público: ${statusTxt}.\nFicha: ${view.profileUrl}`
          : `A record exists but is not yet verified.\nCase: ${escapeHtml(view.caseId)}${nameLine}\nPublic status: ${statusTxt}.\nProfile: ${view.profileUrl}`;
      }
      const next = NEXT_ACTION[view.status][opts.lang];
      const full = mode === 'full';
      const lines = es
        ? [
            full ? 'Detalle del caso:' : 'Registro verificado:',
            `Caso: ${escapeHtml(view.caseId)}`,
            ...(full ? [`Nombre: <b>${escapeHtml(view.name)}</b>`] : []),
            ...(full && view.age != null ? [`Edad: ${view.age}`] : []),
            `Estado: ${statusTxt}`,
            `Ubicación general: ${escapeHtml(view.generalLocation ?? 'no disponible')}`,
            `Última verificación: ${fmtDate(view.lastVerifiedMs)}`,
            `Nivel: ${view.verification}`,
            `Ficha: ${view.profileUrl}`,
            `Nota: ${next}`,
          ]
        : [
            full ? 'Case detail:' : 'Verified record:',
            `Case: ${escapeHtml(view.caseId)}`,
            ...(full ? [`Name: <b>${escapeHtml(view.name)}</b>`] : []),
            ...(full && view.age != null ? [`Age: ${view.age}`] : []),
            `Status: ${statusTxt}`,
            `General location: ${escapeHtml(view.generalLocation ?? 'not available')}`,
            `Last verified: ${fmtDate(view.lastVerifiedMs)}`,
            `Level: ${view.verification}`,
            `Profile: ${view.profileUrl}`,
            `Note: ${next}`,
          ];
      if (view.privileged) {
        const p = view.privileged;
        lines.push('');
        lines.push(es ? '— Detalle restringido (operador) —' : '— Restricted detail (operator) —');
        lines.push((es ? 'Nombre: ' : 'Name: ') + escapeHtml(p.fullName));
        if (p.cedula) lines.push((es ? 'Cédula: ' : 'ID: ') + escapeHtml(p.cedula));
        if (p.phone) lines.push((es ? 'Teléfono: ' : 'Phone: ') + escapeHtml(p.phone));
        if (p.hospital) lines.push((es ? 'Centro: ' : 'Facility: ') + escapeHtml(p.hospital));
        if (p.address) lines.push((es ? 'Dirección: ' : 'Address: ') + escapeHtml(p.address));
        if (p.medicalNotes) lines.push((es ? 'Notas: ' : 'Notes: ') + escapeHtml(p.medicalNotes));
        if (p.familyContact) lines.push((es ? 'Contacto familiar: ' : 'Family contact: ') + escapeHtml(p.familyContact));
      }
      return lines.join('\n');
    }
  }
}

const BAD_INPUT_ES: Record<string, string> = {
  missing_id: 'Falta el ID del caso. Uso: /actualizar <ID> <campo> <valor>',
  unknown_field: 'Campo no reconocido. Campos: estado, ubicacion, contacto, edad, nombre, nota — o aprobar / rechazar.',
  missing_value: 'Falta el valor a asignar.',
  bad_estado: 'Estado inválido. Usa: sin-contacto, localizado, aparecido, hospitalizado o fallecido.',
  bad_edad: 'Edad inválida (debe ser un número entre 1 y 129).',
};
const BAD_INPUT_EN: Record<string, string> = {
  missing_id: 'Missing case ID. Usage: /actualizar <ID> <field> <value>',
  unknown_field: 'Unknown field. Fields: estado, ubicacion, contacto, edad, nombre, nota — or aprobar / rechazar.',
  missing_value: 'Missing the value to set.',
  bad_estado: 'Invalid status. Use: sin-contacto, localizado, aparecido, hospitalizado or fallecido.',
  bad_edad: 'Invalid age (must be a number between 1 and 129).',
};

/** Deterministic chat text for an /actualizar outcome. */
export function buildUpdateResponse(r: UpdateResult, opts: BuildOpts): string {
  const es = opts.lang !== 'en';
  switch (r.kind) {
    case 'update_ok':
      return es
        ? `✅ Caso ${escapeHtml(r.caseId)} (${escapeHtml(r.name)}) actualizado: ${escapeHtml(r.summary)}.`
        : `✅ Case ${escapeHtml(r.caseId)} (${escapeHtml(r.name)}) updated: ${escapeHtml(r.summary)}.`;
    case 'update_forbidden':
      if (r.reason === 'not_executive') {
        return es
          ? '⛔ Aprobar o rechazar un caso requiere nivel ejecutivo (admin).'
          : '⛔ Approving or rejecting a case requires executive (admin) level.';
      }
      return es
        ? '⛔ Solo operadores autorizados pueden actualizar casos.'
        : '⛔ Only authorized operators can update cases.';
    case 'update_bad_input':
      return (es ? BAD_INPUT_ES : BAD_INPUT_EN)[r.reason] ?? (es ? 'Entrada inválida.' : 'Invalid input.');
    case 'update_not_found':
      return es ? 'No encontré ese caso.' : 'Case not found.';
    case 'update_not_editable':
      return es
        ? 'Ese caso no se puede editar desde el chat (registro externo/oficial). Usa la consola web.'
        : 'That case cannot be edited from chat (external/official registry). Use the web console.';
    default:
      return es ? 'Ocurrió un error al actualizar. Intenta de nuevo.' : 'An error occurred while updating. Try again.';
  }
}

// ---- Muro de Emergencia (public wall) replies -------------------------------
// The wall at /muro is fully public, so these render without a redaction tier.

/** One-line preview of a wall post (body clipped so lists stay scannable). */
function muroLine(p: MuroPost, baseUrl: string): string {
  const when = fmtDate(p.createdMs);
  const body = p.body.length > 160 ? `${p.body.slice(0, 157)}…` : p.body;
  return `• ${when} — ${p.name}: ${body}\n  ${baseUrl}/muro/p/${p.id}`;
}

/** Deterministic chat text for a /muro post attempt. */
export function buildMuroPostResponse(r: MuroPostResult, opts: BuildOpts): string {
  const es = opts.lang !== 'en';
  const base = opts.baseUrl || 'https://sismo911.com';
  switch (r.kind) {
    case 'muro_ok':
      return es
        ? `✅ Publicado en el Muro de Emergencia como ${r.name}.\nVerlo: ${base}/muro/p/${r.id}\nMuro completo: ${base}/muro`
        : `✅ Posted to the Emergency Wall as ${r.name}.\nView it: ${base}/muro/p/${r.id}\nFull wall: ${base}/muro`;
    case 'muro_too_long':
      return es
        ? `El mensaje es demasiado largo para el Muro (máximo ${r.max} caracteres).`
        : `That message is too long for the Wall (max ${r.max} characters).`;
    case 'muro_empty':
      return es
        ? 'Escribe el mensaje después del comando. Ejemplo: /muro Vi a Maria Perez en el refugio de Catia'
        : 'Type the message after the command. Example: /muro I saw Maria Perez at the Catia shelter';
    default:
      return es
        ? 'No pude publicar en el Muro. Inténtalo de nuevo.'
        : 'I could not post to the Wall. Try again.';
  }
}

/** Latest wall posts (bare /muro). */
export function buildMuroLatestResponse(posts: MuroPost[], opts: BuildOpts): string {
  const es = opts.lang !== 'en';
  const base = opts.baseUrl || 'https://sismo911.com';
  if (posts.length === 0) {
    return es
      ? `El Muro de Emergencia no tiene mensajes recientes. Publica con: /muro <tu mensaje>\n${base}/muro`
      : `The Emergency Wall has no recent posts. Post with: /muro <your message>\n${base}/muro`;
  }
  const header = es
    ? `🧱 Últimos ${posts.length} mensajes del Muro de Emergencia:`
    : `🧱 Latest ${posts.length} Emergency Wall posts:`;
  const footer = es
    ? `Muro completo: ${base}/muro — publica con /muro <tu mensaje>`
    : `Full wall: ${base}/muro — post with /muro <your message>`;
  return [header, '', ...posts.map((p) => muroLine(p, base)), '', footer].join('\n');
}

/**
 * Extra section appended to a name-search reply when the searched name also
 * appears in recent PUBLIC wall posts. Empty string when there are none, so
 * callers can unconditionally concatenate.
 */
export function buildMuroMentions(query: string, posts: MuroPost[], opts: BuildOpts): string {
  if (posts.length === 0) return '';
  const es = opts.lang !== 'en';
  const base = opts.baseUrl || 'https://sismo911.com';
  const header = es
    ? `🧱 Menciones de «${query}» en el Muro de Emergencia (mensajes públicos SIN verificar):`
    : `🧱 Mentions of "${query}" on the public Emergency Wall (UNVERIFIED public posts):`;
  return ['', header, ...posts.map((p) => muroLine(p, base))].join('\n');
}
