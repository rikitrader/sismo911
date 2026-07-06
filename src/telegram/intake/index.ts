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
import { DOCX_MIME } from './docx';
import { extractFields } from './extract';
import { matchCase } from './match';
import { persist } from './persist';
import { notifyOperators, buildReceipt, sendTelegram } from './notify';
import { escapeHtml } from '../responses';
import { uid } from '../../lib/db';
import { createBulkJob, processBulkJob } from '../../bulk/import-job';
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
  await sendTelegram(token, chatId, `📎 Recibí tu archivo. Procesando… (código <b>${code}</b>)`);

  const media = await downloadFile(token, picked);
  if (!media) {
    // Telegram caps bot downloads at 20 MB — a big multi-page padrón hits this.
    await sendTelegram(
      token,
      chatId,
      `No pude descargar el archivo (${code}). Si es un PDF grande (más de 20 MB), súbelo desde la consola de operadores en /importar. También puedes reenviarlo o escribir los datos por texto.`,
    );
    return null;
  }

  // A PDF/DOCX may be a multi-name roster (padrón/expediente), not a single
  // flyer. Route every document through the bulk pipeline: it extracts a LIST of
  // people and creates one draft case per name (a 1-name doc still yields
  // exactly 1 draft). Photos keep the single-person path (one cédula/face each).
  if (media.mime === 'application/pdf' || media.mime === DOCX_MIME) {
    return handleRosterIntake(env, cfg, msg, media);
  }

  const { fields } = await extractFields(env, media);
  const match = await matchCase(env, fields);
  // An ADMIN's submission publishes immediately — no operator approval step.
  const isAdmin = !!tgUserId && cfg.adminUserIds.includes(tgUserId);
  const result = await persist(env, {
    submissionId,
    code,
    media,
    fields,
    match,
    tgUserId,
    tgUsername,
    tgChatId: String(chatId),
    autoApprove: isAdmin,
  });

  await sendTelegram(token, chatId, buildReceipt(result));
  await notifyOperators(env, cfg, result);
  return result;
}

/**
 * Bulk roster intake: a PDF that may list many people. Stores the PDF, fans it
 * out into one draft case per name (all pending operator review), and reports a
 * summary back to the sender + operators. Runs inside ctx.waitUntil().
 */
async function handleRosterIntake(env: Env, cfg: TelegramConfig, msg: TelegramMessage, media: import('./types').IntakeMedia): Promise<IntakeResult | null> {
  const token = cfg.botToken;
  const chatId = msg.chat.id;
  const tgUserId = msg.from?.id != null ? String(msg.from.id) : null;
  const tgUsername = (msg.from as { username?: string } | undefined)?.username ?? null;
  const submittedBy = tgUsername ? `@${tgUsername}` : tgUserId ? `tg:${tgUserId}` : null;

  const job = await createBulkJob(env, {
    source: 'telegram',
    mime: media.mime,
    bytes: media.bytes,
    fileName: media.fileName,
    chatId: String(chatId),
    submittedBy,
    tgUserId,
  });

  await sendTelegram(token, chatId, `📎 Recibí el documento (padrón). Estoy leyendo los nombres… código <b>${job.code}</b>.`);

  const s = await processBulkJob(env, job.jobId);
  if (!s) return null;

  // Admin rosters publish immediately (processBulkJob auto-approves them).
  const isAdmin = !!tgUserId && cfg.adminUserIds.includes(tgUserId);
  const tail = isAdmin
    ? 'Publicados de inmediato (nivel administrador — sin aprobación pendiente).'
    : 'Nada es público todavía: un operador los revisará antes de publicarlos.';
  const created = isAdmin ? 'caso(s) nuevo(s) PUBLICADO(s)' : 'caso(s) nuevo(s) en borrador';
  const reply =
    s.status === 'error'
      ? `⚠️ <b>${job.code}</b>: no pude procesar el documento completo. Un operador lo revisará en la consola.`
      : s.total === 0
        ? `<b>${job.code}</b>: no pude leer nombres claros en el documento. Si puedes, envía un PDF con texto (no una foto escaneada) o los datos por texto.`
        : `✅ <b>${job.code}</b>: detecté <b>${s.total}</b> nombre(s) → <b>${s.created}</b> ${created}, <b>${s.matched}</b> coincidencia(s) con casos existentes, <b>${s.needsReview}</b> para revisión.\n${tail}`;
  await sendTelegram(token, chatId, reply);

  // Operator ping (same DM channel the single-intake path uses).
  if (cfg.adminUserIds.length && s.total > 0) {
    const base = env.PUBLIC_BASE_URL || 'https://sismo911.com';
    const alert = isAdmin
      ? `🗂️ Padrón por Telegram (<b>${job.code}</b>) de ${escapeHtml(submittedBy ?? 'anónimo')} — ADMIN: ${s.total} nombres → ${s.created} publicados, ${s.matched} coincidencias. Ver: ${base}/console`
      : `🗂️ Padrón por Telegram (<b>${job.code}</b>) de ${escapeHtml(submittedBy ?? 'anónimo')}: ${s.total} nombres → ${s.created} borradores, ${s.matched} coincidencias. Revisar: ${base}/console`;
    for (const adminId of cfg.adminUserIds) await sendTelegram(token, adminId, alert);
  }
  return null;
}
