import { Hono } from 'hono';
import type { Env } from '../types';
import { dedupePersonas, type DedupeMode } from '../lib/dedupe';
import { cleanPersonas, cleanNameFloods, purgeMarkupAbuse } from '../lib/clean';
import { ingestFamilia } from '../ingest/familia-cron';
import { backfillUsgsHistory } from '../ingest/usgs-history';
import { sweepCaseScores } from '../lib/case-score-sync';
import { audit } from '../lib/audit';
import { getUserFromRequest } from '../lib/auth';
import { sanitizeScopes, publicClient, type ApiClient } from '../lib/apikey';

export const admin = new Hono<{ Bindings: Env }>();

// --- shared operator gate for the self-gating GET endpoints below ----------
async function requireOperator(c: any) {
  const me = await getUserFromRequest(c.env, c).catch(() => null);
  if (!me || (me.role !== 'operator' && me.role !== 'admin')) return null;
  return me;
}

// Privileged actions (API-token management) are ADMIN-ONLY. Operators must never
// be able to approve/revoke API keys or otherwise alter access control.
async function requireAdmin(c: any) {
  const me = await getUserFromRequest(c.env, c).catch(() => null);
  if (!me || me.role !== 'admin') return null;
  return me;
}

// Manual trigger for the autonomous case re-scoring sweep (the hourly cron runs
// it automatically). Body: { famLimit?: number } — size of the familia batch this
// tick. Returns { native, familia, changed }.
admin.post('/rescore-cases', async (c) => {
  const b: any = await c.req.json().catch(() => ({}));
  const r = await sweepCaseScores(c.env, { famLimit: b?.famLimit });
  await audit(c, 'cases.rescore', r);
  return c.json(r);
});

// Operator/admin only (gated in index.ts via ADMIN_WRITE_PREFIXES '/api/admin').
// Body: { mode?: 'exact'|'loose'|'photo', apply?: boolean, limit?: number }.
//   exact → same name+age+location+description+contact (true re-scrapes)
//   photo → same photo URL (same image reused across records)
//   loose → same name+location only (may merge namesakes — review before apply)
//   apply=false → dry-run report (counts only, deletes nothing)
//   apply=true  → delete up to `limit` (≤400) duplicate rows + their R2 photos
admin.post('/dedupe-personas', async (c) => {
  const b: any = await c.req.json().catch(() => ({}));
  const mode: DedupeMode = b?.mode === 'loose' ? 'loose' : b?.mode === 'photo' ? 'photo' : 'exact';
  const r = await dedupePersonas(c.env, { mode, apply: !!b?.apply, limit: b?.limit });
  if (r.applied) await audit(c, 'personas.dedupe', r);
  return c.json(r);
});

// Flag corrupted / fake / junk-name personas as moderation='rejected' (hidden
// from public reads). Body: { apply?: boolean }. apply=false → count only.
admin.post('/clean-personas', async (c) => {
  const b: any = await c.req.json().catch(() => ({}));
  const r = await cleanPersonas(c.env, { apply: !!b?.apply });
  if (r.applied) await audit(c, 'personas.clean', r);
  return c.json(r);
});

// Reject "name flood" corruption — one name spammed across many rows with no
// real per-row detail (e.g. "SIMONE BURATTI GAY" ×353, 1 description). Keeps the
// newest row per group, rejects the rest. Body: { apply?: boolean, minCount?: number }.
admin.post('/clean-name-floods', async (c) => {
  const b: any = await c.req.json().catch(() => ({}));
  const r = await cleanNameFloods(c.env, { apply: !!b?.apply, minCount: b?.minCount });
  if (r.applied) await audit(c, 'personas.cleanFloods', r);
  return c.json(r);
});

