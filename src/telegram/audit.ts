// SISMO911 — Telegram bot: audit logging + abuse/scraping detection.
// ---------------------------------------------------------------------------
// Every query is logged to the shared `audit` table (migrations/0002_ops.sql)
// with the requester identified ONLY by a salted hash — no raw Telegram user id,
// name, cédula, or phone ever reaches the log. The structured `detail` JSON is
// queryable via json_extract for forensics.

import type { Env } from '../types';
import { uid } from '../lib/db';
import { accountRateLimit } from '../security/rate-limit';
import { hashId } from './hash';

export interface TelegramAuditFields {
  event: string; // 'query' | 'unauthorized' | 'rate_limited' | 'abuse_suspected' | 'webhook_reject'
  chatId?: number | string | null;
  chatType?: string | null;
  userHash?: string | null; // pre-hashed (see hashId)
  command?: string | null; // command kind, NOT the raw text
  matchStrength?: string | null;
  resultKind?: string | null;
  resultCount?: number | null;
  queryHash?: string | null; // hash of the normalized query terms (abuse correlation, not PII)
}

/** Write one audit row. Never throws (audit failure must not break a reply). */
export async function auditTelegram(env: Env, fields: TelegramAuditFields): Promise<void> {
  try {
    const detail = { ...fields, surface: 'telegram-bot' };
    await env.DB.prepare(`INSERT INTO audit (id, actor, action, detail, created_ms) VALUES (?,?,?,?,?)`)
      .bind(
        uid('aud'),
        fields.userHash ? `tg:${fields.userHash}` : 'tg:anon',
        `telegram.${fields.event}`,
        JSON.stringify(detail).slice(0, 2000),
        Date.now(),
      )
      .run();
  } catch {
    /* fail open: a dropped audit line must not block a life-safety answer */
  }
}

export interface AbuseDecision {
  throttled: boolean; // normal per-user burst exceeded → ask user to slow down
  retryAfterSec?: number;
  scraping: boolean; // sustained high-volume pattern → alert admins
}

/**
 * Two-tier abuse check, both keyed by the (hashed) user id so one account can't
 * fan out across IPs:
 *   • burst   — short window, low limit → user-visible 429.
 *   • scraping — long window, high limit → silent flag + admin alert.
 * Fails open (no throttle) on infra error, matching the project's rate-limiter.
 */
export async function checkAbuse(
  env: Env,
  userHash: string,
  opts: { burstLimit?: number; burstWindowSec?: number; scrapeLimit?: number; scrapeWindowSec?: number } = {},
): Promise<AbuseDecision> {
  const burst = await accountRateLimit(env, userHash, 'tg_burst', opts.burstLimit ?? 8, opts.burstWindowSec ?? 30);
  const scrape = await accountRateLimit(env, userHash, 'tg_scrape', opts.scrapeLimit ?? 40, opts.scrapeWindowSec ?? 3600);
  return {
    throttled: burst.limited,
    retryAfterSec: burst.retryAfterSec,
    scraping: scrape.limited,
  };
}

/** Stable, non-reversible hash of the normalized query terms for correlating
 *  repeated/automated searches without storing the PII itself. */
export async function queryFingerprint(salt: string, parts: Array<string | undefined>): Promise<string> {
  return hashId(salt, parts.filter(Boolean).join('|').toLowerCase());
}
