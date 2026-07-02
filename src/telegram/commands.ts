// SISMO911 — Telegram bot: command parser (Spanish + English).
// ---------------------------------------------------------------------------
// Turns a raw chat line into a structured, validated ParsedCommand. This is
// PURE and deterministic — no DB, no AI. It extracts identifiers (cédula, name,
// DOB, case id, phone, city); it NEVER decides a status. Quoted phrases are
// honored so multi-word names survive ("Maria Perez").
//
// Forgiving by design (people type many ways): it tolerates a leading
// @bot-mention ("@Vzla911bot /caso X"), command words WITHOUT a slash
// ("caso EXP-2026-1"), and bare names without quotes ("/buscar Maria Perez").
// A greeting or a bare mention ("hola", "@Vzla911bot") resolves to the welcome
// (kind 'ayuda') so the bot can greet + list its commands.

import type { CommandKind, ParsedCommand, UpdateField } from './types';

// /actualizar field/action aliases → canonical UpdateField. Spanish + English.
const UPDATE_FIELDS: Record<string, UpdateField> = {
  estado: 'estado', status: 'estado', estatus: 'estado',
  ubicacion: 'ubicacion', 'ubicación': 'ubicacion', lugar: 'ubicacion', location: 'ubicacion',
  contacto: 'contacto', telefono: 'contacto', 'teléfono': 'contacto', tel: 'contacto', phone: 'contacto', contact: 'contacto',
  edad: 'edad', años: 'edad', anos: 'edad', age: 'edad',
  nombre: 'nombre', name: 'nombre',
  nota: 'nota', note: 'nota', comentario: 'nota', comment: 'nota',
  aprobar: 'aprobar', aprueba: 'aprobar', publicar: 'aprobar', approve: 'aprobar', publish: 'aprobar',
  rechazar: 'rechazar', rechaza: 'rechazar', ocultar: 'rechazar', reject: 'rechazar', hide: 'rechazar',
};

// Command aliases → canonical kind. Spanish first; English accepted too.
const COMMANDS: Record<string, CommandKind> = {
  buscar: 'buscar',
  search: 'buscar',
  find: 'buscar',
  caso: 'caso',
  case: 'caso',
  status: 'status',
  estado: 'status',
  hospitalizados: 'hospitalizados',
  hospitalizado: 'hospitalizados',
  hospitalized: 'hospitalizados',
  hospital: 'hospitalizados',
  missing: 'missing',
  desaparecidos: 'missing',
  desaparecido: 'missing',
  actualizar: 'actualizar',
  actualiza: 'actualizar',
  evaluar: 'evaluar',
  evaluacion: 'evaluar',
  'evaluación': 'evaluar',
  editar: 'actualizar',
  modificar: 'actualizar',
  update: 'actualizar',
  edit: 'actualizar',
  ayuda: 'ayuda',
  help: 'ayuda',
  start: 'ayuda',
  menu: 'ayuda',
  comandos: 'ayuda',
  commands: 'ayuda',
};

// /muro publishes to the public wall at sismo911.com/muro — a WRITE command, so
// it is SLASH-ONLY. A sentence that merely starts with the bare word "muro"
// ("muro se cayó en Catia") must never publish; it falls through to the normal
// free-text search path. No '/publicar' alias: that word already means "approve"
// in the operator vocabulary (/actualizar <ID> publicar).
const MURO_COMMANDS = new Set(['muro', 'wall']);

// Direct estado shortcuts — operator writes, SLASH-ONLY (a sentence starting
// with the bare word "fallecido" must never edit a case):
//   /fallecido Sarah Ysea Caracciolo   ≡   /actualizar "Sarah…" estado fallecido
// Also /localizado, /aparecido, /hospitalizado, /sincontacto (/sin-contacto).
// In route.ts a PUBLIC sender is downgraded to a plain name search.
const STATUS_SHORTCUTS: Record<string, string> = {
  'sin-contacto': 'sin-contacto', sincontacto: 'sin-contacto', sin_contacto: 'sin-contacto',
  localizado: 'localizado', localizada: 'localizado',
  aparecido: 'aparecido', aparecida: 'aparecido',
  hospitalizado: 'hospitalizado', hospitalizada: 'hospitalizado',
  fallecido: 'fallecido', fallecida: 'fallecido',
};

