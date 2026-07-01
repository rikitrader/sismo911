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
import { buildTelegramResponse, buildListMessages, buildUpdateResponse } from './responses';
import { resolveUpdate } from './update';
import { syncBotCommands, getRegisteredVersion } from './botcommands';
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
import { isIntakeMessage, handleIntake } from './intake';

type BotEnv = Env & TelegramEnv;

const TG_API = 'https://api.telegram.org';

const TG_MAX = 3900; // Telegram hard limit is 4096; leave headroom.

/** Split text into ≤TG_MAX chunks at line boundaries (never mid-line). A single
 *  over-long line is hard-split as a last resort. */
export function chunkText(text: string, max = TG_MAX): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    const piece = line.length > max ? line.slice(0, max) : line;
    if (cur && cur.length + piece.length + 1 > max) {
      chunks.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n${piece}` : piece;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Send several messages in order, paced to respect Telegram's per-chat limit. */
async function sendMessages(token: string, chatId: number | string, msgs: string[]): Promise<void> {
  for (let i = 0; i < msgs.length; i++) {
    await sendMessage(token, chatId, msgs[i]);
    if (i < msgs.length - 1) await new Promise((r) => setTimeout(r, 350));
  }
}

async function sendMessage(token: string, chatId: number | string, text: string): Promise<void> {
  // Split long operator lists across multiple Telegram messages (4096-char cap),
  // pacing them (~350ms) to stay under Telegram's ~1 msg/sec-per-chat flood limit.
  const chunks = chunkText(text);
  for (let i = 0; i < chunks.length; i++) {
    await fetch(`${TG_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunks[i], disable_web_page_preview: true }),
    }).catch(() => {});
    if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 350));
  }
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
      // /caso → full detail (name, age, + operator block in DM); /status → short.
      const detail = cmd.kind === 'status' ? 'status' : 'full';
      return { kind: 'match', record: redactSensitiveFields(rec, ctx.canSeeSensitive), detail };
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
      return finalize(recs, ctx, cmd.name);
    }
    if (cmd.kind === 'missing') {
      if (!cmd.name) return { kind: 'bad_input' };
      if (cmd.partialName) return { kind: 'need_more', reason: 'partial_name' };
      const recs = await searchMissing(env, { name: cmd.name });
      return finalize(recs, ctx, cmd.name);
    }
    // buscar by name.
    if (cmd.name) {
      if (cmd.partialName) return { kind: 'need_more', reason: 'partial_name' };
      const recs = await searchPersonByName(env, { name: cmd.name, dob: cmd.dob }, ctx.nowMs);
      return finalize(recs, ctx, cmd.name);
    }
    return { kind: 'bad_input' };
  } catch {
    return { kind: 'error' };
  }
}

/** Shared post-processing: hide protected records from public, then choose
 *  no_match / list / single. Operators (admin/authorized) get the FULL list of
 *  matches so an emergency search never dead-ends on "send more"; the public is
 *  still asked to narrow, to avoid dumping many people's names into a group. */
function finalize(records: CaseRecord[], ctx: ResolveCtx, query?: string): QueryResult {
  const recs = ctx.canSeeSensitive ? records : records.filter((r) => !isHiddenFromPublic(r));
  if (recs.length === 0) return { kind: 'no_match' };
  if (recs.length === 1) {
    return { kind: 'match', record: redactSensitiveFields(recs[0], ctx.canSeeSensitive), detail: 'summary' };
  }
  if (ctx.role !== 'public') {
    return { kind: 'list', records: recs.map((r) => redactSensitiveFields(r, ctx.canSeeSensitive)), query };
  }
  return { kind: 'multiple', count: recs.length };
}

export const telegram = new Hono<{ Bindings: BotEnv }>();

