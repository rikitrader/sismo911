import type { Env } from '../types';
import { recordIngest } from '../lib/db';
import { logAgentActivity, missingStats, missingPhrase } from '../lib/agent-activity';
import { backfillHospitalMatches } from './hospital-match';

// Ingest of reportesvenezuela.com's open `pacientes.json` feed (CC0) — the live
// list of people admitted to Venezuelan hospitals after the 24-Jun-2026 quake.
//
// WHY rav_reports kind='hospital': the existing cross-matcher
// (src/ingest/hospital-match.ts) indexes hospital intakes by normalized `title`
// and matches our desaparecidos (personas) against them, persisting LEADS to
// hospital_matches + a PENDING docket note for operator verification. Feeding
// these 2.3k intakes through the SAME table means name-matching happens for free
// on the next :15 cron tick — no new matcher, no duplicate logic.
//
// DEDUPE BY CONSTRUCTION: id is `rvz_<source-uuid>` and every write is an UPSERT,
// so re-runs refresh rather than duplicate. App-owned columns (case_status /
// moderation / hidden / reports_count) are NEVER overwritten — same golden rule
// as rav-cron / familia-cron.
//
// FRUGAL: the upstream snapshot carries an `actualizado` timestamp; we stash it
// in KV and skip the whole 2.3k-row upsert when it hasn't changed, so the hourly
// tick is a single fetch on quiet hours.

const FEED_URL = 'https://www.reportesvenezuela.com/pacientes.json';
const SEEN_KEY = 'pacientes-rvz:actualizado';
const SRC = 'reportesvenezuela';
const ID_PREFIX = 'rvz_';
const CHUNK = 50;

interface RvzPatient {
  id: string;
  full_name: string;
  ci: string | null;
  hospital: { id: string; name: string } | null;
}
interface RvzFeed { actualizado?: string; count?: number; data?: RvzPatient[]; }

export interface PacientesRvzResult {
  fetched: number; written: number; skipped: boolean; actualizado: string;
}

const clean = (s: unknown, max: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Ingest the reportesvenezuela hospital-patients snapshot into rav_reports.
export async function ingestPacientesRvz(env: Env): Promise<PacientesRvzResult> {
  try {
    const res = await fetch(FEED_URL, {
      headers: { 'user-agent': 'sismo911-bot/1.0 (+https://sismo911.com)', accept: 'application/json' },
      cf: { cacheTtl: 60 },
    });
    if (!res.ok) throw new Error(`pacientes.json HTTP ${res.status}`);
    const feed = (await res.json()) as RvzFeed;
    const rows = Array.isArray(feed.data) ? feed.data : [];
    const actualizado = clean(feed.actualizado, 40);

    // Skip the bulk upsert when the upstream snapshot is unchanged — but STILL
    // write a tracking heartbeat so operators see the agent is alive and how many
    // cases remain unresolved ("seguimos buscando").
    const seen = await env.CACHE.get(SEEN_KEY).catch(() => null);
    if (actualizado && seen === actualizado) {
      const m = await missingStats(env);
      await logAgentActivity(env, {
        source: 'pacientes-rvz', action: 'poll', fetched: rows.length, stillMissing: m.total, stillUnique: m.unique,
        summary: `🤖 Sondeo reportesvenezuela/pacientes.json — ${rows.length} ingresados, sin cambios desde la última actualización. ${missingPhrase(m)}.`,
      });
      return { fetched: rows.length, written: 0, skipped: true, actualizado };
    }

    const nowIso = new Date().toISOString();
    let written = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const stmts = [];
      for (const p of rows.slice(i, i + CHUNK)) {
        const name = clean(p.full_name, 160);
        if (!name || !p?.id) continue;
        const hosp = clean(p.hospital?.name, 120) || 'Hospital no indicado';
        const id = ID_PREFIX + p.id;
        const meta = JSON.stringify({ ci: p.ci || null, hospital_id: p.hospital?.id || null, hospital_name: hosp });
        // title = patient name (hospital-match keys its index on this); description
        // carries the hospital so hospNameFrom() extracts it for the lead badge.
        stmts.push(env.DB.prepare(
          `INSERT INTO rav_reports
             (id, kind, category, title, description, city, state, area, lat, lng, contact, status,
              photo_url, meta, tags, origen, ext_id, created_at, synced_at, pulled_at)
           VALUES (?, 'hospital', 'hospital', ?, ?, '', '', '', NULL, NULL, '', 'activo',
              '', ?, '["reportesvenezuela","hospital"]', ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title=excluded.title, description=excluded.description, meta=excluded.meta,
             synced_at=excluded.synced_at, pulled_at=excluded.pulled_at`,
        ).bind(id, name, hosp, meta, SRC, p.id, nowIso, nowIso, nowIso));
        written++;
      }
      if (stmts.length) await env.DB.batch(stmts);
    }

    if (actualizado) await env.CACHE.put(SEEN_KEY, actualizado).catch(() => {});
    await recordIngest(env, 'pacientes-rvz', true, written).catch(() => {});

    // New data arrived → act like a case agent: immediately cross-match the fresh
    // intakes against the desaparecidos registry so the matched cases get an
    // agent-authored docket note THIS cycle (not only on the :15 sweep). The
    // matcher is idempotent + cursor-drained; a full drain here is cheap because
    // this branch only runs when the daily snapshot actually changed.
    let matched = 0;
    try {
      const m = await backfillHospitalMatches(env, { pages: 40 });
      matched = m.matched;
    } catch (e: any) {
      console.error('[pacientes-rvz] in-cycle match failed:', e?.message ?? e);
    }

    // CRM tracking entry — the agent's heartbeat + result for this cycle.
    const m = await missingStats(env);
    await logAgentActivity(env, {
      source: 'pacientes-rvz', action: 'ingest', fetched: rows.length, created: written, matched, stillMissing: m.total, stillUnique: m.unique,
      summary: `🤖 Ingesta reportesvenezuela/pacientes.json — ${written} ingresados sincronizados, ${matched} coincidencia(s) de nombre con desaparecidos (nota pendiente de verificación en el expediente). ${missingPhrase(m)}.`,
    });
    return { fetched: rows.length, written, skipped: false, actualizado };
  } catch (e: any) {
    console.error('[pacientes-rvz] failed:', e?.message ?? e);
    await recordIngest(env, 'pacientes-rvz', false, 0, String(e?.message ?? e)).catch(() => {});
    await logAgentActivity(env, {
      source: 'pacientes-rvz', action: 'poll', ok: false,
      summary: `⚠️ Fallo al sondear reportesvenezuela/pacientes.json: ${String(e?.message ?? e).slice(0, 180)}`,
    }).catch(() => {});
    throw e;
  }
}
