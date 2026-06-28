import type { Env } from '../types';
import { recordIngest } from '../lib/db';

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

    // Skip the bulk upsert when the upstream snapshot is unchanged.
    const seen = await env.CACHE.get(SEEN_KEY).catch(() => null);
    if (actualizado && seen === actualizado) {
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
    return { fetched: rows.length, written, skipped: false, actualizado };
  } catch (e: any) {
    console.error('[pacientes-rvz] failed:', e?.message ?? e);
    await recordIngest(env, 'pacientes-rvz', false, 0, String(e?.message ?? e)).catch(() => {});
    throw e;
  }
}