// Health/status — no secrets, safe to expose. Confirms whether the bot is armed.
telegram.get('/health', async (c) => {
  const cfg = readTelegramConfig(c.env);
  return c.json({
    ok: true,
    configured: Boolean(cfg),
    groups: cfg?.allowedGroupIds.length ?? 0,
    admins: cfg?.adminUserIds.length ?? 0,
    ai: Boolean(c.env.AI),
    commands_version: await getRegisteredVersion(c.env),
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
  if (!msg) return c.json({ ok: true });

  // Opportunistic: register/refresh the BotFather command menu once per version.
  // KV-guarded (a cheap read on the hot path); fires the Telegram calls only when
  // COMMANDS_VERSION changes, so the menu self-installs on the first message
  // after a deploy without waiting for the cron.
  c.executionCtx.waitUntil(syncBotCommands(c.env, cfg));

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

  // 4. Abuse / rate limiting (per hashed user). Operators (admin/authorized) are
  //    trusted and NEVER throttled — emergency searches must not be blocked. The
  //    burst/scraping limits only apply to ordinary group members.
  if (role === 'public') {
    const abuse = await checkAbuse(c.env, userHash);
    if (abuse.scraping) {
      await auditTelegram(c.env, { event: 'abuse_suspected', chatId, chatType, userHash });
      for (const adminId of cfg.adminUserIds) {
        await sendMessage(token, adminId, `⚠️ SISMO911 bot: patrón de scraping detectado (usuario ${userHash}, chat ${chatId}).`);
      }
    }
    if (abuse.throttled) {
      await auditTelegram(c.env, { event: 'rate_limited', chatId, chatType, userHash });
      await sendMessage(token, chatId, buildTelegramResponse({ kind: 'rate_limited', retryAfterSec: abuse.retryAfterSec }, { lang: 'es', role, canSeeSensitive }));
      return c.json({ ok: true });
    }
  }

  // 4.5 Media intake: a photo or PDF/image document runs the extraction pipeline
  //     (download → Workers-AI OCR → structure → match existing case or create a
  //     pending DRAFT → notify operator + reply). Handled in the background so we
  //     ack Telegram immediately; the sender is answered via the Bot API.
  if (isIntakeMessage(msg)) {
    await auditTelegram(c.env, { event: 'query', chatId, chatType, userHash, command: 'intake', resultKind: 'intake' });
    c.executionCtx.waitUntil(handleIntake(c.env, cfg, msg));
    return c.json({ ok: true });
  }

  // Everything past here is a text query; ack non-text, non-media updates.
  if (!msg.text) return c.json({ ok: true });

  // Admin-only: force-reinstall the BotFather command menu on demand.
  if (/^\/(menu|comandos_menu|registrar_comandos|setup_menu)\b/i.test(msg.text) && role === 'admin') {
    const res = await syncBotCommands(c.env, cfg, { force: true });
    const reply = res.ok
      ? `✅ Menú de comandos reinstalado (v${res.version}, ${res.admins} operador(es)). Cierra y reabre el chat para verlo.`
      : '⚠️ No pude reinstalar el menú de comandos. Revisa el token del bot.';
    c.executionCtx.waitUntil(sendMessages(token, chatId, [reply]));
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
        cmd.partialName = cmd.name.replace(/\s+/g, '').length < 3;
      }
    }
  }

  // 5.5 Operator WRITE path: /actualizar edits an existing case. Authorized here
  //     (role !== 'public'; aprobar/rechazar require admin) and again in
  //     resolveUpdate. Never runs against public/hospital registries. Audited.
  if (cmd.kind === 'actualizar') {
    const actor = `tg:${userId ?? 'anon'}`;
    const upd = await resolveUpdate(c.env, cmd, { role, actor });
    await auditTelegram(c.env, {
      event: 'query',
      chatId,
      chatType,
      userHash,
      command: 'actualizar',
      resultKind: upd.kind,
    });
    const text = buildUpdateResponse(upd, { lang: cmd.lang, role, canSeeSensitive });
    c.executionCtx.waitUntil(sendMessages(token, chatId, [text]));
    return c.json({ ok: true });
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
    resultCount:
      result.kind === 'multiple' ? result.count
      : result.kind === 'list' ? result.records.length
      : result.kind === 'match' ? 1
      : 0,
    queryHash: fp,
  });

  // 8. Anti-spam guard for groups: stay silent on non-actionable replies to
  //    messages that were NOT explicitly addressed to the bot (no slash command,
  //    no @-mention). Without this, if Telegram privacy mode were ever turned
  //    off, the bot would answer "no record found" to every message in a busy
  //    emergency group. Greetings/help and real matches are always sent.
  const isGroup = chatType === 'group' || chatType === 'supergroup';
  const addressed = /^\s*\//.test(msg.text) || msg.text.includes('@');
  const quietKinds = new Set(['no_match', 'bad_input', 'need_more', 'multiple', 'error']);
  if (isGroup && !addressed && quietKinds.has(result.kind)) {
    return c.json({ ok: true });
  }

  // 9. Reply. An operator list is sent as multiple self-numbered messages (each
  //    restarts at 1) with its own «query» — N (parte i/total) header); everything
  //    else is a single message. Sent in the background (waitUntil) so we ack
  //    Telegram immediately and it doesn't retry.
  const baseUrl = c.env.PUBLIC_BASE_URL || 'https://sismo911.com';
  const opts = { lang: cmd.lang, role, canSeeSensitive, baseUrl };
  const msgs =
    result.kind === 'list'
      ? buildListMessages(result.records, opts, result.query)
      : [buildTelegramResponse(result, opts)];
  c.executionCtx.waitUntil(sendMessages(token, chatId, msgs));
  return c.json({ ok: true });
});
