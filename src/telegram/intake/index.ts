// SISMO911 — Telegram intake orchestrator.
// ---------------------------------------------------------------------------
// Entry point called from the webhook when a message carries a photo or a
// PDF/image document. Runs the full pipeline and talks to the sender directly:
//   pick media → download → store+extract → match → persist → notify + reply.
// Designed to run inside ctx.waitUntil() so the webhook acks Telegram instantly.
// Never throws; every failure degrades to a friendly reply + an operator ping.

import type { Env } from '../../types';
import type { TelegramConfig } from '../env';
import type { TelegramMessage } from '../types';
import { pickMedia, downloadFile } from './download';
import { extractFields } from './extract';
import { matchCase } from './match';
import { persist } from './persist';
import { notifyOperators, buildReceipt, sendTelegram } from './notify';
import { uid } from '../../lib/db';
import type { IntakeResult } from './types';

/** True when a message contains intake-relevant media (photo or PDF/image doc). */
export function isIntakeMessage(msg: TelegramMessage): boolean {
  return pickMedia(msg) !== null;
}

/**
 * Handle a photo/PDF submission end-to-end. The caller has already verified the
 * webhook secret and authorized the requester.
 */
export async function handleIntake(env: Env, cfg: TelegramConfig, msg: TelegramMessage): Promise<IntakeResult | null> {
  const picked = pickMedia(msg);
  if (!picked) return null;

  const token = cfg.botToken;
  const chatId = msg.chat.id;
  const tgUserId = msg.from?.id != null ? String(msg.from.id) : null;
  const tgUsername = (msg.from as { username?: string } | undefined)?.username ?? null;

  const submissionId = uid('itk');
  const code = `ITK-${submissionId.slice(4).toUpperCase()}`;

  // Immediate ack so the sender knows it's being processed (extraction is slow).
  await sendTelegram(token, chatId, `📎 Recibí tu archivo. Procesando… (código ${code})`);

  const media = await downloadFile(token, picked);
  if (!media) {
    await sendTelegram(token, chatId, `No pude descargar el archivo (${code}). Intenta reenviarlo o envía los datos por texto.`);
    return null;
  }

  const { fields } = await extractFields(env, media);
  const match = await matchCase(env, fields);
  const result = await persist(env, {
    submissionId,
    code,
    media,
    fields,
    match,
    tgUserId,
    tgUsername,
    tgChatId: String(chatId),
  });

  await sendTelegram(token, chatId, buildReceipt(result));
  await notifyOperators(env, cfg, result);
  return result;
}
