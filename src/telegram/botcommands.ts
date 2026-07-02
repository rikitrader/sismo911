// SISMO911 — Telegram bot command menu registration (BotFather setMyCommands).
// ---------------------------------------------------------------------------
// The bot token lives only in Worker Secrets, so the setMyCommands call must run
// inside the Worker. This module is idempotent + KV-guarded by COMMANDS_VERSION:
// it registers once per version and no-ops otherwise, so it is safe to call from
// the cron AND on every webhook (a cheap KV read on the hot path). Bump
// COMMANDS_VERSION whenever the command list / descriptions change to force a
// re-registration on the next tick.
//
// Scopes:
//   • default            → PUBLIC_COMMANDS (everyone, all chats)
//   • chat:<admin userId> → OPERATOR_COMMANDS (admins get /actualizar + /menu in
//     their private chat; a user's DM chat_id equals their user id)

import type { Env } from '../types';
import type { TelegramConfig } from './env';

export const COMMANDS_VERSION = 3; // v3: + operator estado shortcuts (/fallecido <nombre>, …)
const TG_API = 'https://api.telegram.org';
const KV_KEY = 'tg:botcommands:v';

export interface BotCommand {
  command: string;
  description: string;
}

// Names: lowercase, 1–32 chars, [a-z0-9_]. Descriptions: 1–256 chars.
export const PUBLIC_COMMANDS: BotCommand[] = [
  { command: 'buscar', description: 'Buscar una persona por nombre o cédula' },
  { command: 'caso', description: 'Ver un caso por su ID (EXP-… o FAM-…)' },
  { command: 'status', description: 'Estado corto de un caso' },
  { command: 'hospitalizados', description: 'Buscar en el registro de hospitales' },
  { command: 'missing', description: 'Buscar personas desaparecidas' },
  { command: 'muro', description: 'Publicar en el Muro de Emergencia (o ver los últimos mensajes)' },
  { command: 'ayuda', description: 'Ayuda y lista de comandos' },
];

export const OPERATOR_COMMANDS: BotCommand[] = [
  ...PUBLIC_COMMANDS,
  { command: 'actualizar', description: 'Actualizar un caso (ID o nombre): estado, nota, ubicación, edad…' },
  { command: 'fallecido', description: 'Marcar Fallecido(a): /fallecido <nombre o ID>' },
  { command: 'localizado', description: 'Marcar Localizado(a): /localizado <nombre o ID>' },
  { command: 'aparecido', description: 'Marcar Aparecido(a): /aparecido <nombre o ID>' },
  { command: 'hospitalizado', description: 'Marcar En un hospital: /hospitalizado <nombre o ID>' },
  { command: 'sincontacto', description: 'Marcar Sin contacto: /sincontacto <nombre o ID>' },
  { command: 'menu', description: 'Reinstalar el menú de comandos (admin)' },
];

export const BOT_SHORT_DESCRIPTION = 'Consulta y actualiza casos de personas desaparecidas de SISMO911 con datos verificados.';
export const BOT_DESCRIPTION = [
  'Bot oficial de SISMO911. Consulto el estado de casos con datos verificados.',
  '',
  '• Buscar: /buscar, /caso, /status, /hospitalizados, /missing.',
  '• Muro de Emergencia: /muro <mensaje> publica en sismo911.com/muro; /muro muestra lo último.',
  '• Reportar: envíame una FOTO o un PDF (una cédula, un volante o un reporte) y creo o actualizo el caso automáticamente.',
  '• Operadores: /actualizar para editar un caso.',
  '',
  'Escribe /ayuda para ver todo. No reemplaza a las autoridades: en emergencias llama al 911.',
].join('\n');

async function tg(token: string, method: string, body: unknown): Promise<boolean> {
  try {
    const r = await fetch(`${TG_API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = (await r.json().catch(() => null)) as { ok?: boolean } | null;
    return !!j?.ok;
  } catch {
    return false;
  }
}

export interface SyncResult {
  ran: boolean;
  version: number;
  admins: number;
  ok: boolean;
}

/**
 * Register the command menu with Telegram if not already at COMMANDS_VERSION.
 * KV-guarded; pass { force: true } to re-register regardless. Never throws.
 */
export async function syncBotCommands(env: Env, cfg: TelegramConfig, opts: { force?: boolean } = {}): Promise<SyncResult> {
  const current = await env.CACHE.get(KV_KEY).catch(() => null);
  if (!opts.force && current === String(COMMANDS_VERSION)) {
    return { ran: false, version: COMMANDS_VERSION, admins: cfg.adminUserIds.length, ok: true };
  }

  const token = cfg.botToken;
  let ok = true;
  // Default scope (no language_code → applies to every language, no empty-menu trap).
  ok = (await tg(token, 'setMyCommands', { commands: PUBLIC_COMMANDS, scope: { type: 'default' } })) && ok;
  // Per-admin private chat → full operator set.
  for (const adminId of cfg.adminUserIds) {
    const chatId = Number(adminId);
    if (!Number.isFinite(chatId)) continue;
    ok = (await tg(token, 'setMyCommands', { commands: OPERATOR_COMMANDS, scope: { type: 'chat', chat_id: chatId } })) && ok;
  }
  // Profile blurbs (best-effort; don't gate success or the version write).
  await tg(token, 'setMyShortDescription', { short_description: BOT_SHORT_DESCRIPTION });
  await tg(token, 'setMyDescription', { description: BOT_DESCRIPTION });

  if (ok) await env.CACHE.put(KV_KEY, String(COMMANDS_VERSION)).catch(() => {});
  return { ran: true, version: COMMANDS_VERSION, admins: cfg.adminUserIds.length, ok };
}

/** The version currently registered (per KV), or null if never registered. */
export async function getRegisteredVersion(env: Env): Promise<string | null> {
  return env.CACHE.get(KV_KEY).catch(() => null);
}
