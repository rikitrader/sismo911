// SISMO911 — Muro auto-responder: the bot answers ON the public wall.
// ---------------------------------------------------------------------------
// When a new message lands on the Muro de Emergencia (channel 'terremotos') —
// from the web form OR the Telegram /muro command — this module decides whether
// it is a person-search ("Busco a Maria Perez", "¿Alguien ha visto a…?") and,
// if so, posts a reply on the wall itself as «SISMO911 · Bot» (role 'official',
// so the page renders the badge). The answer comes from the SAME pipeline the
// Telegram bot uses: parseCommand → resolveQuery at the PUBLIC tier, so the
// existing redaction/verification gates apply untouched.
//
// Reply policy (the wall is public — silence beats noise):
//   • verified match / several matches → public-tier summary + case link
//   • no match → reply ONLY when the post is clearly a question, with guidance
//   • greetings, casual chatter, partial names, errors → no reply
//   • the bot NEVER replies to its own posts (loop-guard by user_id)

import type { Env } from '../types';
import { uid } from '../lib/db';
import { parseCommand } from './commands';
import { aiNormalizeIntent } from './intent';
import { resolveQuery } from './route';
import { buildTelegramResponse } from './responses';
import type { QueryResult } from './types';
import { MURO_CHANNEL, MURO_MAX_LEN } from './muro';

export const MURO_BOT_USER_ID = 'bot:sismo911';
export const MURO_BOT_NAME = 'SISMO911 · Bot';

/** The slice of a just-posted wall message the responder needs. */
export interface MuroIncoming {
  id: string;
  name: string;
  body: string;
  userId?: string | null;
}

/** Question-shaped Spanish/English wall text — gates the no-match reply. */
export function looksLikeQuestion(body: string): boolean {
  const t = (body ?? '').toLowerCase();
  return (
    t.includes('?') || t.includes('¿') ||
    /\b(busco|buscando|buscamos|alguien|paradero|desaparec|extraviad|no aparece|no sabemos|ha[n]? visto|sabe[n]? (de|algo)|donde esta|dónde está|looking for|missing|anyone seen)\b/i.test(t)
  );
}

// Everyday Spanish/English words that rule a token OUT of being part of a bare
// name ("gracias por la información" must not be searched as a person).
const NON_NAME_WORDS = new Set([
  'gracias', 'por', 'la', 'el', 'los', 'las', 'un', 'una', 'de', 'del', 'en', 'con', 'para', 'que', 'qué',
  'y', 'o', 'no', 'si', 'sí', 'mi', 'tu', 'su', 'favor', 'dios', 'fuerza', 'venezuela', 'ayuda', 'info',
  'informacion', 'información', 'buenas', 'buenos', 'dias', 'días', 'tardes', 'noches', 'hola', 'saludos',
  'busco', 'buscando', 'buscamos', 'busca', 'visto', 'vista', 'alguien', 'donde', 'dónde', 'esta', 'está',
  'the', 'and', 'for', 'thanks', 'please', 'help', 'looking', 'missing', 'seen', 'anyone',
]);

/**
 * A post that IS just a person's name ("Maria Fernanda Perez") — 2-4 word
 * tokens, letters/accents only, none of them everyday vocabulary. Safe to
 * search verbatim without AI help.
 */
