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
  const msg = parsed.data.message ?? parsed.data.edited_message;
  if (!msg || !msg.text) return c.json({ ok: true });

  const chatId = msg.chat.id;
  const chatType = msg.chat.type ?? 'private';
  const cmd = parseSismosCommand(msg.text);

  let reply: string;
  try {
    switch (cmd.kind) {
      case 'ultimo': {
        const [e] = await getEvents(c.env, 1);
        reply = e ? formatQuake(e, c.env.PUBLIC_BASE_URL || undefined) : 'No hay sismos en el registro todavía.';
        break;
      }
      case 'sismos': {
        const events = await getEvents(c.env, cmd.count ?? 5);
        reply = formatQuakeList(events);
        break;
      }
      case 'estado': {
        const events = await getEvents(c.env, 100);
        const threat = scoreThreat(events, Date.now());
        reply = formatThreat(threat, events[0] ?? null);
        break;
      }
      case 'suscribir': {
        await c.env.DB.prepare(
          `INSERT INTO sismos_bot_subs (chat_id, chat_type, added_ms) VALUES (?,?,?)
             ON CONFLICT(chat_id) DO UPDATE SET chat_type = excluded.chat_type`,
        ).bind(String(chatId), chatType, Date.now()).run();
        reply = '✅ Suscrito. Recibirás una alerta automática cuando ocurra un sismo significativo (M≥4.5). Usa /cancelar para dejar de recibirlas.';
        break;
      }
      case 'cancelar': {
        await c.env.DB.prepare(`DELETE FROM sismos_bot_subs WHERE chat_id = ?`).bind(String(chatId)).run();
        reply = 'Suscripción cancelada. Ya no recibirás alertas automáticas. Usa /suscribir para reactivarlas.';
        break;
      }
      default:
        reply = HELP_SISMOS;
    }
  } catch {
    reply = 'No pude obtener los datos sísmicos en este momento. Intenta de nuevo en un minuto.';
  }

  c.executionCtx.waitUntil(sendMessage(token, chatId, reply));
  return c.json({ ok: true });
});
