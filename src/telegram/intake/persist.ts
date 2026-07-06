// SISMO911 — Telegram intake: store evidence + write the case link.
// ---------------------------------------------------------------------------
// Outcomes (all held for operator review — nothing is public automatically):
//   • matched      → attach a pending `case_intel` lead to the existing case.
//   • created      → new DRAFT persona (moderation='pending', origen='telegram')
//                    + a pending `case_intel` lead. Photo (if any) is served via
//                    the existing /api/familia/photo/:id path (DESAP_FOTOS).
//   • needs_review → no name and no cédula extracted; keep only the raw evidence
//                    + ledger row for an operator to triage manually.
// Every submission is recorded in `intake_submissions` regardless of outcome.

import type { Env } from '../../types';
import { uid } from '../../lib/db';
import { computeSearchFields } from '../../lib/search-index';
import type { ExtractedRecord, IntakeMedia, IntakeResult, MatchResult } from './types';
import { DOCX_MIME } from './docx';

const RAW_BUCKET_PREFIX = 'intake/telegram';

function extFor(mime: string): string {
  if (mime === 'application/pdf') return 'pdf';
  if (mime === DOCX_MIME) return 'docx';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

/** One-line Spanish summary of the extracted fields (for the lead detail + alert). */
export function summarize(f: ExtractedRecord): string {
  const parts: string[] = [];
  if (f.nombre) parts.push(`Nombre: ${f.nombre}`);
  if (f.cedula) parts.push(`Cédula: ${f.cedula}`);
  if (f.edad != null) parts.push(`Edad: ${f.edad}`);
  if (f.ubicacion) parts.push(`Ubicación: ${f.ubicacion}`);
  if (f.fecha) parts.push(`Fecha: ${f.fecha}`);
  if (f.contacto) parts.push(`Contacto: ${f.contacto}`);
  if (f.descripcion) parts.push(`Descripción: ${f.descripcion}`);
  return parts.join(' · ') || 'Sin datos legibles.';
}

interface PersistInput {
  submissionId: string;
  code: string;
  media: IntakeMedia;
  fields: ExtractedRecord;
  match: MatchResult;
  tgUserId: string | null;
  tgUsername: string | null;
  tgChatId: string | null;
  // Bulk-roster extensions (single-person path leaves these unset → same behavior):
  channel?: string; // ledger channel: 'telegram' (default) | 'console'
  batchId?: string | null; // parent bulk_import_jobs.id when this row is one of many
  rawKey?: string; // shared evidence key (the roster PDF) — skip the per-row R2 upload
  // ADMIN submitter: publish immediately (persona approved, lead verified,
  // ledger outcome 'approved') instead of holding for operator review.
  autoApprove?: boolean;
}

/** Insert a citizen lead for a case ('pending', or 'verified' for an admin
 *  auto-approved submission). Returns the intel id. */
async function insertLead(env: Env, personId: string, f: ExtractedRecord, submittedBy: string | null, evidenceKey: string, now: number, status: 'pending' | 'verified' = 'pending'): Promise<string> {
  const intelId = uid('intl');
  const detail = `${summarize(f)}\n\n[Evidencia Telegram: ${evidenceKey}]`.slice(0, 2000);
  await env.DB.prepare(
    `INSERT INTO case_intel (id, person_id, type, url, platform, title, detail, lat, lon, source, status, submitted_by, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(intelId, personId, 'doc', null, 'telegram', 'Documento recibido por Telegram', detail, null, null, status === 'verified' ? 'operator' : 'citizen', status, submittedBy, now, now)
    .run();
  return intelId;
}

/**
 * Persist the submission. Never throws — on a DB error it returns outcome
 * 'error' with the evidence still stored where possible.
 */
export async function persist(env: Env, input: PersistInput): Promise<IntakeResult> {
  const { submissionId, code, media, fields, match } = input;
  const now = Date.now();
  const channel = input.channel ?? 'telegram';
  const submittedBy = input.tgUsername ? `@${input.tgUsername}` : input.tgUserId ? `tg:${input.tgUserId}` : null;

  // Raw evidence copy (audit). Roster records pass a shared `rawKey` (the one
  // uploaded padrón PDF) so we don't re-upload the whole document per person;
  // the single-person path uploads its own bytes as before.
  const rawKey = input.rawKey ?? `${RAW_BUCKET_PREFIX}/${submissionId}.${extFor(media.mime)}`;
  if (!input.rawKey) {
    await env.PERSON_PHOTOS.put(rawKey, media.bytes, { httpMetadata: { contentType: media.mime } }).catch(() => {});
  }

  const autoApprove = !!input.autoApprove;
  let outcome: IntakeResult['outcome'] = 'needs_review';
  let personId: string | null = null;
  let intelId: string | null = null;
  let note = 'Sin nombre ni cédula legibles — enviado a revisión de un operador.';

  try {
    if (match.personId) {
      // Attach to the existing case.
      personId = match.personId;
      intelId = await insertLead(env, personId, fields, submittedBy, rawKey, now, autoApprove ? 'verified' : 'pending');
      outcome = 'matched';
      note = autoApprove
        ? `Coincide con un caso existente. Lead verificado automáticamente (envío de administrador).`
        : match.reason === 'cedula'
          ? `Coincide por cédula con un caso existente. Lead pendiente de verificación.`
          : `Posible coincidencia por nombre (${Math.round(match.score * 100)}%). Lead pendiente de verificación.`;
    } else if (fields.nombre) {
      // No match but we have a name → create a DRAFT persona for operator review.
      const pid = uid('pc');
      const isImage = media.mime.startsWith('image/');
      let fotoR2: string | null = null;
      if (isImage) {
        fotoR2 = `fotos/${pid}.jpg`;
        await env.DESAP_FOTOS.put(fotoR2, media.bytes, { httpMetadata: { contentType: media.mime } }).catch(() => {
          fotoR2 = null;
        });
      }
      const sf = computeSearchFields(fields.nombre, fields.ubicacion);
      await env.DB.prepare(
        `INSERT INTO personas (id, nombre, edad, ubicacion, descripcion, contacto, foto_r2, estado, moderation, origen, name_norm, geo_estado, geo_municipio, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
        .bind(
          pid,
          fields.nombre.slice(0, 120),
          fields.edad,
          fields.ubicacion ?? '',
          fields.descripcion ?? '',
          fields.contacto ?? '',
          fotoR2,
          'sin-contacto',
          autoApprove ? 'approved' : 'pending',
          'telegram',
          sf.name_norm,
          sf.geo_estado,
          sf.geo_municipio,
          now,
          now,
        )
        .run();
      personId = `fam-${pid}`;
      intelId = await insertLead(env, personId, fields, submittedBy, rawKey, now, autoApprove ? 'verified' : 'pending');
      outcome = 'created';
      note = autoApprove
        ? 'Caso creado y PUBLICADO de inmediato (envío de administrador).'
        : 'Nuevo caso BORRADOR creado (sin verificar). Un operador lo revisará antes de publicarlo.';
    }
  } catch (e) {
    outcome = 'error';
    note = 'Error al guardar. La evidencia se conservó; un operador revisará.';
    console.warn('[tg-intake] persist failed', submissionId, (e as Error)?.message ?? e);
  }

  // Ledger row (always). An admin auto-approved submission is recorded as
  // 'approved' (same value the /aprobar flow writes) so it never appears in
  // the operator review queue (OPEN_OUTCOMES).
  const autoApproved = autoApprove && (outcome === 'created' || outcome === 'matched');
  await env.DB.prepare(
    `INSERT INTO intake_submissions (id, channel, tg_user_id, tg_username, tg_chat_id, file_id, mime, r2_key, extracted_json, match_score, outcome, person_id, intel_id, note, batch_id, created_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      submissionId,
      channel,
      input.tgUserId,
      input.tgUsername,
      input.tgChatId,
      media.fileId,
      media.mime,
      rawKey,
      JSON.stringify(fields),
      match.personId ? match.score : null,
      autoApproved ? 'approved' : outcome,
      personId,
      intelId,
      note,
      input.batchId ?? null,
      now,
    )
    .run()
    .catch((e) => console.warn('[tg-intake] ledger insert failed', submissionId, (e as Error)?.message ?? e));

  return { submissionId, code, outcome, personId, intelId, fields, score: match.score, note, autoApproved };
}