// Physically DELETE stored-XSS abuse rows (name/title carrying HTML/script
// markup like '"><svg/onload=…') from personas/persons/map_reports, plus the
// known deploy-test report rep_f7fdc6e7. Idempotent (a second call → all 0).
// Body: { apply?: boolean }. apply=false → dry-run counts; apply=true → delete.
// Operator/admin-gated in index.ts (same auth as /clean-name-floods).
admin.post('/clean-markup', async (c) => {
  const b: any = await c.req.json().catch(() => ({}));
  const r = await purgeMarkupAbuse(c.env, { apply: !!b?.apply });
  if (r.applied) await audit(c, 'personas.cleanMarkup', r);
  return c.json(r);
});

// --- Face-vetting review queue --------------------------------------------
// String/byte dedupe can't catch the same missing person re-submitted with a
// different name spelling, age typo, re-cropped photo and free-text location.
// scripts/face-embed-local.py (ArcFace) + scripts/face-cluster.mjs propose
// same-face clusters into dup_cluster (status='pending'); an OPERATOR vets each
// here and merges or dismisses. Nothing is ever auto-deleted — a wrong merge of
// a missing-person record is irreversible harm, so a human is always in the loop.

// GET /api/admin/dup/clusters — pending face clusters with member details for review.
admin.get('/dup/clusters', async (c) => {
  if (!(await requireOperator(c))) return c.json({ error: 'forbidden' }, 403);
  const { results } = await c.env.DB.prepare(
    `SELECT d.cluster_id, d.persona_id, d.score, d.anchor,
            p.nombre, p.edad, p.ubicacion, p.descripcion, p.contacto, p.estado,
            p.foto_r2, p.foto, p.face_det_score, p.created_at
       FROM dup_cluster d JOIN personas p ON p.id = d.persona_id
      WHERE d.status = 'pending' AND d.method = 'face'
      ORDER BY d.cluster_id, d.anchor DESC, d.score DESC`).all<any>();
  const byCluster = new Map<string, any>();
  for (const r of results ?? []) {
    if (!byCluster.has(r.cluster_id)) byCluster.set(r.cluster_id, { cluster_id: r.cluster_id, members: [] });
    byCluster.get(r.cluster_id).members.push({
      id: r.persona_id, full_name: r.nombre, age: r.edad, last_seen: r.ubicacion,
      notes: r.descripcion, contact: r.contacto, status: r.estado, score: r.score,
      anchor: !!r.anchor, face_score: r.face_det_score,
      // /api/familia/photo/:id serves the R2 mirror or falls back to the source URL.
      photo_url: (r.foto_r2 || r.foto) ? `/api/familia/photo/${r.persona_id}` : null,
    });
  }
  const clusters = [...byCluster.values()];
  return c.json({ clusters, count: clusters.length });
});

// POST /api/admin/dup/merge — { cluster_id, keep_id }. Keep one record, retire the
// rest: losers get merged_into=keep_id and moderation flipped off 'approved', so
// every public query (which filters moderation='approved') hides them. Reversible
// (merged_into + the row + its photo are preserved) and audited.
admin.post('/dup/merge', async (c) => {
  const me = await requireOperator(c);
  if (!me) return c.json({ error: 'forbidden' }, 403);
  const b: any = await c.req.json().catch(() => ({}));
  const clusterId = String(b?.cluster_id ?? '').trim();
  const keepId = String(b?.keep_id ?? '').trim();
  if (!clusterId || !keepId) return c.json({ error: 'cluster_id and keep_id required' }, 400);

  const { results } = await c.env.DB.prepare(
    `SELECT persona_id FROM dup_cluster WHERE cluster_id = ? AND status = 'pending'`).bind(clusterId).all<any>();
  const ids = (results ?? []).map((r) => r.persona_id);
  if (!ids.length) return c.json({ error: 'cluster not found or already reviewed' }, 404);
  if (!ids.includes(keepId)) return c.json({ error: 'keep_id is not a member of this cluster' }, 400);

  const losers = ids.filter((id) => id !== keepId);
  const now = Date.now();
  const by = (me as any).email ?? (me as any).id ?? 'operator';
  const stmts = [
    c.env.DB.prepare(
      `UPDATE dup_cluster SET status='merged', reviewed_at=?, reviewed_by=? WHERE cluster_id=?`)
      .bind(now, by, clusterId),
  ];
  for (const id of losers) {
    stmts.push(c.env.DB.prepare(
      `UPDATE personas SET merged_into=?, moderation='rejected', updated_at=? WHERE id=?`)
      .bind(keepId, now, id));
  }
  await c.env.DB.batch(stmts);
  await audit(c, 'personas.faceMerge', { cluster_id: clusterId, keep_id: keepId, merged: losers });
  return c.json({ ok: true, cluster_id: clusterId, keep_id: keepId, merged: losers });
});

