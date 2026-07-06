// SISMO911 — operator review API for Telegram photo/PDF intake submissions.
// ---------------------------------------------------------------------------
// The Telegram intake bot (src/telegram/intake/) drops every submission into
// `intake_submissions` and, when it can, a DRAFT persona + pending case_intel
// lead. Nothing is public until an operator acts here. Mounted at
// /api/admin/intake; every route is gated by ops:console.
//
// Actions:
//   • approve → publish the draft persona (moderation='approved') + verify the
//     lead; submission → 'approved'.
//   • reject  → hide the draft persona (moderation='rejected') + dismiss the
//     lead; submission → 'rejected'.
//   • link    → attach the submission to an EXISTING case (verified lead); if it
//     had created its own draft, that draft is rejected to avoid a duplicate.

import { Hono } from 'hono';
import type { Env } from '../types';
import { requirePermission, currentUser } from '../rbac/middleware';
import { audit } from '../lib/audit';
import { uid } from '../lib/db';
import { summarize } from '../telegram/intake/persist';
import { createBulkJob, processBulkJob } from '../bulk/import-job';
import { DOCX_MIME } from '../telegram/intake/docx';
import type { ExtractedRecord } from '../telegram/intake/types';

export const adminIntake = new Hono<{ Bindings: Env }>();

const OPEN_OUTCOMES = ['created', 'needs_review', 'matched', 'error'];

interface Row {
  id: string;
  channel: string;
  tg_username: string | null;
  tg_user_id: string | null;
  mime: string | null;
  r2_key: string | null;
  outcome: string;
  person_id: string | null;
  intel_id: string | null;
  match_score: number | null;
  note: string | null;
  extracted_json: string | null;
  created_ms: number;
  person_nombre?: string | null;
  person_moderation?: string | null;
}

const EMPTY: ExtractedRecord = { nombre: null, cedula: null, edad: null, ubicacion: null, fecha: null, contacto: null, descripcion: null };

function parseFields(raw: string | null): ExtractedRecord {
  if (!raw) return { ...EMPTY };
  try {
    return { ...EMPTY, ...(JSON.parse(raw) as Partial<ExtractedRecord>) };
  } catch {
    return { ...EMPTY };
  }
}

function code(id: string): string {
  return `ITK-${id.replace(/^itk_/, '').toUpperCase()}`;
}

function dto(r: Row) {
  const fields = parseFields(r.extracted_json);
  return {
    id: r.id,
    code: code(r.id),
    channel: r.channel,
    from: r.tg_username ? `@${r.tg_username}` : r.tg_user_id ? `tg:${r.tg_user_id}` : '—',
    mime: r.mime,
    is_image: !!r.mime && r.mime.startsWith('image/'),
    outcome: r.outcome,
    person_id: r.person_id,
    intel_id: r.intel_id,
    match_score: r.match_score,
    note: r.note,
    fields,
    display_name: r.person_nombre || fields.nombre || null,
    person_moderation: r.person_moderation ?? null,
    // Draft personas are served at /api/familia/photo/:id; strip the fam- prefix.
    person_photo_url: r.person_id?.startsWith('fam-') ? `/api/familia/photo/${r.person_id.slice(4)}` : null,
    created_ms: r.created_ms,
  };
}

