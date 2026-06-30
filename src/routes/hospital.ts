import { Hono } from 'hono';
import type { Env } from '../types';
import { timingSafeEqualStr } from '../lib/security';
import { audit } from '../lib/audit';
import type { RawPatient } from '../lib/hospital-registry';
import { upsertHospitalRows, collapseHospitalDupes } from '../lib/hospital-ingest';
import { drainHospitalRegistryMatch } from '../ingest/hospital-registry-match';
import { ingestHospitalRegistry } from '../ingest/hospital-registry-sync';

// Hospital patient registry API. Mounted under /api/persons (public allow-list):
//   POST /api/persons/hospital/ingest  — token-gated bulk upsert (like /api/rav/run)
//   GET  /api/persons/hospital/search  — PUBLIC search by name/cédula/hospital
//   GET  /api/persons/hospital/stats   — PUBLIC counts by estado (feeds the home card)

export const hospital = new Hono<{ Bindings: Env }>();

function authed(c: any): boolean {
  const tok = (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  const expected = c.env.RAV_INGEST_TOKEN || c.env.BLOG_INGEST_TOKEN;
  return !!expected && timingSafeEqualStr(tok, expected);
}

// ── POST /hospital/ingest — idempotent bulk upsert by dedupe_key ───────────────
hospital.post('/hospital/ingest', async (c) => {
  if (!authed(c)) return c.json({ error: 'unauthorized' }, 401);
  const b = await c.req.json().catch(() => null);
  if (!b || !Array.isArray(b.rows)) return c.json({ error: 'bad_body' }, 400);
  const sourceUpdated = String(b.source_updated || '').slice(0, 80);
  const out = await upsertHospitalRows(c.env, b.rows as RawPatient[], sourceUpdated);
  return c.json({ ok: true, ...out, source_updated: sourceUpdated });
});

// ── POST /hospital/match — token-gated manual run of the cross-reference drain ─
hospital.post('/hospital/match', async (c) => {
  if (!authed(c)) return c.json({ error: 'unauthorized' }, 401);
  const pages = Math.min(Math.max(Number(c.req.query('pages')) || 12, 1), 20);
  const out = await drainHospitalRegistryMatch(c.env, { pages });
  return c.json({ ok: true, ...out });
});

// ── POST /hospital/sync — token-gated manual run of the feed pull ──────────────
hospital.post('/hospital/sync', async (c) => {
  if (!authed(c)) return c.json({ error: 'unauthorized' }, 401);
  const out = await ingestHospitalRegistry(c.env);
  return c.json(out);
});

// ── POST /hospital/reset?confirm=RESET-HOSPITAL — clear + reload the registry ──
// Maintenance: token-gated AND requires an explicit confirm token so it can't fire
// by accident. Truncates hospital_patients (a reconstructable ingest — no user data;
// case tracer notes live in person_events) then re-pulls the feed. Idempotent.
hospital.post('/hospital/reset', async (c) => {
  if (!authed(c)) return c.json({ error: 'unauthorized' }, 401);
  if (c.req.query('confirm') !== 'RESET-HOSPITAL') return c.json({ error: 'confirm_required', hint: '?confirm=RESET-HOSPITAL' }, 400);
  const before: any = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM hospital_patients`).first().catch(() => ({ n: 0 }));
  await c.env.DB.prepare(`DELETE FROM hospital_patients`).run();
  const reload = await ingestHospitalRegistry(c.env);
  const after: any = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM hospital_patients`).first().catch(() => ({ n: 0 }));
  await audit(c, 'hospital.registry.reset', { deleted: Number(before?.n) || 0, reloaded: Number(after?.n) || 0 });
  return c.json({ ok: true, deleted: Number(before?.n) || 0, reload, total_after: Number(after?.n) || 0 });
});

// ── POST /hospital/collapse — token-gated manual duplicate collapse (reversible) ─
hospital.post('/hospital/collapse', async (c) => {
  if (!authed(c)) return c.json({ error: 'unauthorized' }, 401);
  const out = await collapseHospitalDupes(c.env);
  return c.json({ ok: !out.reason, ...out });
});

// ── GET /hospital/search?q= — public search (the source's stated purpose) ──────
hospital.get('/hospital/search', async (c) => {
  const q = String(c.req.query('q') || '').trim().slice(0, 80);
  if (q.length < 2) return c.json({ ok: true, results: [], count: 0 });
  const like = '%' + q.toLowerCase().replace(/[%_]/g, '') + '%';
  const digits = q.replace(/\D/g, '');
  const { results } = await c.env.DB.prepare(
    `SELECT id, hospital, full_name, name_variants, edad, cedula, estado, conflict, observaciones,
            matched_person_id, matched_persona_id, source_updated
       FROM hospital_patients
      WHERE lower(full_name) LIKE ? OR lower(name_variants) LIKE ? ${digits ? 'OR cedula = ?' : ''}
      ORDER BY (estado='hospitalizado') DESC, full_name COLLATE NOCASE LIMIT 60`
  ).bind(...(digits ? [like, like, digits] : [like, like])).all();
  const rows = ((results ?? []) as any[]).map((r) => {
    const matchedId = r.matched_person_id || (r.matched_persona_id ? 'fam-' + r.matched_persona_id : null);
    return {
      id: r.id, hospital: r.hospital, full_name: r.full_name,
      name_variants: (() => { try { return JSON.parse(r.name_variants || '[]'); } catch { return []; } })(),
      edad: r.edad || null, cedula: r.cedula || null, estado: r.estado, conflict: Boolean(r.conflict),
      observaciones: r.observaciones || null,
      case_url: matchedId ? `/casos/${matchedId}` : null,
      source_updated: r.source_updated || null,
    };
  });
  return c.json({ ok: true, results: rows, count: rows.length });
});

// ── GET /hospital/stats — counts by estado (feeds the Hospitalizados card) ─────
hospital.get('/hospital/stats', async (c) => {
  const row: any = await c.env.DB.prepare(
    `SELECT
       SUM(CASE WHEN estado='hospitalizado' THEN 1 ELSE 0 END) AS hospitalizado,
       SUM(CASE WHEN estado='alta' THEN 1 ELSE 0 END) AS alta,
       SUM(CASE WHEN estado='fallecido' THEN 1 ELSE 0 END) AS fallecido,
       SUM(CASE WHEN matched_person_id IS NOT NULL OR matched_persona_id IS NOT NULL THEN 1 ELSE 0 END) AS linked,
       COUNT(*) AS total
     FROM hospital_patients`
  ).first().catch(() => null);
  return c.json({
    ok: true,
    hospitalizado: Number(row?.hospitalizado) || 0,
    alta: Number(row?.alta) || 0,
    fallecido: Number(row?.fallecido) || 0,
    linked: Number(row?.linked) || 0,
    total: Number(row?.total) || 0,
  });
});