// POST /api/admin/dup/dismiss — { cluster_id }. Confirmed DIFFERENT people
// (namesakes / siblings / look-alikes). Mark the cluster resolved so the
// clusterer never re-proposes these members. No persona row is touched.
admin.post('/dup/dismiss', async (c) => {
  const me = await requireOperator(c);
  if (!me) return c.json({ error: 'forbidden' }, 403);
  const b: any = await c.req.json().catch(() => ({}));
  const clusterId = String(b?.cluster_id ?? '').trim();
  if (!clusterId) return c.json({ error: 'cluster_id required' }, 400);
  const by = (me as any).email ?? (me as any).id ?? 'operator';
  const r = await c.env.DB.prepare(
    `UPDATE dup_cluster SET status='dismissed', reviewed_at=?, reviewed_by=? WHERE cluster_id=? AND status='pending'`)
    .bind(Date.now(), by, clusterId).run();
  if (!r.meta.changes) return c.json({ error: 'cluster not found or already reviewed' }, 404);
  await audit(c, 'personas.faceDismiss', { cluster_id: clusterId });
  return c.json({ ok: true, cluster_id: clusterId, dismissed: r.meta.changes });
});

// Manual trigger: pull one bounded window of pages from FAMILIA_SOURCE_URL now
// (the hourly cron does this automatically + cleans). Returns rows upserted.
admin.post('/pull-familia', async (c) => {
  const upserted = await ingestFamilia(c.env);
  await audit(c, 'personas.pull', { upserted });
  return c.json({ upserted });
});

// Backfill the historical seismic archive from USGS FDSN (years of VE events).
// Body: { years?: number (≤60), minMag?: number }. Idempotent (upsert-by-id).
admin.post('/backfill-history', async (c) => {
  const b: any = await c.req.json().catch(() => ({}));
  const r = await backfillUsgsHistory(c.env, { years: b?.years, minMag: b?.minMag });
  await audit(c, 'events.backfill', r);
  return c.json(r);
});

// GET /api/admin/spam-stats — operator alert: blocked-spam counts from the audit
// log (today / last 7d / total + top offending IP). GET is not write-gated by the
// index.ts middleware, so it self-gates here.
admin.get('/spam-stats', async (c) => {
  const me = await getUserFromRequest(c.env, c).catch(() => null);
  if (!me || (me.role !== 'operator' && me.role !== 'admin')) return c.json({ error: 'unauthorized' }, 401);
  const dayMs = 86_400_000, now = Date.now();
  const todayStart = now - (now % dayMs), wk = now - 7 * dayMs;
  const count = async (since?: number) => {
    const sql = since == null
      ? `SELECT COUNT(*) AS n FROM audit WHERE action='spam_blocked'`
      : `SELECT COUNT(*) AS n FROM audit WHERE action='spam_blocked' AND created_ms>=?`;
    const stmt = since == null ? c.env.DB.prepare(sql) : c.env.DB.prepare(sql).bind(since);
    const r = await stmt.first<any>().catch(() => null);
    return Number(r?.n ?? 0);
  };
  const top = await c.env.DB.prepare(
    `SELECT json_extract(detail,'$.ip') AS ip, COUNT(*) AS c FROM audit
      WHERE action='spam_blocked' AND created_ms>=? AND json_extract(detail,'$.ip') IS NOT NULL
      GROUP BY ip ORDER BY c DESC LIMIT 1`
  ).bind(wk).first<any>().catch(() => null);
  return c.json(
    { today: await count(todayStart), last7d: await count(wk), total: await count(), topIp: top?.ip ?? null },
    200, { 'Cache-Control': 'no-store' }
  );
});

