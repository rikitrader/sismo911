// SISMO911 — Live-seismic Telegram bot: PUBLIC webhook route.
// ---------------------------------------------------------------------------
// Mounted at /api/sismos-bot. Serves public seismic data (latest quakes, recent
// list, current threat/alert status) and manages auto-alert subscriptions. It is
// OPEN — any user, group, or channel may use it — because the data has no PII.
// The only gate is the Telegram webhook secret (proves the call is from Telegram
// for this bot). Inert until SISMOS_BOT_TOKEN + SISMOS_WEBHOOK_SECRET are set.

import { Hono } from 'hono';
import type { Env } from '../types';
import { TgUpdate } from '../telegram/types';
import { timingSafeEqual } from '../telegram/auth';
import { listEvents } from '../lib/db';
import { getCachedEvents } from '../ingest/usgs-cron';
import { scoreThreat } from '../lib/threat';
import {
  parseSismosCommand,
  formatQuake,
  formatQuakeList,
  formatThreat,
  HELP_SISMOS,
} from './format';

interface SismosEnv extends Env {
  SISMOS_BOT_TOKEN?: string;
  SISMOS_WEBHOOK_SECRET?: string;
}

const TG_API = 'https://api.telegram.org';

async function sendMessage(token: string, chatId: number | string, text: string): Promise<void> {
  await fetch(`${TG_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  }).catch(() => {});
}

/** Freshest events: the KV snapshot the USGS/FUNVISIS cron writes, else D1. */
async function getEvents(env: Env, limit: number): Promise<any[]> {
  const cached = await getCachedEvents(env).catch(() => null);
  if (cached?.events?.length) return cached.events.slice(0, limit);
  return listEvents(env, limit).catch(() => []);
}

export const sismosBot = new Hono<{ Bindings: SismosEnv }>();

sismosBot.get('/health', (c) => {
  const configured = Boolean(c.env.SISMOS_BOT_TOKEN && c.env.SISMOS_WEBHOOK_SECRET);
  return c.json({ ok: true, configured, public: true });
});

sismosBot.post('/webhook', async (c) => {
  const token = c.env.SISMOS_BOT_TOKEN;
  const secret = c.env.SISMOS_WEBHOOK_SECRET;
  if (!token || !secret) return c.json({ ok: false }, 503);

  // Webhook authenticity (constant-time), fail closed.
  const header = c.req.header('x-telegram-bot-api-secret-token');
  if (!header || !timingSafeEqual(header, secret)) return c.json({ ok: false }, 401);

  const body = await c.req.json().catch(() => null);
  const parsed = TgUpdate.safeParse(body);
  if (!parsed.success) return c.json({ ok: true });
  const upd = parsed.data;

  // Membership change: when the bot is added/promoted in a channel or group, it
  // auto-subscribes that chat to the live feed and posts a welcome. Removed →
  // unsubscribe. This is how a CHANNEL becomes a live quake feed (channels don't
  // send /commands the way DMs/groups do; the bot must be an admin to post).
  if (upd.my_chat_member) {
    const m = upd.my_chat_member;
    const cid = m.chat.id;
    const ctype = m.chat.type ?? '';
    const status = m.new_chat_member?.status ?? '';
    if (ctype === 'channel' || ctype === 'group' || ctype === 'supergroup') {
      if (status === 'administrator' || status === 'creator' || status === 'member') {
        await subscribe(c.env, cid, ctype);
        c.executionCtx.waitUntil(
          sendMessage(token, cid, `✅ SISMO911 en vivo activado aquí. Publicaré una alerta automática cuando ocurra un sismo significativo (M≥4.5).\n\n${HELP_SISMOS}`),
        );
      } else if (status === 'left' || status === 'kicked') {
        await unsubscribe(c.env, cid);
      }
    }
    return c.json({ ok: true });
  }

  // Interactive command from a DM, group, OR channel post.
  const msg = upd.message ?? upd.edited_message ?? upd.channel_post ?? upd.edited_channel_post;
  if (!msg || !msg.text) return c.json({ ok: true });

  const reply = await resolveCommand(c.env, msg.chat.id, msg.chat.type ?? 'private', msg.text);
  c.executionCtx.waitUntil(sendMessage(token, msg.chat.id, reply));
  return c.json({ ok: true });
});

async function subscribe(env: SismosEnv, chatId: number | string, chatType: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sismos_bot_subs (chat_id, chat_type, added_ms) VALUES (?,?,?)
       ON CONFLICT(chat_id) DO UPDATE SET chat_type = excluded.chat_type`,
  ).bind(String(chatId), chatType, Date.now()).run();
}

async function unsubscribe(env: SismosEnv, chatId: number | string): Promise<void> {
  await env.DB.prepare(`DELETE FROM sismos_bot_subs WHERE chat_id = ?`).bind(String(chatId)).run();
}

/** Resolve a command (DM / group / channel post) to reply text. */
async function resolveCommand(env: SismosEnv, chatId: number | string, chatType: string, text: string): Promise<string> {
  const cmd = parseSismosCommand(text);
  try {
    switch (cmd.kind) {
      case 'ultimo': {
        const [e] = await getEvents(env, 1);
        return e ? formatQuake(e, env.PUBLIC_BASE_URL || undefined) : 'No hay sismos en el registro todavía.';
      }
      case 'sismos': {
        return formatQuakeList(await getEvents(env, cmd.count ?? 5));
      }
      case 'estado': {
        const events = await getEvents(env, 100);
        return formatThreat(scoreThreat(events, Date.now()), events[0] ?? null);
      }
      case 'suscribir': {
        await subscribe(env, chatId, chatType);
        return '✅ Suscrito. Recibirás una alerta automática cuando ocurra un sismo significativo (M≥4.5). Usa /cancelar para dejar de recibirlas.';
      }
      case 'cancelar': {
        await unsubscribe(env, chatId);
        return 'Suscripción cancelada. Ya no recibirás alertas automáticas. Usa /suscribir para reactivarlas.';
      }
      default:
        return HELP_SISMOS;
    }
  } catch {
    return 'No pude obtener los datos sísmicos en este momento. Intenta de nuevo en un minuto.';
  }
}
