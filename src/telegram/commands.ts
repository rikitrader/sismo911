// SISMO911 — Telegram bot: command parser (Spanish + English).
// ---------------------------------------------------------------------------
// Turns a raw chat line into a structured, validated ParsedCommand. This is
// PURE and deterministic — no DB, no AI. It extracts identifiers (cédula, name,
// DOB, case id, phone, city); it NEVER decides a status. Quoted phrases are
// honored so multi-word names survive ("Maria Perez").

import type { CommandKind, ParsedCommand } from './types';

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
  hospitalized: 'hospitalizados',
  hospital: 'hospitalizados',
  missing: 'missing',
  desaparecidos: 'missing',
  desaparecido: 'missing',
  ayuda: 'ayuda',
  help: 'ayuda',
  start: 'ayuda',
};

// English command words / keywords that flip the reply language to English.
const EN_COMMANDS = new Set(['search', 'find', 'case', 'hospitalized', 'missing', 'help', 'status']);
const EN_KEYWORDS = new Set(['name', 'birth', 'dob', 'phone', 'city', 'id']);

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

/**
 * Parse a chat message into a ParsedCommand. Non-command text (no leading "/")
 * is treated as a free-text "buscar" so the AI intent layer can normalize it;
 * the bot still only answers from DB rows.
 */
export function parseCommand(text: string): ParsedCommand {
  const raw = (text ?? '').trim();
  const tokens = tokenize(raw);
  if (tokens.length === 0) return { kind: 'unknown', lang: 'es', raw };

  // Command word: strip leading "/" and any "@botname" suffix.
  let head = tokens[0];
  let isSlash = false;
  if (head.startsWith('/')) {
    isSlash = true;
    head = head.slice(1).split('@')[0];
  }
  const cmdWord = head.toLowerCase();
  const kind: CommandKind = isSlash ? COMMANDS[cmdWord] ?? 'unknown' : 'buscar';

  // Language: English command word or any English field keyword present.
  const lower = raw.toLowerCase();
  const lang: 'es' | 'en' =
    (isSlash && EN_COMMANDS.has(cmdWord)) ||
    [...EN_KEYWORDS].some((k) => new RegExp(`\\b${k}\\b`).test(lower))
      ? 'en'
      : 'es';

  if (kind === 'ayuda' || kind === 'unknown') {
    return { kind, lang, raw };
  }

  const args = isSlash ? tokens.slice(1) : tokens;

  // /caso and /status take a single case-id argument (the rest of the line).
  if (kind === 'caso' || kind === 'status') {
    const caseId = args.join(' ').trim();
    return { kind, lang, caseId: caseId || undefined, raw };
  }

  // buscar / hospitalizados / missing: key/value walk with sensible defaults.
  const out: ParsedCommand = { kind, lang, raw };
  const nameParts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
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

  // Partial-name detection: one short token is not enough to identify a person.
  if (out.name) {
    const words = out.name.split(/\s+/).filter(Boolean);
    out.partialName = words.length < 2 || out.name.replace(/\s+/g, '').length < 3;
  }
  return out;
}
