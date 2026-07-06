// SISMO911 — Telegram intake: pasted-text rosters with preview + confirm.
// ---------------------------------------------------------------------------
// A sender can paste a LIST of names as a plain message (e.g. "1 ALEXIS
// RODRÍGUEZ · 9 años" × 100). Unlike file intake, NOTHING is persisted on
// receipt: the bot parses the list, checks every person against the DB
// (cédula exact + fuzzy name via matchCase), and replies with the mapping —
// how many are new, how many look like existing cases (possible duplicates,
// with their case ids). Cases are created only after the sender replies
// /confirmar LOT-XXXX; /cancelar LOT-XXXX discards. Batches live in KV for
// one hour, keyed to the chat that submitted them.
//
// Parsing is deterministic first ("N NAME · E años" lines — zero AI calls);
// the AI chunk extractor is only a fallback when the list has another shape.

import type { Env } from '../../types';
import type { TelegramConfig } from '../env';
import type { TelegramMessage } from '../types';
import type { ExtractedRecord, MatchResult } from './types';
import type { IntakeMedia } from './types';
import { extractRosterFromText } from './roster';
import { matchCase } from './match';
import { persist } from './persist';
import { sendTelegram } from './notify';
import { escapeHtml } from '../responses';
import { uid } from '../../lib/db';
import { titleCaseName } from '../../lib/names';
import { normalizeName } from '../../lib/search-normalize';
import { repairAgeToken, cleanOcrName, mergeFlags } from '../../lib/ocr-normalize';

const KV_PREFIX = 'tgroster:';
const BATCH_TTL_S = 3600; // a pending batch expires after 1 hour.
const MAX_RECORDS = 500;
const MIN_ROSTER_LINES = 5; // below this, treat the text as a normal query.
const PREVIEW_DUP_LINES = 12; // duplicates listed in the preview reply.