// /evaluar status tokens → canonical building_eval_events status.
const EVAL_STATUS_ALIASES: Record<string, string> = {
  pendiente: 'pendiente',
  en_curso: 'en_curso', 'en-curso': 'en_curso', encurso: 'en_curso',
  iniciada: 'en_curso', iniciado: 'en_curso', iniciar: 'en_curso',
  completada: 'completada', completado: 'completada', completa: 'completada',
  terminada: 'completada', terminado: 'completada', lista: 'completada', listo: 'completada',
  bloqueada: 'bloqueada', bloqueado: 'bloqueada', bloquear: 'bloqueada',
};

// English command words / keywords that flip the reply language to English.
const EN_COMMANDS = new Set(['search', 'find', 'case', 'hospitalized', 'missing', 'help', 'status', 'commands']);
const EN_KEYWORDS = new Set(['name', 'birth', 'dob', 'phone', 'city', 'id']);
const EN_GREETINGS = new Set(['hi', 'hello', 'hey', 'help', 'commands', 'menu', 'start']);

// Greeting / "just saying hi or @-mentioning the bot" tokens → welcome.
const GREETINGS = new Set([
  'hola', 'holaa', 'holaaa', 'ola', 'buenas', 'buenos', 'dias', 'tardes', 'noches',
  'saludos', 'hey', 'hi', 'hello', 'hallo', 'start', 'menu', 'comandos', 'commands',
  'info', 'ayuda', 'help', 'bot', 'epa', 'klk',
]);

// Field keyword → canonical field. Used by the key/value walker below.
const FIELD: Record<string, 'cedula' | 'name' | 'dob' | 'phone' | 'city'> = {
  cedula: 'cedula',
  'cédula': 'cedula',
  ci: 'cedula',
  ced: 'cedula',
  dni: 'cedula',
  id: 'cedula',
  nombre: 'name',
  name: 'name',
  nacimiento: 'dob',
  nac: 'dob',
  fecha: 'dob',
  fdn: 'dob',
  dob: 'dob',
  birth: 'dob',
  telefono: 'phone',
  'teléfono': 'phone',
  tel: 'phone',
  phone: 'phone',
  celular: 'phone',
  ciudad: 'city',
  city: 'city',
  localidad: 'city',
};

/** Split a string on whitespace, but keep "double-quoted phrases" as one token. */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out.filter((t) => t.length > 0);
}

const ISO_DOB = /^\d{4}-\d{2}-\d{2}$/;
const DMY_DOB = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const CEDULA_BARE = /^[vVeEjJgG]?-?\d{5,9}$/;
const PHONE_BARE = /^\+?\d[\d\s().-]{6,}$/;

function toIsoDob(v: string): string | undefined {
  if (ISO_DOB.test(v)) return v;
  const m = DMY_DOB.exec(v);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return undefined;
}

/** Strip punctuation/emoji/accents for greeting comparison. */
function bare(tok: string): string {
  return tok.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
}

/** True when the only meaningful content is a greeting or a bare @-mention. */
function isGreetingOnly(tokens: string[]): boolean {
  const meaningful = tokens.filter((t) => !t.startsWith('@'));
  if (meaningful.length === 0) return true; // just an @-mention
  if (meaningful.length > 3) return false; // a real sentence/query, not a greeting
  return meaningful.every((t) => {
    const b = bare(t);
    return b === '' || GREETINGS.has(b);
  });
}

function detectLang(raw: string, extraEn: boolean): 'es' | 'en' {
  const lower = raw.toLowerCase();
  if (extraEn) return 'en';
  if ([...EN_KEYWORDS].some((k) => new RegExp(`\\b${k}\\b`).test(lower))) return 'en';
  for (const t of tokenize(lower)) if (EN_GREETINGS.has(bare(t))) return 'en';
  return 'es';
}

/**
 * Parse a chat message into a ParsedCommand.
 */