/** GET /api/admin/intake?status= — review queue (open outcomes by default). */
adminIntake.get('/', requirePermission('ops:console'), async (c) => {
  const status = (c.req.query('status') || '').trim();
  const where = status ? 'WHERE s.outcome = ?' : `WHERE s.outcome IN (${OPEN_OUTCOMES.map(() => '?').join(',')})`;
  const binds: unknown[] = status ? [status] : OPEN_OUTCOMES;
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.channel, s.tg_username, s.tg_user_id, s.mime, s.r2_key, s.outcome, s.person_id,
            s.intel_id, s.match_score, s.note, s.extracted_json, s.created_ms,
            p.nombre AS person_nombre, p.moderation AS person_moderation
       FROM intake_submissions s
       LEFT JOIN personas p ON ('fam-' || p.id) = s.person_id
       ${where}
      ORDER BY s.created_ms DESC LIMIT 200`,
  )
    .bind(...binds)
    .all<Row>();
  return c.json({ submissions: (results ?? []).map(dto) });
});

// --- Bulk roster importer (padrón / expediente PDF → many draft cases) --------
// Registered BEFORE '/:id' so 'bulk' is never captured as a submission id.

const MAX_BULK_BYTES = 60 * 1024 * 1024; // console has no Telegram 20 MB cap; bound to a sane 60 MB.

interface BulkJobDto {
  id: string;
  code: string;
  source: string;
  status: string;
  file_name: string | null;
  total_records: number | null;
  created_records: number;
  matched_records: number;
  needs_review_records: number;
  error_records: number;
  note: string | null;
  created_ms: number;
  updated_ms: number;
}

/** POST /api/admin/intake/bulk — upload a roster PDF/DOCX (no 20 MB cap). Processes in the background. */
adminIntake.post('/bulk', requirePermission('ops:console'), async (c) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  // Duck-typed: a Blob-like FormData entry (File isn't a typed global in Workers types).
  if (!file || typeof file === 'string' || typeof (file as Blob).arrayBuffer !== 'function') {
    return c.json({ error: 'no_file', hint: 'Envía un PDF o Word (.docx) en el campo "file".' }, 400);
  }
  const blob = file as Blob & { name?: string };
  const mime = blob.type || 'application/pdf';
  if (mime !== 'application/pdf' && mime !== DOCX_MIME) {
    return c.json({ error: 'pdf_or_docx_only', hint: 'Solo se aceptan archivos PDF o Word (.docx).' }, 400);
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!bytes.byteLength) return c.json({ error: 'empty_file' }, 400);
  if (bytes.byteLength > MAX_BULK_BYTES) return c.json({ error: 'too_large', hint: 'Máximo 60 MB.' }, 413);

  const who = currentUser(c)?.email ?? currentUser(c)?.id ?? 'operador';
  const job = await createBulkJob(c.env, { source: 'console', mime, bytes, fileName: blob.name || 'padron.pdf', submittedBy: who });
  c.executionCtx.waitUntil(processBulkJob(c.env, job.jobId).catch(() => {}));
  await audit(c, 'intake.bulk.upload', { jobId: job.jobId, code: job.code, bytes: bytes.byteLength });
  return c.json({ ok: true, jobId: job.jobId, code: job.code });
});

/** GET /api/admin/intake/bulk — recent roster jobs. */
adminIntake.get('/bulk', requirePermission('ops:console'), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, code, source, status, file_name, total_records, created_records, matched_records,
            needs_review_records, error_records, note, created_ms, updated_ms
       FROM bulk_import_jobs ORDER BY created_ms DESC LIMIT 50`,
  ).all<BulkJobDto>();
  return c.json({ jobs: results ?? [] });
});

/** GET /api/admin/intake/bulk/:id — one job's live status (by job id or IMP- code). */
adminIntake.get('/bulk/:id', requirePermission('ops:console'), async (c) => {
  const key = c.req.param('id');
  const job = await c.env.DB.prepare(
    `SELECT id, code, source, status, file_name, total_records, created_records, matched_records,
            needs_review_records, error_records, note, created_ms, updated_ms
       FROM bulk_import_jobs WHERE id = ? OR code = ? LIMIT 1`,
  )
    .bind(key, key.toUpperCase())
    .first<BulkJobDto>();
  if (!job) return c.json({ error: 'not_found' }, 404);
  return c.json({ job });
});

/** GET /api/admin/intake/:id — single submission (with live lead status). */
adminIntake.get('/:id', requirePermission('ops:console'), async (c) => {
  const r = await loadRow(c.env, c.req.param('id'));
  if (!r) return c.json({ error: 'not_found' }, 404);
  let intelStatus: string | null = null;
  if (r.intel_id) {
    const i = await c.env.DB.prepare(`SELECT status FROM case_intel WHERE id = ?`).bind(r.intel_id).first<{ status: string }>();
    intelStatus = i?.status ?? null;
  }
  return c.json({ submission: { ...dto(r), intel_status: intelStatus } });
});

/** GET /api/admin/intake/:id/evidence — stream the raw file (image inline / PDF download). */
adminIntake.get('/:id/evidence', requirePermission('ops:console'), async (c) => {
  const r = await loadRow(c.env, c.req.param('id'));
  if (!r?.r2_key) return c.notFound();
  const obj = await c.env.PERSON_PHOTOS.get(r.r2_key);
  if (!obj) return c.notFound();
  const ct = obj.httpMetadata?.contentType || r.mime || 'application/octet-stream';
  return new Response(obj.body, {
    headers: {
      'Content-Type': ct,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(ct === 'application/pdf' ? { 'Content-Disposition': `inline; filename="${code(r.id)}.pdf"` } : {}),
    },
  });
});

/** POST /api/admin/intake/:id/approve — publish draft + verify lead. */
adminIntake.post('/:id/approve', requirePermission('ops:console'), async (c) => {
  const r = await loadRow(c.env, c.req.param('id'));
  if (!r) return c.json({ error: 'not_found' }, 404);
  const now = Date.now();
  const who = currentUser(c)?.email ?? currentUser(c)?.id ?? 'operador';

  if (r.person_id?.startsWith('fam-')) {
    await c.env.DB.prepare(`UPDATE personas SET moderation='approved', updated_at=? WHERE id=? AND moderation<>'rejected'`)
      .bind(now, r.person_id.slice(4))
      .run();
  }
  if (r.intel_id) {
    await c.env.DB.prepare(`UPDATE case_intel SET status='verified', updated_ms=? WHERE id=?`).bind(now, r.intel_id).run();
  }
  await c.env.DB.prepare(`UPDATE intake_submissions SET outcome='approved', note=? WHERE id=?`)
    .bind(`Aprobado por ${who}`, r.id)
    .run();
  await audit(c, 'intake.approve', { id: r.id, code: code(r.id), person_id: r.person_id });
  return c.json({ ok: true });
});