// "1 ALEXIS RODRÍGUEZ · 9 años" | "23. MARIA PEREZ - 40" | "ACUÑA" (numbered).
// Age handling (incl. OCR'd units like "ohms") lives in src/lib/ocr-normalize.
const NUMBERED = /^\s*(\d{1,4})\s*[.)\-–·•]?\s+(.+?)\s*$/;
const NAMEISH = /^[\p{L}][\p{L}\s.'’-]{1,120}$/u;

export interface TextRosterBatch {
  code: string;
  chatId: string;
  tgUserId: string | null;
  tgUsername: string | null;
  records: ExtractedRecord[];
  duplicates: number; // matched count at preview time (informational)
  sourceText: string; // the original pasted message — stored to R2 as shared evidence on confirm
  createdMs: number;
}

const EMPTY_REC: ExtractedRecord = { nombre: null, cedula: null, edad: null, ubicacion: null, fecha: null, contacto: null, descripcion: null };

/** Parse one candidate line → record, or null when it isn't a roster row. */
export function parseRosterLine(line: string): ExtractedRecord | null {
  const numbered = line.match(NUMBERED);
  if (!numbered) return null;
  const { age, rest, repaired } = repairAgeToken(numbered[2]);
  const cleaned = cleanOcrName(rest);
  if (!cleaned.name) return null; // pure "ILEGIBLE" marker or junk-only line
  if (!NAMEISH.test(cleaned.name)) return null;
  if (!normalizeName(cleaned.name)) return null;
  const flags = mergeFlags(cleaned.flags, repaired ? ['age_unit_repaired'] : undefined);
  return {
    ...EMPTY_REC,
    nombre: titleCaseName(cleaned.name).slice(0, 140),
    edad: age,
    ...(flags.length ? { ocrFlags: flags } : {}),
  };
}

/** Deterministic parse of a pasted roster: numbered "NAME [· age]" lines. */
export function parseTextRoster(text: string): ExtractedRecord[] {
  const out: ExtractedRecord[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const rec = parseRosterLine(line);
    if (!rec?.nombre) continue;
    const key = `${normalizeName(rec.nombre)}|${rec.edad ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rec);
    if (out.length >= MAX_RECORDS) break;
  }
  return out;
}

/** True when a plain text message reads like a pasted multi-name roster. */
export function looksLikeTextRoster(text: string): boolean {
  if (!text || text.startsWith('/')) return false;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < MIN_ROSTER_LINES) return false;
  let rosterish = 0;
  for (const l of lines) if (parseRosterLine(l)) rosterish++;
  return rosterish >= MIN_ROSTER_LINES && rosterish / lines.length >= 0.5;
}

/** /confirmar LOT-XXXXXX | /cancelar LOT-XXXXXX (accents/case tolerant). */
export function parseLoteCommand(text: string): { action: 'confirmar' | 'cancelar'; code: string } | null {
  const m = text.trim().match(/^\/?(confirmar|confirm|cancelar|cancel)\s+(LOT-[A-Za-z0-9]{4,12})\s*$/i);
  if (!m) return null;
  const action = /^c(onfirmar|onfirm)$/i.test(m[1]) ? 'confirmar' : 'cancelar';
  return { action, code: m[2].toUpperCase() };
}

function kvKey(code: string): string {
  return `${KV_PREFIX}${code}`;
}

export async function saveBatch(env: Env, batch: TextRosterBatch): Promise<void> {
  await env.CACHE.put(kvKey(batch.code), JSON.stringify(batch), { expirationTtl: BATCH_TTL_S });
}

export async function loadBatch(env: Env, code: string): Promise<TextRosterBatch | null> {
  const raw = await env.CACHE.get(kvKey(code));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TextRosterBatch;
  } catch {
    return null;
  }
}

export async function deleteBatch(env: Env, code: string): Promise<void> {
  await env.CACHE.delete(kvKey(code)).catch(() => {});
}

/** Preview reply: the DB mapping + the confirm/cancel instructions. */
export function buildPreviewReply(batch: TextRosterBatch, matches: Array<{ rec: ExtractedRecord; match: MatchResult }>): string {
  const dup = matches.filter((m) => m.match.personId);
  const nuevos = matches.length - dup.length;
  const lines: string[] = [
    `📋 Detecté <b>${matches.length}</b> persona(s) en tu lista (<b>${batch.code}</b>).`,
    `• <b>${nuevos}</b> no están en la base de datos → se crearían como casos nuevos.`,
    `• <b>${dup.length}</b> coinciden con casos existentes → NO se duplican; se anexarían como actualización del caso.`,
  ];
  if (dup.length) {
    lines.push('', 'Posibles duplicados:');
    for (const d of dup.slice(0, PREVIEW_DUP_LINES)) {
      const pct = Math.round(d.match.score * 100);
      lines.push(`— ${escapeHtml(d.rec.nombre ?? '?')} ≈ caso <code>${escapeHtml(d.match.personId ?? '')}</code> (${pct}%)`);
    }
    if (dup.length > PREVIEW_DUP_LINES) lines.push(`… y ${dup.length - PREVIEW_DUP_LINES} más.`);
  }
  const flagged = matches.filter((m) => m.rec.ocrFlags?.length);
  if (flagged.length) {
    lines.push('', `⚠️ Revisar OCR (${flagged.length} — texto dudoso, irán a revisión de operador aunque confirmes):`);
    for (const f of flagged.slice(0, PREVIEW_DUP_LINES)) {
      lines.push(`— ${escapeHtml(f.rec.nombre ?? '(nombre ilegible)')} [${(f.rec.ocrFlags ?? []).join(', ')}]`);
    }
    if (flagged.length > PREVIEW_DUP_LINES) lines.push(`… y ${flagged.length - PREVIEW_DUP_LINES} más.`);
  }
  lines.push(
    '',
    `⚠️ Aún NO he creado nada. Revisa el mapeo y responde:`,
    `• <b>/confirmar ${batch.code}</b> — crear los casos`,
    `• <b>/cancelar ${batch.code}</b> — descartar la lista`,
    `La lista expira en 1 hora.`,
  );
  return lines.join('\n');
}

/**
 * Handle a pasted-list message: parse → match against the DB → store the batch
 * in KV → reply with the mapping + confirm instructions. Creates NOTHING yet.
 */
export async function handleTextRoster(env: Env, cfg: TelegramConfig, msg: TelegramMessage): Promise<void> {
  const token = cfg.botToken;
  const chatId = msg.chat.id;
  const text = msg.text ?? '';

  let records = parseTextRoster(text);
  if (records.length < 3) records = await extractRosterFromText(env, text); // odd shape → AI fallback
  if (!records.length) {
    await sendTelegram(token, chatId, 'No pude leer nombres claros en la lista. Formato esperado: una persona por línea, ej. "1 MARIA PEREZ · 40 años".');
    return;
  }

  const code = `LOT-${uid('lot').slice(4, 10).toUpperCase()}`;
  const matches: Array<{ rec: ExtractedRecord; match: MatchResult }> = [];
  for (const rec of records) matches.push({ rec, match: await matchCase(env, rec) });

  const batch: TextRosterBatch = {
    code,
    chatId: String(chatId),
    tgUserId: msg.from?.id != null ? String(msg.from.id) : null,
    tgUsername: (msg.from as { username?: string } | undefined)?.username ?? null,
    records,
    duplicates: matches.filter((m) => m.match.personId).length,
    sourceText: text.slice(0, 60000),
    createdMs: Date.now(),
  };
  await saveBatch(env, batch);
  await sendTelegram(token, chatId, buildPreviewReply(batch, matches));
}

/**
 * /confirmar — create the batch. Duplicates (matchCase hit) attach to the
 * existing case as a pending update; only unmatched people create new drafts
 * (published immediately when the confirmer is an admin, like file rosters).
 * /cancelar — discard. Both are restricted to the chat that submitted.
 */
export async function resolveLoteCommand(
  env: Env,
  cfg: TelegramConfig,
  msg: TelegramMessage,
  cmd: { action: 'confirmar' | 'cancelar'; code: string },
): Promise<string> {
  const chatId = String(msg.chat.id);
  const batch = await loadBatch(env, cmd.code);
  if (!batch) return `No encuentro la lista <b>${escapeHtml(cmd.code)}</b> (expiró, ya fue procesada, o el código no es válido).`;
  if (batch.chatId !== chatId) return `La lista <b>${escapeHtml(cmd.code)}</b> fue enviada desde otro chat; confírmala allí.`;

  if (cmd.action === 'cancelar') {
    await deleteBatch(env, cmd.code);
    return `🗑️ Lista <b>${escapeHtml(cmd.code)}</b> descartada. No se creó ningún caso.`;
  }

  // Claim before processing so a double /confirmar can't create duplicates.
  await deleteBatch(env, cmd.code);

  const confirmerId = msg.from?.id != null ? String(msg.from.id) : null;
  const autoApprove = !!confirmerId && cfg.adminUserIds.includes(confirmerId);
  const lightMedia: IntakeMedia = { fileId: `lot:${cmd.code}`, mime: 'text/plain', fileName: `${cmd.code}.txt`, bytes: new Uint8Array() };

  // Shared evidence: the original pasted list, once per batch (like the roster
  // PDF in bulk jobs). Rows carry rawKey so persist skips per-row R2 uploads.
  const rawKey = `intake/bulk/${cmd.code}.txt`;
  await env.PERSON_PHOTOS.put(rawKey, new TextEncoder().encode(batch.sourceText || ''), { httpMetadata: { contentType: 'text/plain; charset=utf-8' } }).catch(() => {});

  let created = 0;
  let matched = 0;
  let needsReview = 0;
  let errors = 0;
  for (const fields of batch.records) {
    const submissionId = uid('itk');
    const code = `ITK-${submissionId.slice(4).toUpperCase()}`;
    const match = await matchCase(env, fields);
    const r = await persist(env, {
      submissionId,
      code,
      media: lightMedia,
      fields,
      match,
      tgUserId: batch.tgUserId,
      tgUsername: batch.tgUsername,
      tgChatId: batch.chatId,
      channel: 'telegram',
      batchId: cmd.code,
      rawKey,
      autoApprove,
    });
    if (r.outcome === 'matched') matched++;
    else if (r.outcome === 'created') created++;
    else if (r.outcome === 'error') errors++;
    else needsReview++;
  }

  const tail = autoApprove
    ? 'Publicados de inmediato (nivel administrador).'
    : 'Nada es público todavía: un operador los revisará antes de publicarlos.';
  const err = errors ? ` <b>${errors}</b> con error.` : '';
  return `✅ <b>${escapeHtml(cmd.code)}</b>: ${batch.records.length} persona(s) → <b>${created}</b> caso(s) nuevo(s), <b>${matched}</b> anexada(s) a casos existentes (sin duplicar), <b>${needsReview}</b> para revisión.${err}\n${tail}`;
}