export function isBareName(body: string): boolean {
  const tokens = (body ?? '').trim().split(/\s+/);
  if (tokens.length < 2 || tokens.length > 4) return false;
  if (body.replace(/\s+/g, '').length < 6) return false;
  return tokens.every((t) => /^[a-záéíóúüñ'’.-]+$/i.test(t) && !NON_NAME_WORDS.has(t.toLowerCase()));
}

/**
 * Decide + build the wall reply for a resolved search. Pure. Returns null when
 * the right move is silence.
 */
export function buildWallReply(query: string, result: QueryResult, questionLike: boolean, baseUrl: string): string | null {
  const opts = { lang: 'es' as const, role: 'public' as const, canSeeSensitive: false, baseUrl };
  switch (result.kind) {
    case 'match':
    case 'multiple': {
      // Telegram replies may carry HTML formatting (<b>, <a>); the wall renders
      // plain text, so strip tags before posting.
      const body = buildTelegramResponse(result, opts).replace(/<[^>]+>/g, '');
      const text = `↪ Sobre «${query}»: ${body}`;
      return text.length > MURO_MAX_LEN ? `${text.slice(0, MURO_MAX_LEN - 1)}…` : text;
    }
    case 'no_match':
      if (!questionLike) return null;
      return [
        `↪ Sobre «${query}»: no hay un registro verificado con ese nombre por ahora.`,
        `Puedes reportar el caso en ${baseUrl}/personas o por el bot de Telegram (envía una foto o los datos y creamos el expediente).`,
        `Casos públicos: ${baseUrl}/casos`,
      ].join(' ');
    default:
      return null; // bad_input, need_more, error, list (operator-only), help…
  }
}

/**
 * Entry point — fire-and-forget (call inside waitUntil). Never throws.
 * `deps.resolve` is injectable for tests.
 */
export async function maybeRespondOnMuro(
  env: Env,
  msg: MuroIncoming,
  deps: { resolve?: typeof resolveQuery } = {},
): Promise<{ replied: boolean; replyId?: string }> {
  try {
    const body = (msg.body ?? '').trim();
    // Loop-guard + junk-guard: never answer the bot itself, empty or tiny posts.
    if (!body || body.length < 4) return { replied: false };
    if (msg.userId === MURO_BOT_USER_ID || msg.name === MURO_BOT_NAME) return { replied: false };

    // Same deterministic parse the Telegram bot runs on free text.
    let cmd = parseCommand(body);
    if (cmd.kind === 'ayuda' || cmd.kind === 'unknown' || cmd.kind === 'actualizar' || cmd.kind === 'muro') {
      return { replied: false }; // greetings/help/write-commands are not wall questions
    }
    const questionLike = looksLikeQuestion(body);

    // Wall posts are prose, so the token parser would take a whole sentence as
    // a "name" ("Busco a Maria Perez desde el sismo"). Trust the parse only for
    // a shape-detected cédula or a bare-name post; for question-shaped prose,
    // let the AI normalizer extract the person. Anything else → silence.
    if (!cmd.cedula && !isBareName(body)) {
      if (!questionLike) return { replied: false };
      const ai = await aiNormalizeIntent(env, body);
      if (!ai || (!ai.name && !ai.cedula)) return { replied: false };
      cmd = { ...cmd, name: ai.name ?? undefined, cedula: ai.cedula ?? cmd.cedula, dob: ai.dob ?? cmd.dob };
      if (cmd.name) cmd.partialName = cmd.name.replace(/\s+/g, '').length < 3;
    }

    // Nothing searchable, or a fragment too weak to answer safely → silence.
    if ((!cmd.name || cmd.partialName) && !cmd.cedula) return { replied: false };
    // Phone lookups are operator-only; never resolved from the public wall.
    if (cmd.phone) return { replied: false };

    const resolve = deps.resolve ?? resolveQuery;
    const result = await resolve(env, cmd, { role: 'public', canSeeSensitive: false });
    const baseUrl = env.PUBLIC_BASE_URL || 'https://sismo911.com';
    const reply = buildWallReply(cmd.name ?? cmd.cedula ?? '', result, questionLike, baseUrl);
    if (!reply) return { replied: false };

    const replyId = uid('msg');
    await env.DB.prepare(
      `INSERT INTO chat_messages (id, channel, name, body, role, image_key, user_id, flagged, created_ms)
       VALUES (?,?,?,?,?,NULL,?,0,?)`
    ).bind(replyId, MURO_CHANNEL, MURO_BOT_NAME, reply, 'official', MURO_BOT_USER_ID, Date.now()).run();
    return { replied: true, replyId };
  } catch {
    return { replied: false }; // the wall post itself must never fail because of the bot
  }
}