// ===========================================================================
// API-client management (gated data API + MCP). Approvals/revocations are
// write methods under /api/admin → already operator-gated in index.ts. The GET
// listing self-gates (GET isn't write-gated).
// ===========================================================================

// GET /api/admin/api-clients?status=pending|approved|revoked — list registrations.
admin.get('/api-clients', async (c) => {
  if (!(await requireAdmin(c))) return c.json({ error: 'forbidden' }, 403);
  const status = c.req.query('status');
  const valid = ['pending', 'approved', 'revoked'];
  const where = status && valid.includes(status) ? 'WHERE status = ?' : '';
  const stmt = where
    ? c.env.DB.prepare(
        `SELECT id,name,email,org,purpose,api_key,status,scopes,rate_limit,request_count,last_used_ms,created_ms
         FROM api_clients ${where} ORDER BY created_ms DESC LIMIT 500`
      ).bind(status)
    : c.env.DB.prepare(
        `SELECT id,name,email,org,purpose,api_key,status,scopes,rate_limit,request_count,last_used_ms,created_ms
         FROM api_clients ORDER BY created_ms DESC LIMIT 500`
      );
  const { results } = await stmt.all<ApiClient>();
  return c.json(
    { clients: (results ?? []).map(publicClient) },
    200,
    { 'Cache-Control': 'no-store' }
  );
});

// POST /api/admin/api-clients/:id/approve
// Body: { scopes?: string|string[], rate_limit?: number, note?: string }.
// scopes omitted → keep the client's requested (default) scopes. To grant the
// sensitive registry, include 'read:missing-persons'.
admin.post('/api-clients/:id/approve', async (c) => {
  const me = await requireAdmin(c);
  if (!me) return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const b: any = await c.req.json().catch(() => ({}));
  const row = await c.env.DB.prepare(`SELECT scopes FROM api_clients WHERE id = ?`).bind(id).first<any>();
  if (!row) return c.json({ error: 'not_found' }, 404);
  const scopes = b?.scopes != null ? sanitizeScopes(b.scopes) : row.scopes;
  const rate = Number.isFinite(b?.rate_limit) ? Math.max(1, Math.min(6000, Math.floor(b.rate_limit))) : null;
  await c.env.DB.prepare(
    `UPDATE api_clients
       SET status='approved', scopes=?, approved_by=?, approved_ms=?, revoked_ms=NULL,
           note=COALESCE(NULLIF(?,''), note)${rate != null ? ', rate_limit=?' : ''}
     WHERE id=?`
  )
    .bind(...(rate != null
      ? [scopes, me?.email ?? me?.id ?? 'operator', Date.now(), String(b?.note ?? ''), rate, id]
      : [scopes, me?.email ?? me?.id ?? 'operator', Date.now(), String(b?.note ?? ''), id]))
    .run();
  await audit(c, 'api_client.approve', { id, scopes });
  const updated = await c.env.DB.prepare(
    `SELECT id,name,email,org,purpose,api_key,status,scopes,rate_limit,request_count,last_used_ms,created_ms FROM api_clients WHERE id=?`
  ).bind(id).first<ApiClient>();
  return c.json({ ok: true, client: updated ? publicClient(updated) : null });
});

// POST /api/admin/api-clients/:id/revoke — disable a key (auth fails afterward).
admin.post('/api-clients/:id/revoke', async (c) => {
  if (!(await requireAdmin(c))) return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const r = await c.env.DB.prepare(
    `UPDATE api_clients SET status='revoked', revoked_ms=? WHERE id=?`
  ).bind(Date.now(), id).run();
  if (!r.meta.changes) return c.json({ error: 'not_found' }, 404);
  await audit(c, 'api_client.revoke', { id });
  return c.json({ ok: true, id, status: 'revoked' });
});