/** POST /api/admin/intake/:id/reject — hide draft + dismiss lead. */
adminIntake.post('/:id/reject', requirePermission('ops:console'), async (c) => {
  const r = await loadRow(c.env, c.req.param('id'));
  if (!r) return c.json({ error: 'not_found' }, 404);
  const now = Date.now();
  const who = currentUser(c)?.email ?? currentUser(c)?.id ?? 'operador';

  // Only reject a persona this submission itself created (a pending draft) — never
  // an already-approved existing case that a match happened to point at.
  if (r.person_id?.startsWith('fam-') && r.person_moderation === 'pending') {
    await c.env.DB.prepare(`UPDATE personas SET moderation='rejected', updated_at=? WHERE id=? AND moderation='pending'`)
      .bind(now, r.person_id.slice(4))
      .run();
  }
  if (r.intel_id) {
    await c.env.DB.prepare(`UPDATE case_intel SET status='dismissed', updated_ms=? WHERE id=?`).bind(now, r.intel_id).run();
  }
  await c.env.DB.prepare(`UPDATE intake_submissions SET outcome='rejected', note=? WHERE id=?`)
    .bind(`Rechazado por ${who}`, r.id)
    .run();
  await audit(c, 'intake.reject', { id: r.id, code: code(r.id), person_id: r.person_id });
  return c.json({ ok: true });
});

/** POST /api/admin/intake/:id/link {personId} — attach to an EXISTING case. */
adminIntake.post('/:id/link', requirePermission('ops:console'), async (c) => {
  const r = await loadRow(c.env, c.req.param('id'));
  if (!r) return c.json({ error: 'not_found' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { personId?: string };
  const target = String(body.personId || '').trim();
  if (!/^fam-[A-Za-z0-9_]+$/.test(target)) return c.json({ error: 'bad_person_id', hint: 'Usa el formato fam-<id>.' }, 400);

  const exists = await c.env.DB.prepare(`SELECT id, nombre FROM personas WHERE id = ?`).bind(target.slice(4)).first<{ id: string; nombre: string }>();
  if (!exists) return c.json({ error: 'person_not_found' }, 404);

  const now = Date.now();
  const who = currentUser(c)?.email ?? currentUser(c)?.id ?? 'operador';
  const fields = parseFields(r.extracted_json);
  const detail = `${summarize(fields)}\n\n[Evidencia Telegram: ${r.r2_key ?? '—'}]\n[Vinculado por ${who}]`.slice(0, 2000);
  const intelId = uid('intl');
  await c.env.DB.prepare(
    `INSERT INTO case_intel (id, person_id, type, url, platform, title, detail, lat, lon, source, status, submitted_by, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(intelId, target, 'doc', null, 'telegram', 'Documento vinculado desde intake', detail, null, null, 'operator', 'verified', who, now, now)
    .run();

  // If this submission had created its own draft persona, reject it (avoid a duplicate).
  if (r.person_id?.startsWith('fam-') && r.person_id !== target && r.person_moderation === 'pending') {
    await c.env.DB.prepare(`UPDATE personas SET moderation='rejected', updated_at=? WHERE id=? AND moderation='pending'`)
      .bind(now, r.person_id.slice(4))
      .run();
  }

  await c.env.DB.prepare(`UPDATE intake_submissions SET person_id=?, intel_id=?, outcome='approved', note=? WHERE id=?`)
    .bind(target, intelId, `Vinculado a ${exists.nombre} por ${who}`, r.id)
    .run();
  await audit(c, 'intake.link', { id: r.id, code: code(r.id), person_id: target });
  return c.json({ ok: true, person_id: target });
});

async function loadRow(env: Env, id: string): Promise<Row | null> {
  return env.DB.prepare(
    `SELECT s.id, s.channel, s.tg_username, s.tg_user_id, s.mime, s.r2_key, s.outcome, s.person_id,
            s.intel_id, s.match_score, s.note, s.extracted_json, s.created_ms,
            p.nombre AS person_nombre, p.moderation AS person_moderation
       FROM intake_submissions s
       LEFT JOIN personas p ON ('fam-' || p.id) = s.person_id
      WHERE s.id = ?`,
  )
    .bind(id)
    .first<Row>();
}
