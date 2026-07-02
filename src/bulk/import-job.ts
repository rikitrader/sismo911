// SISMO911 — bulk roster importer (parent job orchestration).
// ---------------------------------------------------------------------------
// A multi-name PDF (padrón / expediente) is turned into MANY normal intake
// submissions — one DRAFT persona + pending case_intel lead each — so the whole
// batch flows into the EXISTING operator review queue (/api/admin/intake).
// Nothing is public until an operator approves it, exactly like single intake.
//
// Flow:
//   createBulkJob()  → store the PDF in R2, insert a `pending` job, return code.
//   processBulkJob() → claim (pending→processing), OCR+extract the roster list,
//                      match/create each person via the shared persist(), tally,
//                      mark done. Safe to run inside ctx.waitUntil().
//   sweepBulkJobs()  → cron backstop: start `pending` jobs that never ran and
//                      flag long-stuck `processing` jobs as error (no auto-retry,
//                      so a partial run can't create duplicate drafts).

import type { Env } from '../types';
import { uid } from '../lib/db';
import { extractRoster } from '../telegram/intake/roster';
import { matchCase } from '../telegram/intake/match';
import { persist } from '../telegram/intake/persist';
import { parseIdList } from '../telegram/env';
import type { IntakeMedia } from '../telegram/intake/types';

const R2_PREFIX = 'intake/bulk';
const STUCK_MS = 15 * 60 * 1000; // a job 'processing' longer than this is treated as stuck.
const PENDING_GRACE_MS = 90 * 1000; // start a 'pending' job only after the ingest tick had time to run it.

export interface BulkJobInput {
  source: 'telegram' | 'console';
  mime: string;
  bytes: Uint8Array;
  fileName: string;
  chatId?: string | null;
  submittedBy?: string | null;
  tgUserId?: string | null;
}

export interface BulkJobRef {
  jobId: string;
  code: string;
  r2Key: string;
}

export interface BulkSummary {
  jobId: string;
  code: string;
  status: string;
  total: number;
  created: number;
  matched: number;
  needsReview: number;
  errors: number;
}

interface JobRow {
  id: string;
  code: string;
  source: string;
  status: string;
  r2_key: string | null;
  mime: string | null;
  file_name: string | null;
  chat_id: string | null;
  submitted_by: string | null;
  tg_user_id: string | null;
}

