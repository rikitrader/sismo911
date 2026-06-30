// SISMO911 — Telegram bot: authorization + webhook authentication.
// ---------------------------------------------------------------------------
// Two independent gates, both fail-closed:
//   1. webhook authenticity — the request really came from Telegram for THIS
//      bot (constant-time check of the X-Telegram-Bot-Api-Secret-Token header).
//   2. requester authorization — the message came from an approved group, or an
//      admin DM. Everything else is rejected before any DB query runs.

import type { TelegramConfig } from './env';
import type { TelegramMessage, ViewerRole } from './types';

/** Constant-time string compare (mirrors the private helper in apikey.ts). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Validate the Telegram webhook secret header. Telegram echoes the secret we
 * registered with setWebhook in `X-Telegram-Bot-Api-Secret-Token` on every
 * call. Reject (fail closed) when the header is absent or does not match.
 */
export function verifyWebhook(headerSecret: string | null | undefined, cfg: TelegramConfig): boolean {
  if (!headerSecret) return false;
  return timingSafeEqual(headerSecret, cfg.webhookSecret);
}

export function isAdmin(userId: number | string | undefined, cfg: TelegramConfig): boolean {
  if (userId == null) return false;
  return cfg.adminUserIds.includes(String(userId));
}

/** Explicitly allow-listed non-admin user (may view sensitive data). */
export function isAuthorizedUser(userId: number | string | undefined, cfg: TelegramConfig): boolean {
  if (userId == null) return false;
  return cfg.allowedUserIds.includes(String(userId));
}

export function isAllowedGroup(chatId: number | string | undefined, cfg: TelegramConfig): boolean {
  if (chatId == null) return false;
  return cfg.allowedGroupIds.includes(String(chatId));
}

/**
 * Core gate: may this message be served at all?
 *  - Approved group/supergroup → yes (public-level answers).
 *  - Private DM → only for admins (so the public can't quietly probe via DM).
 *  - Anything else (unknown group, channel, etc.) → no.
 */
export function isRequestAuthorized(msg: TelegramMessage, cfg: TelegramConfig): boolean {
  const chatType = msg.chat.type ?? '';
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  if (chatType === 'group' || chatType === 'supergroup') {
    return isAllowedGroup(chatId, cfg);
  }
  if (chatType === 'private') {
    return isAdmin(userId, cfg) || isAuthorizedUser(userId, cfg);
  }
  return false;
}

/**
 * canViewSensitiveData — the single source of truth for whether full,
 * un-redacted case detail may be returned to this requester in this chat.
 *
 * Sensitive detail (cédula, phone, address, hospital name, medical notes,
 * family contact) is shown ONLY to admins or explicitly authorized users, and
 * ONLY in a private DM — never broadcast into a group, even an approved one,
 * because group membership is broader than the people authorized to see PII.
 */
export function canViewSensitiveData(
  userId: number | string | undefined,
  chatId: number | string | undefined,
  chatType: string | undefined,
  cfg: TelegramConfig,
): boolean {
  const privileged = isAdmin(userId, cfg) || isAuthorizedUser(userId, cfg);
  if (!privileged) return false;
  // Only in a 1:1 DM. Approved groups still get redacted, public-level answers.
  return chatType === 'private';
}

/** Map a requester to a ViewerRole for redaction + response shaping. */
export function viewerRoleFor(
  userId: number | string | undefined,
  cfg: TelegramConfig,
): ViewerRole {
  if (isAdmin(userId, cfg)) return 'admin';
  if (isAuthorizedUser(userId, cfg)) return 'authorized';
  return 'public';
}
