import { Hono } from 'hono';
import type { Env } from '../types';
import { timingSafeEqualStr } from '../lib/security';
import { audit } from '../lib/audit';
import type { RawPatient } from '../lib/hospital-registry';
import { parseStatus, patientToRow } from '../lib/hospital-registry';
import { upsertHospitalRows, collapseHospitalDupes, mapSheetRows } from '../lib/hospital-ingest';
import { parseXlsxRows } from '../lib/xlsx-lite';
import { drainHospitalRegistryMatch } from '../ingest/hospital-registry-match';
import { HOSPITAL_SOURCE_MARKER_KEY, ingestHospitalRegistry } from '../ingest/hospital-registry-sync';

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
  await c.env.CACHE.delete(HOSPITAL_SOURCE_MARKER_KEY);
  const reload = await ingestHospitalRegistry(c.env);
  const after: any = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM hospital_patients`).first().catch(() => ({ n: 0 }));
  await audit(c, 'hospital.registry.reset', { deleted: Number(before?.n) || 0, reloaded: Number(after?.n) || 0 });
  return c.json({ ok: true, deleted: Number(before?.n) || 0, reload, total_after: Number(after?.n) || 0 });
});

// ── POST /hospital/collapse — token-gated manual duplicate collapse (reversible) ─
hospital.post('/hospital/collapse', async (c) => {
  if (!authed(c)) return c.json({ error: 'unauthorized' }, 401);
  const out = await collapseHospitalDupes(c.env, { force: c.req.query('force') === 'true' });
  return c.json({ ok: !out.reason, ...out });
});

// ── POST /hospital/source-audit — ground-truth reconciliation (READ-ONLY) ────────
// Re-parses the live source feed and reports counts by estado, a per-keyword
// breakdown of WHY rows are classified hospitalizado, the deduped projection, and
// the deltas vs the live DB. Writes nothing — the zero-hallucination anchor for
// deciding the "hospitalizado" definition.
hospital.post('/hospital/source-audit', async (c) => {
  if (!authed(c)) return c.json({ error: 'unauthorized' }, 401);
  const url = (c.env.HOSPITAL_FEED_URL || '').trim();
  if (!url) return c.json({ ok: false, reason: 'no_feed_url' }, 400);
  let patients: RawPatient[] = [];
  let sourceUpdated = '';
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'sismo911-hospital-sync', accept: 'application/octet-stream' } });
    if (!res.ok) return c.json({ ok: false, reason: 'fetch_' + res.status }, 502);
    const rows = await parseXlsxRows(await res.arrayBuffer());
    const mapped = mapSheetRows(rows);
    patients = mapped.patients; sourceUpdated = mapped.source_updated;
  } catch (e: any) {
    return c.json({ ok: false, reason: String(e?.message || e).slice(0, 120) }, 502);
  }

  // Raw per-row classification (one entry per source row, pre-dedup).
  const KEYWORDS = ['internad', 'hospitaliz', 'uci', 'upt', 'ingres', 'emergencia', 'servicio:', 'fallec', 'alta'];
  const rawByEstado: Record<string, number> = { hospitalizado: 0, alta: 0, fallecido: 0, desconocido: 0 };
  // Which keyword drove a hospitalizado classification (first match in parseStatus order).
  const hospByKeyword: Record<string, number> = { internad: 0, hospitaliz: 0, uci: 0, upt: 0, ingres: 0, emergencia: 0, 'servicio:': 0 };
  // Deduped projection: one estado per person (dedupe_key), best status wins.
  const rank: Record<string, number> = { fallecido: 0, alta: 1, hospitalizado: 2, desconocido: 3 };
  const best: Record<string, string> = {};
  let blankObsHosp = 0;
  for (const p of patients) {
    const obs = String(p.observaciones || '').toLowerCase();
    const { estado } = parseStatus(p.observaciones);
    rawByEstado[estado] = (rawByEstado[estado] || 0) + 1;
    if (estado === 'hospitalizado') {
      if (/internad/.test(obs)) hospByKeyword.internad++;
      else if (/hospitaliz/.test(obs)) hospByKeyword.hospitaliz++;
      else if (/\buci\b/.test(obs)) hospByKeyword.uci++;
      else if (/\bupt\b/.test(obs)) hospByKeyword.upt++;
      else if (/ingres/.test(obs)) hospByKeyword.ingres++;
      else if (/emergencia/.test(obs)) hospByKeyword.emergencia++;
      else if (/servicio:/.test(obs)) hospByKeyword['servicio:']++;
      if (!obs.trim()) blankObsHosp++;
    }
    const row = patientToRow(p);
    if (row?.dedupe_key) {
      const cur = best[row.dedupe_key];
      if (cur === undefined || rank[estado] < rank[cur]) best[row.dedupe_key] = estado;
    }
  }
  const dedupByEstado: Record<string, number> = { hospitalizado: 0, alta: 0, fallecido: 0, desconocido: 0 };
  for (const k in best) dedupByEstado[best[k]] = (dedupByEstado[best[k]] || 0) + 1;

  // Live DB counts.
  const dbRows = (await c.env.DB.prepare(`SELECT estado, COUNT(*) AS n FROM hospital_patients GROUP BY estado`).all<any>()).results ?? [];
  const db: Record<string, number> = { hospitalizado: 0, alta: 0, fallecido: 0, desconocido: 0 };
  for (const r of dbRows) db[r.estado] = Number(r.n) || 0;
  const dbTotal = Object.values(db).reduce((a, b) => a + b, 0);

  return c.json({
    ok: true,
    source_updated: sourceUpdated,
    source_rows: patients.length,
    rawByEstado,                                  // per source row (pre-dedup)
    hospByKeyword,                                // why hospitalizado (per source row)
    blank_obs_hospitalizado: blankObsHosp,        // hospitalizado source rows with NO observación text
    dedup_projection: { byEstado: dedupByEstado, distinct_people: Object.keys(best).length },
    db: { byEstado: db, total: dbTotal },
    deltas: {                                     // dedup projection − live DB (should be ~0 if pipeline honest)
      hospitalizado: (dedupByEstado.hospitalizado || 0) - (db.hospitalizado || 0),
      alta: (dedupByEstado.alta || 0) - (db.alta || 0),
      fallecido: (dedupByEstado.fallecido || 0) - (db.fallecido || 0),
      total: Object.keys(best).length - dbTotal,
    },
  });
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
