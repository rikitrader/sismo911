// SISMO911 — Telegram bot: env access + validation.
// ---------------------------------------------------------------------------
// All secrets and config come from Cloudflare Worker env vars (Worker Secrets
// for tokens, [vars] for the non-secret allow-lists). NOTHING is hardcoded.
// The bot is INERT until TELEGRAM_BOT_TOKEN + TELEGRAM_WEBHOOK_SECRET are set,
// so deploying the route without configuring it cannot leak anything.

import { z } from 'zod';
import type { Env } from '../types';

/** The Telegram-specific slice of Env. Mirrors the additions in src/types.ts. */
export interface TelegramEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  ALLOWED_TELEGRAM_GROUP_IDS?: string; // comma-separated chat ids (negative numbers)
  ADMIN_TELEGRAM_USER_IDS?: string; // comma-separated user ids
  ALLOWED_TELEGRAM_USER_IDS?: string; // optional extra authorized (non-admin) users
  TELEGRAM_AI_MODEL?: string; // optional Workers-AI model override for intent parsing
}

const cfg = z.object({
  botToken: z.string().min(20),
  webhookSecret: z.string().min(8),
  allowedGroupIds: z.array(z.string()),
  adminUserIds: z.array(z.string()),
  allowedUserIds: z.array(z.string()),
});
export type TelegramConfig = z.infer<typeof cfg>;

/** Parse a comma/space-separated id list into trimmed, de-duped string ids. */
export function parseIdList(raw?: string | null): string[] {
  return [
    ...new Set(
      String(raw ?? '')
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * Build the validated bot config from env. Returns null when the bot is not
 * configured (missing token or secret) so the route can fail closed without
 * throwing. A missing allow-list is valid (it just means "no groups yet" — the
 * bot will reject every chat), never an open door.
 */
export function readTelegramConfig(env: Env & TelegramEnv): TelegramConfig | null {
  const parsed = cfg.safeParse({
    botToken: env.TELEGRAM_BOT_TOKEN ?? '',
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET ?? '',
    allowedGroupIds: parseIdList(env.ALLOWED_TELEGRAM_GROUP_IDS),
    adminUserIds: parseIdList(env.ADMIN_TELEGRAM_USER_IDS),
    allowedUserIds: parseIdList(env.ALLOWED_TELEGRAM_USER_IDS),
  });
  return parsed.success ? parsed.data : null;
}
