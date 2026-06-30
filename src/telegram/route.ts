// SISMO911 — Telegram bot: webhook route + query orchestration.
// ---------------------------------------------------------------------------
// Mounted at /api/telegram in src/index.ts. Pipeline for every update:
//   verify webhook secret → validate payload → authorize requester →
//   abuse/rate check → parse command (deterministic, AI fallback) →
//   resolve against DB (verified-only) → redact → build reply → send → audit.
// Telegram is always answered with 200 once the secret is verified, so it does
// not retry; logical outcomes are conveyed in the chat reply, not the HTTP code.

import { Hono } from 'hono';
import type { Env } from '../types';
import type { TelegramEnv } from './env';
import { readTelegramConfig } from './env';
import { TgUpdate, type CaseRecord, type ParsedCommand, type QueryResult, type ViewerRole } from './types';
import { verifyWebhook, isRequestAuthorized, canViewSensitiveData, viewerRoleFor } from './auth';
import { parseCommand } from './commands';
import { aiNormalizeIntent } from './intent';
import { buildTelegramResponse } from './responses';
import { redactSensitiveFields, isHiddenFromPublic } from '../adapters/sismo911-api';
import {
  getCaseById,
  searchPersonById,
  searchPersonByName,
  searchHospitalized,
  searchMissing,
  searchByPhone,
} from '../adapters/sismo911-api';
import { auditTelegram, checkAbuse, queryFingerprint } from './audit';
import { hashId } from './hash';

type BotEnv = Env & TelegramEnv;

const TG_API = 'https://api.telegram.org';