/** Store the source PDF and register a pending job. */
export async function createBulkJob(env: Env, input: BulkJobInput): Promise<BulkJobRef> {
  const jobId = uid('bik');
  const code = `IMP-${jobId.slice(4).toUpperCase()}`;
  const r2Key = `${R2_PREFIX}/${jobId}.pdf`;
  const now = Date.now();
  await env.PERSON_PHOTOS.put(r2Key, input.bytes, { httpMetadata: { contentType: input.mime } }).catch(() => {});
  await env.DB.prepare(
    `INSERT INTO bulk_import_jobs (id, code, source, status, r2_key, mime, file_name, chat_id, submitted_by, tg_user_id, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(jobId, code, input.source, 'pending', r2Key, input.mime, input.fileName.slice(0, 160), input.chatId ?? null, input.submittedBy ?? null, input.tgUserId ?? null, now, now)
    .run();
  return { jobId, code, r2Key };
}

/** Process one job end-to-end. Returns null if the job wasn't claimable. Never throws. */
export async function processBulkJob(env: Env, jobId: string): Promise<BulkSummary | null> {
  const claimedAt = Date.now();
  // Atomically claim: only one worker moves it pending→processing.
  const claim = await env.DB.prepare(`UPDATE bulk_import_jobs SET status='processing', updated_ms=? WHERE id=? AND status='pending'`)
    .bind(claimedAt, jobId)
    .run()
    .catch(() => null);
  if (!claim || (claim.meta?.changes ?? 0) === 0) return null;

  const job = await env.DB.prepare(
    `SELECT id, code, source, status, r2_key, mime, file_name, chat_id, submitted_by, tg_user_id FROM bulk_import_jobs WHERE id=?`,
  )
    .bind(jobId)
    .first<JobRow>();
  if (!job) return null;

  let created = 0;
  let matched = 0;
  let needsReview = 0;
  let errors = 0;
  let total = 0;

  try {
    const obj = job.r2_key ? await env.PERSON_PHOTOS.get(job.r2_key) : null;
    if (!obj) throw new Error('evidence_missing');
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const media: IntakeMedia = {
      fileId: `bulk:${jobId}`,
      mime: job.mime || 'application/pdf',
      fileName: job.file_name || 'padron.pdf',
      bytes,
    };

    const records = await extractRoster(env, media);
    total = records.length;

    const channel = job.source === 'console' ? 'console' : 'telegram';
    // Per-person media carries no bytes (evidence is the shared roster PDF at job.r2_key).
    const lightMedia: IntakeMedia = { ...media, bytes: new Uint8Array() };

    // A roster sent by a Telegram ADMIN publishes immediately (no operator
    // approval step) — same rule as the single-photo intake. Console uploads
    // keep the review queue (its UI exists precisely to vet bulk OCR output).
    const adminIds = parseIdList((env as Env & { ADMIN_TELEGRAM_USER_IDS?: string }).ADMIN_TELEGRAM_USER_IDS);
    const autoApprove = job.source !== 'console' && !!job.tg_user_id && adminIds.includes(job.tg_user_id);

    for (const fields of records) {
      const submissionId = uid('itk');
      const code = `ITK-${submissionId.slice(4).toUpperCase()}`;
      const match = await matchCase(env, fields);
      const r = await persist(env, {
        submissionId,
        code,
        media: lightMedia,
        fields,
        match,
        tgUserId: job.tg_user_id,
        tgUsername: null,
        tgChatId: job.chat_id,
        channel,
        batchId: jobId,
        rawKey: job.r2_key ?? undefined,
        autoApprove,
      });
      if (r.outcome === 'matched') matched++;
      else if (r.outcome === 'created') created++;
      else if (r.outcome === 'error') errors++;
      else needsReview++;
    }

    const note =
      total === 0
        ? 'No se leyeron nombres del documento.'
        : `${total} nombres → ${created} borradores, ${matched} coincidencias, ${needsReview} para revisión${errors ? `, ${errors} con error` : ''}.`;
    await env.DB.prepare(
      `UPDATE bulk_import_jobs SET status='done', total_records=?, created_records=?, matched_records=?, needs_review_records=?, error_records=?, note=?, updated_ms=? WHERE id=?`,
    )
      .bind(total, created, matched, needsReview, errors, note, Date.now(), jobId)
      .run()
      .catch(() => {});
  } catch (e) {
    await env.DB.prepare(`UPDATE bulk_import_jobs SET status='error', note=?, updated_ms=? WHERE id=?`)
      .bind(`Error al procesar: ${(e as Error)?.message ?? 'desconocido'}`.slice(0, 300), Date.now(), jobId)
      .run()
      .catch(() => {});
    return { jobId, code: job.code, status: 'error', total, created, matched, needsReview, errors };
  }

  return { jobId, code: job.code, status: 'done', total, created, matched, needsReview, errors };
}

/**
 * Cron backstop. Two duties:
 *   • start `pending` jobs older than the grace window (their ingest tick died
 *     before waitUntil ran the processor);
 *   • flag `processing` jobs stuck past STUCK_MS as `error` so operators see them
 *     (never auto-retried — a partial run must not create duplicate drafts).
 */
export async function sweepBulkJobs(env: Env): Promise<{ started: number; failed: number }> {
  const now = Date.now();
  let started = 0;
  let failed = 0;

  const { results: stuck } = await env.DB.prepare(
    `SELECT id FROM bulk_import_jobs WHERE status='processing' AND updated_ms < ? LIMIT 20`,
  )
    .bind(now - STUCK_MS)
    .all<{ id: string }>();
  for (const row of stuck ?? []) {
    await env.DB.prepare(`UPDATE bulk_import_jobs SET status='error', note='Procesamiento interrumpido (reiniciar desde consola).', updated_ms=? WHERE id=? AND status='processing'`)
      .bind(now, row.id)
      .run()
      .catch(() => {});
    failed++;
  }

  const { results: pending } = await env.DB.prepare(
    `SELECT id FROM bulk_import_jobs WHERE status='pending' AND created_ms < ? ORDER BY created_ms ASC LIMIT 3`,
  )
    .bind(now - PENDING_GRACE_MS)
    .all<{ id: string }>();
  for (const row of pending ?? []) {
    const res = await processBulkJob(env, row.id).catch(() => null);
    if (res) started++;
  }

  return { started, failed };
}
