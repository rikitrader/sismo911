import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { timingSafeEqualStr } from '../lib/security';
import { patientToRow, type RawPatient } from '../lib/hospital-registry';

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
  const now = Date.now();
  let inserted = 0, updated = 0, skipped = 0;

  const stmts = [];
  for (const raw of b.rows as RawPatient[]) {
    const r = patientToRow(raw);
    if (!r || !r.dedupe_key) { skipped++; continue; }
    const id = uid('hp');
    // Upsert: keep the original id + matched_* linkage on conflict; refresh data.
    stmts.push(c.env.DB.prepare(
      `INSERT INTO hospital_patients
         (id,dedupe_key,hospital,full_name,name_variants,norm_name,edad,cedula,telefono,direccion,
          estado,conflict,observaciones,source,source_updated,match_confidence,created_ms,updated_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'none', ?, ?)
       ON CONFLICT(dedupe_key) DO UPDATE SET
         hospital=excluded.hospital, full_name=excluded.full_name, name_variants=excluded.name_variants,
         norm_name=excluded.norm_name, edad=excluded.edad, cedula=excluded.cedula, telefono=excluded.telefono,
         direccion=excluded.direccion, estado=excluded.estado, conflict=excluded.conflict,
         observaciones=excluded.observaciones, source_updated=excluded.source_updated, updated_ms=excluded.updated_ms`
    ).bind(id, r.dedupe_key, r.hospital, r.full_name, r.name_variants, r.norm_name, r.edad, r.cedula,
           r.telefono, r.direccion, r.estado, r.conflict, r.observaciones, 'registro-maestro',
           sourceUpdated, now, now));
  }
  // D1 batch in chunks (statement-count bounded).
  for (let i = 0; i < stmts.length; i += 50) {
    const res = await c.env.DB.batch(stmts.slice(i, i + 50));
    for (const x of res as any[]) {
      const ch = x?.meta?.changes ?? 0; const last = x?.meta?.last_row_id ?? 0;
      // changes=1 + a new rowid ⇒ insert; changes>=1 without new row ⇒ update (heuristic).
      if (ch && last) inserted++; else if (ch) updated++;
    }
  }
  return c.json({ ok: true, received: (b.rows as any[]).length, inserted, updated, skipped, source_updated: sourceUpdated });
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