async function sendMessage(token: string, chatId: number | string, text: string): Promise<void> {
  await fetch(`${TG_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  }).catch(() => {});
}

export interface ResolveCtx {
  canSeeSensitive: boolean;
  role: ViewerRole;
  nowMs?: number;
}

/**
 * Resolve a parsed command to a QueryResult using verified DB data only.
 * Exported for unit testing with a fake Env. Pure w.r.t. the DB it is handed.
 */
export async function resolveQuery(env: Env, cmd: ParsedCommand, ctx: ResolveCtx): Promise<QueryResult> {
  if (cmd.kind === 'ayuda' || cmd.kind === 'unknown') return { kind: 'help' };

  try {
    // Case-id lookups (strongest).
    if (cmd.kind === 'caso' || cmd.kind === 'status') {
      if (!cmd.caseId) return { kind: 'bad_input' };
      const rec = await getCaseById(env, cmd.caseId);
      if (!rec) return { kind: 'no_match' };
      if (!ctx.canSeeSensitive && isHiddenFromPublic(rec)) return { kind: 'no_match' };
      return { kind: 'match', record: redactSensitiveFields(rec, ctx.canSeeSensitive) };
    }

    // Phone is sensitive → operators only.
    if (cmd.phone) {
      if (!ctx.canSeeSensitive) return { kind: 'need_more', reason: 'phone_requires_admin' };
      const recs = await searchByPhone(env, cmd.phone);
      return finalize(recs, ctx);
    }

    // National id (strong).
    if (cmd.cedula) {
      const recs = await searchPersonById(env, cmd.cedula);
      return finalize(recs, ctx);
    }

    // Name-based searches.
    if (cmd.kind === 'hospitalizados') {
      if (!cmd.name && !cmd.cedula) return { kind: 'bad_input' };
      if (cmd.partialName) return { kind: 'need_more', reason: 'partial_name' };
      const recs = await searchHospitalized(env, { name: cmd.name, cedula: cmd.cedula });
      return finalize(recs, ctx);
    }
    if (cmd.kind === 'missing') {
      if (!cmd.name) return { kind: 'bad_input' };
      if (cmd.partialName) return { kind: 'need_more', reason: 'partial_name' };
      const recs = await searchMissing(env, { name: cmd.name });
      return finalize(recs, ctx);
    }
    // buscar by name.
    if (cmd.name) {
      if (cmd.partialName) return { kind: 'need_more', reason: 'partial_name' };
      const recs = await searchPersonByName(env, { name: cmd.name, dob: cmd.dob }, ctx.nowMs);
      return finalize(recs, ctx);
    }
    return { kind: 'bad_input' };
  } catch {
    return { kind: 'error' };
  }
}

/** Shared post-processing: hide protected records from public, then choose
 *  no_match / multiple / single. */
function finalize(records: CaseRecord[], ctx: ResolveCtx): QueryResult {
  const recs = ctx.canSeeSensitive ? records : records.filter((r) => !isHiddenFromPublic(r));
  if (recs.length === 0) return { kind: 'no_match' };
  if (recs.length > 1) return { kind: 'multiple', count: recs.length };
  return { kind: 'match', record: redactSensitiveFields(recs[0], ctx.canSeeSensitive) };
}

export const telegram = new Hono<{ Bindings: BotEnv }>();

// Health/status — no secrets, safe to expose. Confirms whether the bot is armed.
telegram.get('/health', (c) => {
  const cfg = readTelegramConfig(c.env);
  return c.json({
    ok: true,
    configured: Boolean(cfg),
    groups: cfg?.allowedGroupIds.length ?? 0,
    admins: cfg?.adminUserIds.length ?? 0,
    ai: Boolean(c.env.AI),
  });
});

telegram.post('/webhook', async (c) => {
  const cfg = readTelegramConfig(c.env);
  // Fail closed if the bot is not configured.
  if (!cfg) return c.json({ ok: false }, 503);

  // 1. Authenticate the webhook itself (constant-time secret check).
  const headerSecret = c.req.header('x-telegram-bot-api-secret-token');
  if (!verifyWebhook(headerSecret, cfg)) {
    await auditTelegram(c.env, { event: 'webhook_reject' });
    return c.json({ ok: false }, 401);
  }

  // 2. Validate the payload shape.
  const body = await c.req.json().catch(() => null);
  const parsed = TgUpdate.safeParse(body);
  if (!parsed.success) return c.json({ ok: true }); // ack malformed updates, do nothing
  const msg = parsed.data.message ?? parsed.data.edited_message;
  if (!msg || !msg.text) return c.json({ ok: true });

  const token = cfg.botToken;
  const chatId = msg.chat.id;
  const chatType = msg.chat.type;
  const userId = msg.from?.id;
  const userHash = await hashId(cfg.webhookSecret, userId ?? 'anon');

  // 3. Authorize the requester (approved group, or admin/authorized DM).
  if (!isRequestAuthorized(msg, cfg)) {
    await auditTelegram(c.env, { event: 'unauthorized', chatId, chatType, userHash });
    // Only reply in private chats; stay silent in unknown groups to avoid noise.
    if (chatType === 'private') {
      await sendMessage(token, chatId, buildTelegramResponse({ kind: 'unauthorized' }, { lang: 'es', role: 'public', canSeeSensitive: false }));
    }
    return c.json({ ok: true });
  }

  const role = viewerRoleFor(userId, cfg);
  const canSeeSensitive = canViewSensitiveData(userId, chatId, chatType, cfg);

  // 4. Abuse / rate limiting (per hashed user).
  const abuse = await checkAbuse(c.env, userHash);
  if (abuse.scraping) {
    await auditTelegram(c.env, { event: 'abuse_suspected', chatId, chatType, userHash });
    // Alert every admin once (best-effort).
    for (const adminId of cfg.adminUserIds) {
      await sendMessage(token, adminId, `⚠️ SISMO911 bot: patrón de scraping detectado (usuario ${userHash}, chat ${chatId}).`);
    }
  }
  if (abuse.throttled) {
    await auditTelegram(c.env, { event: 'rate_limited', chatId, chatType, userHash });
    await sendMessage(token, chatId, buildTelegramResponse({ kind: 'rate_limited', retryAfterSec: abuse.retryAfterSec }, { lang: 'es', role, canSeeSensitive }));
    return c.json({ ok: true });
  }

  // 5. Parse the command (deterministic first; AI only to fill gaps).
  let cmd = parseCommand(msg.text);
  if (cmd.kind === 'buscar' && !cmd.cedula && !cmd.name && !cmd.phone && !cmd.caseId) {
    const ai = await aiNormalizeIntent(c.env, msg.text);
    if (ai) {
      cmd = {
        ...cmd,
        kind: ai.intent === 'unknown' ? 'buscar' : ai.intent,
        cedula: ai.cedula ?? cmd.cedula,
        name: ai.name ?? cmd.name,
        dob: ai.dob ?? cmd.dob,
        caseId: ai.caseId ?? cmd.caseId,
        city: ai.city ?? cmd.city,
      };
      if (cmd.name) {
        const words = cmd.name.split(/\s+/).filter(Boolean);
        cmd.partialName = words.length < 2 || cmd.name.replace(/\s+/g, '').length < 3;
      }
    }
  }

  // 6. Resolve against verified DB data.
  const result = await resolveQuery(c.env, cmd, { canSeeSensitive, role });

  // 7. Audit (hashed identifiers + query fingerprint only — never raw PII).
  const fp = await queryFingerprint(cfg.webhookSecret, [cmd.cedula, cmd.name, cmd.caseId, cmd.phone]);
  await auditTelegram(c.env, {
    event: 'query',
    chatId,
    chatType,
    userHash,
    command: cmd.kind,
    matchStrength: result.kind === 'match' ? result.record.matchStrength : null,
    resultKind: result.kind,
    resultCount: result.kind === 'multiple' ? result.count : result.kind === 'match' ? 1 : 0,
    queryHash: fp,
  });

  // 8. Reply.
  await sendMessage(token, chatId, buildTelegramResponse(result, { lang: cmd.lang, role, canSeeSensitive }));
  return c.json({ ok: true });
});
