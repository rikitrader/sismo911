import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { audit } from '../lib/audit';
import { getUserFromRequest } from '../lib/auth';
import { rateLimit } from '../lib/security';
import {
  EVIDENCE_STATUSES, ANNOTATION_SHAPES, logCustody, mintShareToken, tokenHash,
} from '../lib/evidence';

// ─────────────────────────────────────────────────────────────────────────────
// Evidence Photo Gallery — operator API.
//
// Mounted at /api/persons, so every route here is `/api/persons/:id/evidence...`
// and is gated by the SAME `persons:moderate` permission as the rest of the case
// docket (see rbac/route-policy.ts `isCaseAdmin`, which now matches `evidence`).
// No route trusts client-supplied identity; the actor comes from the session.
//
// Evidence integrity model:
//   • case_attachments rows are the evidence items; the original file in R2 is
//     immutable and its sha-256 is recorded at upload.
//   • Annotations & comments live in separate tables → the original is never
//     mutated; redaction/markup is a non-destructive overlay.
//   • Deletes are SOFT (deleted_ms) so nothing leaves the chain of custody.
//   • Every action appends a chain-of-custody event.
// ─────────────────────────────────────────────────────────────────────────────

export const evidence = new Hono<{ Bindings: Env }>();

const COMMENT_KINDS = ['general', 'internal', 'pin'];
const clip = (s: unknown, n: number) => (s == null ? null : String(s).slice(0, n));

/** Fetch a LIVE evidence item scoped to its case. Returns null if missing/deleted. */
async function getItem(env: Env, personId: string, aid: string): Promise<any | null> {
  return env.DB.prepare(
    `SELECT * FROM case_attachments WHERE id = ? AND person_id = ? AND deleted_ms IS NULL`,
  ).bind(aid, personId).first();
}