export function parseCommand(text: string): ParsedCommand {
  const raw = (text ?? '').trim();
  let tokens = tokenize(raw);
  if (tokens.length === 0) return { kind: 'unknown', lang: 'es', raw };

  // Drop a leading @bot-mention so "@Vzla911bot /caso X" or "@Vzla911bot hola"
  // parse like the same message without the mention.
  let mentioned = false;
  while (tokens.length && tokens[0].startsWith('@')) {
    mentioned = true;
    tokens = tokens.slice(1);
  }
  if (tokens.length === 0) {
    // Bare @-mention → welcome.
    return { kind: 'ayuda', lang: detectLang(raw, false), raw };
  }

  // Command word: strip leading "/" and any "@botname" suffix.
  let head = tokens[0];
  let isSlash = false;
  if (head.startsWith('/')) {
    isSlash = true;
    head = head.slice(1).split('@')[0];
  }
  const cmdWord = head.toLowerCase();
  const known = COMMANDS[cmdWord];

  // Slash-only wall command: /muro <texto> publishes; bare /muro lists recent posts.
  // The post text is cut from the RAW message (not re-joined tokens) so the
  // author's quotes/newlines survive onto the wall verbatim.
  if (isSlash && MURO_COMMANDS.has(cmdWord)) {
    const muroText = raw.replace(/^\s*(?:@\S+\s+)*\/(?:muro|wall)(?:@\S+)?\s*/i, '').trim();
    return { kind: 'muro', lang: detectLang(raw, cmdWord === 'wall'), muroText, raw };
  }

  // Slash-only estado shortcut with a target: /fallecido <nombre o ID>.
  // A bare "/hospitalizado" (no args) still falls through to the legacy
  // hospital-registry search alias below.
  if (isSlash && STATUS_SHORTCUTS[cmdWord] && tokens.length > 1) {
    const target = tokens.slice(1).filter((t) => !t.startsWith('@')).join(' ').trim();
    if (target) {
      return {
        kind: 'actualizar',
        lang: detectLang(raw, false),
        caseId: target,
        updateField: 'estado',
        updateValue: STATUS_SHORTCUTS[cmdWord],
        statusShortcut: true,
        raw,
      };
    }
  }

  let kind: CommandKind;
  let args: string[];
  if (known) {
    kind = known;
    args = tokens.slice(1);
    // /evaluar is a WRITE command → SLASH-ONLY (a sentence starting with the
    // bare word "evaluar" must never write; it stays a free-text search).
    if (kind === 'evaluar' && !isSlash) kind = 'buscar';
  } else if (isSlash) {
    // Unknown slash command → show the welcome/help rather than erroring.
    return { kind: 'ayuda', lang: detectLang(raw, EN_COMMANDS.has(cmdWord)), raw };
  } else {
    kind = 'buscar';
    args = tokens; // free text — the whole thing is the query (or a greeting)
  }

  const lang = detectLang(raw, isSlash && EN_COMMANDS.has(cmdWord));

  if (kind === 'ayuda' || kind === 'unknown') return { kind, lang, raw };

  // Free-text (no slash) or a mention that is just a greeting → welcome.
  if (kind === 'buscar' && (mentioned || !isSlash) && isGreetingOnly(args)) {
    return { kind: 'ayuda', lang, raw };
  }

  // /caso and /status take a single case-id argument (the rest of the line).
  if (kind === 'caso' || kind === 'status') {
    const caseId = args.filter((t) => !t.startsWith('@')).join(' ').trim();
    return { kind, lang, caseId: caseId || undefined, raw };
  }

  // /evaluar <edificio…> n<1|2|3> [estado] [nota…]  (operator write command).
  //   Grammar: everything before the level token (n1/n2/n3 or "nivel 2") is the
  //   building query; an optional status word follows; the rest is the nota.
  if (kind === 'evaluar') {
    const a = args.filter((t) => !t.startsWith('@'));
    let li = -1; let evalLevel: number | undefined;
    for (let i = 0; i < a.length; i++) {
      const m = /^n(?:ivel)?[-_]?([123])$/i.exec(a[i]);
      if (m) { li = i; evalLevel = Number(m[1]); break; }
      if (/^nivel$/i.test(a[i]) && /^[123]$/.test(a[i + 1] ?? '')) { li = i; evalLevel = Number(a[i + 1]); a.splice(i + 1, 1); break; }
    }
    const evalQuery = (li >= 0 ? a.slice(0, li) : a).join(' ').trim();
    let rest = li >= 0 ? a.slice(li + 1) : [];
    let evalStatus: string | undefined;
    if (rest.length) {
      const st = EVAL_STATUS_ALIASES[rest[0].toLowerCase()];
      if (st) { evalStatus = st; rest = rest.slice(1); }
      else if (/^en$/i.test(rest[0]) && /^curso$/i.test(rest[1] ?? '')) { evalStatus = 'en_curso'; rest = rest.slice(2); }
    }
    const evalNote = rest.join(' ').trim() || undefined;
    return { kind, lang, evalQuery: evalQuery || undefined, evalLevel, evalStatus, evalNote, raw };
  }

  // /actualizar <ID o nombre> <campo> <valor…>  (operator write command).
  //   Grammar: everything before the FIRST field/action keyword is the target —
  //   a case id OR a multi-word full name ("/actualizar Sarah Ysea estado
  //   fallecido"). Also accepts `campo=valor` glued to the field token.
  //   aprobar/rechazar take no value.
  if (kind === 'actualizar') {
    const a = args.filter((t) => !t.startsWith('@'));
    let fi = -1;
    for (let i = 1; i < a.length; i++) {
      const w = a[i].toLowerCase();
      const baseTok = w.includes('=') ? w.slice(0, w.indexOf('=')) : w;
      if (UPDATE_FIELDS[baseTok]) {
        fi = i;
        break;
      }
    }
    const caseId = (fi > 0 ? a.slice(0, fi).join(' ') : a[0] || '').trim();
    let fieldTok = ((fi > 0 ? a[fi] : a[1]) || '').toLowerCase();
    let value = (fi > 0 ? a.slice(fi + 1) : a.slice(2)).join(' ').trim();
    // Support `campo=valor` as a single token.
    if (fieldTok.includes('=')) {
      const eq = fieldTok.indexOf('=');
      value = `${fieldTok.slice(eq + 1)}${value ? ' ' + value : ''}`.trim();
      fieldTok = fieldTok.slice(0, eq);
    }
    const updateField = UPDATE_FIELDS[fieldTok];
    return { kind, lang, caseId: caseId || undefined, updateField, updateValue: value || undefined, raw };
  }

  // buscar / hospitalizados / missing: key/value walk with sensible defaults.
  const out: ParsedCommand = { kind, lang, raw };
  const nameParts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok.startsWith('@')) continue; // ignore stray mentions
    const key = FIELD[tok.toLowerCase()];
    if (key) {
      const val = args[i + 1];
      if (val == null) continue;
      i++;
      if (key === 'cedula') out.cedula = val;
      else if (key === 'name') out.name = val;
      else if (key === 'dob') out.dob = toIsoDob(val);
      else if (key === 'phone') out.phone = val;
      else if (key === 'city') out.city = val;
      continue;
    }
    // Un-keyworded token: classify by shape, else treat as a name fragment.
    if (!out.cedula && CEDULA_BARE.test(tok)) out.cedula = tok;
    else if (!out.dob && (ISO_DOB.test(tok) || DMY_DOB.test(tok))) out.dob = toIsoDob(tok);
    else if (!out.phone && tok.startsWith('+') && PHONE_BARE.test(tok)) out.phone = tok;
    else nameParts.push(tok);
  }
  if (!out.name && nameParts.length) out.name = nameParts.join(' ').trim();

  // Partial-name detection: only a too-short fragment (< 3 letters) is rejected.
  // A single full name ("Maria") is allowed to search — it just returns "varios
  // posibles registros" when broad, which is more useful than refusing outright.
  if (out.name) {
    out.partialName = out.name.replace(/\s+/g, '').length < 3;
  }
  return out;
}