// ── Gallery list (filterable) ───────────────────────────────────────────────
// GET /api/persons/:id/evidence?kind=&status=&tag=&uploader=&q=&from=&to=&include_deleted=
evidence.get('/:id/evidence', async (c) => {
  const personId = c.req.param('id');
  const q = c.req.query();
  const where: string[] = ['person_id = ?'];
  const binds: any[] = [personId];
  if (q.include_deleted !== '1') where.push('deleted_ms IS NULL');
  if (q.kind) { where.push('kind = ?'); binds.push(q.kind); }
  if (q.status && EVIDENCE_STATUSES.includes(q.status as any)) { where.push('status = ?'); binds.push(q.status); }
  if (q.uploader) { where.push('uploaded_by = ?'); binds.push(q.uploader); }
  if (q.from) { where.push('created_ms >= ?'); binds.push(Number(q.from)); }
  if (q.to) { where.push('created_ms <= ?'); binds.push(Number(q.to)); }
  if (q.tag) { where.push('tags LIKE ?'); binds.push(`%"${String(q.tag).replace(/[%_"]/g, '')}"%`); }
  if (q.q) { where.push('(description LIKE ? OR filename LIKE ?)'); const t = `%${q.q}%`; binds.push(t, t); }
  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.kind, a.filename, a.content_type, a.size, a.description, a.category, a.source,
            a.verification, a.status, a.tags, a.width, a.height, a.uploaded_by, a.lat, a.lon,
            a.original_sha256, a.created_ms, a.updated_ms, a.deleted_ms,
            (SELECT COUNT(*) FROM evidence_annotations an WHERE an.attachment_id = a.id AND an.deleted_ms IS NULL) AS annotation_count,
            (SELECT COUNT(*) FROM evidence_comments cm WHERE cm.attachment_id = a.id AND cm.deleted_ms IS NULL) AS comment_count
       FROM case_attachments a
      WHERE ${where.join(' AND ')}
      ORDER BY a.created_ms DESC LIMIT 500`,
  ).bind(...binds).all();
  c.header('Cache-Control', 'no-store');
  return c.json({ ok: true, items: (results ?? []).map((a: any) => normItem(a, personId)) });
});

function normItem(a: any, personId: string) {
  let tags: string[] = [];
  try { tags = a.tags ? JSON.parse(a.tags) : []; } catch { tags = []; }
  // Originals are served by the existing operator-gated file endpoint in persons.ts.
  return { ...a, tags, file_url: `/api/persons/${personId}/attachments/${a.id}/file` };
}

// ── Single item detail (+ annotations + comments). Logs a 'viewed' custody event ─
evidence.get('/:id/evidence/:aid', async (c) => {
  const personId = c.req.param('id'); const aid = c.req.param('aid');
  const item = await getItem(c.env, personId, aid);
  if (!item) return c.json({ error: 'not_found' }, 404);
  const [{ results: annotations }, { results: comments }] = await Promise.all([
    c.env.DB.prepare(`SELECT id, shape, data, created_by, created_ms, updated_ms FROM evidence_annotations WHERE attachment_id = ? AND deleted_ms IS NULL ORDER BY created_ms`).bind(aid).all(),
    c.env.DB.prepare(`SELECT id, body, kind, x, y, author, created_ms FROM evidence_comments WHERE attachment_id = ? AND deleted_ms IS NULL ORDER BY created_ms`).bind(aid).all(),
  ]);
  let tags: string[] = []; try { tags = item.tags ? JSON.parse(item.tags) : []; } catch { /**/ }
  await logCustody(c, aid, personId, 'viewed');
  c.header('Cache-Control', 'no-store');
  return c.json({
    ok: true,
    item: { ...item, tags },
    annotations: (annotations ?? []).map((a: any) => ({ ...a, data: safeJson(a.data) })),
    comments: comments ?? [],
  });
});

const safeJson = (s: any) => { try { return JSON.parse(s); } catch { return {}; } };

// ── Update metadata / status / tags ─────────────────────────────────────────
evidence.patch('/:id/evidence/:aid', async (c) => {
  const personId = c.req.param('id'); const aid = c.req.param('aid');
  const item = await getItem(c.env, personId, aid);
  if (!item) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({} as any));
  const sets: string[] = []; const binds: any[] = [];
  if (typeof b.description === 'string') { sets.push('description = ?'); binds.push(clip(b.description, 1000)); }
  if (typeof b.category === 'string') { sets.push('category = ?'); binds.push(clip(b.category, 40)); }
  if (typeof b.status === 'string') {
    if (!EVIDENCE_STATUSES.includes(b.status)) return c.json({ error: 'bad_status', allowed: EVIDENCE_STATUSES }, 400);
    sets.push('status = ?'); binds.push(b.status);
  }
  if (Array.isArray(b.tags)) {
    const tags = b.tags.filter((t: any) => typeof t === 'string').map((t: string) => t.slice(0, 40)).slice(0, 30);
    sets.push('tags = ?'); binds.push(JSON.stringify(tags));
  }
  if (b.verification && ['unverified', 'verified', 'disputed'].includes(b.verification)) { sets.push('verification = ?'); binds.push(b.verification); }
  if (!sets.length) return c.json({ error: 'no_fields' }, 400);
  sets.push('updated_ms = ?'); binds.push(Date.now());
  await c.env.DB.prepare(`UPDATE case_attachments SET ${sets.join(', ')} WHERE id = ? AND person_id = ?`).bind(...binds, aid, personId).run();
  if (b.status && b.status !== item.status) await logCustody(c, aid, personId, 'status_change', { from: item.status, to: b.status });
  await audit(c, 'evidence.update', { personId, aid, status: b.status ?? item.status });
  return c.json({ ok: true });
});

// ── Soft delete + restore ───────────────────────────────────────────────────
evidence.delete('/:id/evidence/:aid', async (c) => {
  const personId = c.req.param('id'); const aid = c.req.param('aid');
  const item = await getItem(c.env, personId, aid);
  if (!item) return c.json({ error: 'not_found' }, 404);
  await c.env.DB.prepare(`UPDATE case_attachments SET deleted_ms = ?, updated_ms = ? WHERE id = ? AND person_id = ?`).bind(Date.now(), Date.now(), aid, personId).run();
  await logCustody(c, aid, personId, 'deleted');
  await audit(c, 'evidence.soft_delete', { personId, aid });
  return c.json({ ok: true, soft_deleted: true });
});
evidence.post('/:id/evidence/:aid/restore', async (c) => {
  const personId = c.req.param('id'); const aid = c.req.param('aid');
  const r = await c.env.DB.prepare(`UPDATE case_attachments SET deleted_ms = NULL, updated_ms = ? WHERE id = ? AND person_id = ? AND deleted_ms IS NOT NULL`).bind(Date.now(), aid, personId).run();
  if (!r.meta.changes) return c.json({ error: 'not_found' }, 404);
  await logCustody(c, aid, personId, 'restored');
  await audit(c, 'evidence.restore', { personId, aid });
  return c.json({ ok: true });
});

// ── Annotations (non-destructive overlay) ───────────────────────────────────
evidence.get('/:id/evidence/:aid/annotations', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT id, shape, data, created_by, created_ms, updated_ms FROM evidence_annotations WHERE attachment_id = ? AND deleted_ms IS NULL ORDER BY created_ms`).bind(c.req.param('aid')).all();
  return c.json({ ok: true, annotations: (results ?? []).map((a: any) => ({ ...a, data: safeJson(a.data) })) });
});
evidence.post('/:id/evidence/:aid/annotations', async (c) => {
  const personId = c.req.param('id'); const aid = c.req.param('aid');
  if (!(await getItem(c.env, personId, aid))) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({} as any));
  if (!ANNOTATION_SHAPES.includes(b.shape)) return c.json({ error: 'bad_shape', allowed: ANNOTATION_SHAPES }, 400);
  if (b.data == null || typeof b.data !== 'object') return c.json({ error: 'data_required' }, 400);
  const me = await getUserFromRequest(c.env, c).catch(() => null);
  const id = uid('ann'); const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO evidence_annotations (id, attachment_id, person_id, shape, data, created_by, created_ms, updated_ms) VALUES (?,?,?,?,?,?,?,?)`,
  ).bind(id, aid, personId, b.shape, JSON.stringify(b.data).slice(0, 8000), me?.email ?? me?.id ?? null, now, now).run();
  await logCustody(c, aid, personId, 'annotated', { shape: b.shape, annotation_id: id });
  return c.json({ ok: true, id }, 201);
});
evidence.patch('/:id/evidence/:aid/annotations/:annId', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  if (b.data == null || typeof b.data !== 'object') return c.json({ error: 'data_required' }, 400);
  const r = await c.env.DB.prepare(`UPDATE evidence_annotations SET data = ?, updated_ms = ? WHERE id = ? AND attachment_id = ? AND deleted_ms IS NULL`).bind(JSON.stringify(b.data).slice(0, 8000), Date.now(), c.req.param('annId'), c.req.param('aid')).run();
  if (!r.meta.changes) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});
evidence.delete('/:id/evidence/:aid/annotations/:annId', async (c) => {
  const personId = c.req.param('id'); const aid = c.req.param('aid');
  const r = await c.env.DB.prepare(`UPDATE evidence_annotations SET deleted_ms = ? WHERE id = ? AND attachment_id = ? AND deleted_ms IS NULL`).bind(Date.now(), c.req.param('annId'), aid).run();
  if (!r.meta.changes) return c.json({ error: 'not_found' }, 404);
  await logCustody(c, aid, personId, 'annotation_deleted', { annotation_id: c.req.param('annId') });
  return c.json({ ok: true });
});

// ── Comments / notes (general | internal | pin) ─────────────────────────────
evidence.get('/:id/evidence/:aid/comments', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT id, body, kind, x, y, author, created_ms FROM evidence_comments WHERE attachment_id = ? AND deleted_ms IS NULL ORDER BY created_ms`).bind(c.req.param('aid')).all();
  return c.json({ ok: true, comments: results ?? [] });
});
evidence.post('/:id/evidence/:aid/comments', async (c) => {
  const personId = c.req.param('id'); const aid = c.req.param('aid');
  if (!(await getItem(c.env, personId, aid))) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({} as any));
  const body = clip(b.body, 2000);
  if (!body) return c.json({ error: 'body_required' }, 400);
  const kind = COMMENT_KINDS.includes(b.kind) ? b.kind : 'general';
  const me = await getUserFromRequest(c.env, c).catch(() => null);
  const id = uid('cmt');
  const x = kind === 'pin' && typeof b.x === 'number' ? Math.max(0, Math.min(1, b.x)) : null;
  const y = kind === 'pin' && typeof b.y === 'number' ? Math.max(0, Math.min(1, b.y)) : null;
  await c.env.DB.prepare(
    `INSERT INTO evidence_comments (id, attachment_id, person_id, body, kind, x, y, author, created_ms) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(id, aid, personId, body, kind, x, y, me?.email ?? me?.id ?? null, Date.now()).run();
  await logCustody(c, aid, personId, 'commented', { kind, comment_id: id });
  return c.json({ ok: true, id }, 201);
});
evidence.delete('/:id/evidence/:aid/comments/:cid', async (c) => {
  const r = await c.env.DB.prepare(`UPDATE evidence_comments SET deleted_ms = ? WHERE id = ? AND attachment_id = ? AND deleted_ms IS NULL`).bind(Date.now(), c.req.param('cid'), c.req.param('aid')).run();
  if (!r.meta.changes) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

// ── Chain of custody log ────────────────────────────────────────────────────
evidence.get('/:id/evidence/:aid/custody', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT id, event, detail, actor, actor_role, ip, created_ms FROM evidence_chain_of_custody WHERE attachment_id = ? ORDER BY created_ms DESC LIMIT 500`).bind(c.req.param('aid')).all();
  return c.json({ ok: true, custody: (results ?? []).map((r: any) => ({ ...r, detail: r.detail ? safeJson(r.detail) : null })) });
});

// ── Print bundle data (print itself is rendered & sent by the browser) ──────
// Records a 'printed' custody event and returns the evidence-sheet payload:
// item metadata + hash + annotations + comments + case label.
evidence.post('/:id/evidence/print', async (c) => {
  const personId = c.req.param('id');
  const b = await c.req.json().catch(() => ({} as any));
  const ids: string[] = Array.isArray(b.item_ids) ? b.item_ids.filter((x: any) => typeof x === 'string').slice(0, 100) : [];
  if (!ids.length) return c.json({ error: 'item_ids_required' }, 400);
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await c.env.DB.prepare(
    `SELECT id, kind, filename, content_type, size, description, category, status, verification, original_sha256, uploaded_by, created_ms, width, height
       FROM case_attachments WHERE person_id = ? AND id IN (${placeholders}) AND deleted_ms IS NULL`,
  ).bind(personId, ...ids).all();
  for (const it of results ?? []) await logCustody(c, (it as any).id, personId, 'printed');
  await audit(c, 'evidence.print', { personId, count: (results ?? []).length });
  return c.json({ ok: true, items: results ?? [] });
});

// ── Share links: create / list / revoke ─────────────────────────────────────
// Create: multipart upload of a PRE-BAKED redacted+watermarked composite. The
// private original is never exposed publicly — only this composite is served.
evidence.post('/:id/evidence/:aid/share', async (c) => {
  const personId = c.req.param('id'); const aid = c.req.param('aid');
  const item = await getItem(c.env, personId, aid);
  if (!item) return c.json({ error: 'not_found' }, 404);
  if (!(c.req.header('content-type') || '').includes('multipart/form-data')) return c.json({ error: 'multipart_required' }, 415);
  const limited = await rateLimit(c.env, c, 'evidence_share', 20, 600);
  if (limited) return limited;
  const f = await c.req.formData();
  const meta: any = {}; for (const [k, v] of f.entries()) if (typeof v === 'string') meta[k] = v;
  const file = f.get('file') as any;
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') return c.json({ error: 'composite_required' }, 400);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length || bytes.length > 10_000_000) return c.json({ error: 'bad_composite', maxBytes: 10_000_000 }, 413);
  const ctype = file.type || 'image/jpeg';
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(ctype)) return c.json({ error: 'bad_composite_type' }, 415);
  // Expiry: clamp 1 hour … 30 days, default 7 days.
  const days = Math.max(1 / 24, Math.min(30, Number(meta.expires_days) || 7));
  const expires = Date.now() + days * 86_400_000;
  const scope = ['item', 'bundle', 'viral'].includes(meta.scope) ? meta.scope : 'item';
  const { secret, hash } = await mintShareToken();
  const sid = uid('shr');
  const key = `shares/${personId}/${sid}`;
  await c.env.PERSON_PHOTOS.put(key, bytes, { httpMetadata: { contentType: ctype } });
  const me = await getUserFromRequest(c.env, c).catch(() => null);
  await c.env.DB.prepare(
    `INSERT INTO evidence_share_links (id, token_hash, attachment_id, person_id, scope, share_r2_key, content_type, title, caption, redacted, watermark, expires_ms, created_by, created_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    sid, hash, aid, personId, scope, key, ctype,
    clip(meta.title, 160), clip(meta.caption, 500),
    meta.redacted === '0' ? 0 : 1, meta.watermark === '0' ? 0 : 1,
    expires, me?.email ?? me?.id ?? null, Date.now(),
  ).run();
  await logCustody(c, aid, personId, 'shared', { share_id: sid, scope, expires_ms: expires });
  await audit(c, 'evidence.share_create', { personId, aid, sid, scope });
  return c.json({ ok: true, id: sid, token: secret, url: `/e/${secret}`, expires_ms: expires }, 201);
});
evidence.get('/:id/evidence/shares', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, attachment_id, scope, title, redacted, watermark, expires_ms, view_count, created_by, created_ms, revoked_ms
       FROM evidence_share_links WHERE person_id = ? ORDER BY created_ms DESC LIMIT 200`,
  ).bind(c.req.param('id')).all();
  const now = Date.now();
  return c.json({ ok: true, shares: (results ?? []).map((s: any) => ({ ...s, active: !s.revoked_ms && s.expires_ms > now })) });
});
evidence.delete('/:id/evidence/shares/:sid', async (c) => {
  const personId = c.req.param('id'); const sid = c.req.param('sid');
  const row: any = await c.env.DB.prepare(`SELECT attachment_id, share_r2_key, revoked_ms FROM evidence_share_links WHERE id = ? AND person_id = ?`).bind(sid, personId).first();
  if (!row) return c.json({ error: 'not_found' }, 404);
  await c.env.DB.prepare(`UPDATE evidence_share_links SET revoked_ms = ? WHERE id = ? AND person_id = ?`).bind(Date.now(), sid, personId).run();
  if (row.share_r2_key) await c.env.PERSON_PHOTOS.delete(row.share_r2_key).catch(() => {});
  await logCustody(c, row.attachment_id, personId, 'share_revoked', { share_id: sid });
  await audit(c, 'evidence.share_revoke', { personId, sid });
  return c.json({ ok: true, revoked: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC share view — mounted at /api/e (NO operator session). The secret token
// in the URL is the only credential; we look it up by sha-256 hash. Only the
// pre-baked composite is served — never the private original or any case PII
// beyond the title/caption the operator chose. Honors expiry + revocation.
// ─────────────────────────────────────────────────────────────────────────────
export const evidenceShare = new Hono<{ Bindings: Env }>();

async function resolveShare(env: Env, token: string): Promise<any | null> {
  if (!token || token.length < 16 || token.length > 80) return null;
  const hash = await tokenHash(token);
  const row: any = await env.DB.prepare(`SELECT * FROM evidence_share_links WHERE token_hash = ?`).bind(hash).first();
  if (!row) return null;
  if (row.revoked_ms || row.expires_ms < Date.now()) return { expired: true };
  return row;
}

evidenceShare.get('/:token', async (c) => {
  const limited = await rateLimit(c.env, c, 'evidence_share_view', 60, 60);
  if (limited) return limited;
  const row = await resolveShare(c.env, c.req.param('token'));
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.expired) return c.json({ error: 'expired_or_revoked' }, 410);
  await c.env.DB.prepare(`UPDATE evidence_share_links SET view_count = view_count + 1 WHERE id = ?`).bind(row.id).run();
  await logCustody(c, row.attachment_id, row.person_id, 'share_viewed', { share_id: row.id });
  c.header('Cache-Control', 'no-store');
  return c.json({
    ok: true,
    title: row.title || 'Evidencia',
    caption: row.caption || null,
    scope: row.scope,
    watermark: !!row.watermark,
    redacted: !!row.redacted,
    expires_ms: row.expires_ms,
    file_url: `/api/e/${c.req.param('token')}/file`,
  });
});

evidenceShare.get('/:token/file', async (c) => {
  const row = await resolveShare(c.env, c.req.param('token'));
  if (!row || row.expired) return c.json({ error: 'expired_or_revoked' }, row?.expired ? 410 : 404);
  const obj = await c.env.PERSON_PHOTOS.get(row.share_r2_key);
  if (!obj) return c.notFound();
  return new Response(obj.body, {
    headers: {
      'Content-Type': row.content_type || 'image/jpeg',
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline; filename="evidencia.jpg"',
    },
  });
});
