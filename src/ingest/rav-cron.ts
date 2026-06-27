import type { Env } from '../types';
import { recordIngest } from '../lib/db';
import {
  ravFetch, RAV_PAGE, mapRavPersona, mapRavVerified, mapRavStats, mapRavReport, mapRavSafe,
  type RavPersonRow, type RavVerifiedRow, type RavStatsRow, type RavReportRow, type RavSafeRow, type PersonaUpsert,
} from '../lib/rav';
import { gatePersona, gateRavReport } from './gate-config';

// Ingest of redayudavenezuela.com (RAV) into D1.
//
// DEDUPE BY CONSTRUCTION: personas.id for these rows is `rav_<uuid>` and every
// write is an UPSERT, so re-runs refresh rather than duplicate. APP-OWNED status
// columns (estado / localizado_* / reportada* / moderation / foto_r2 / photo_*)
// are NEVER overwritten — same golden rule as familia-cron. Cross-source dups
// (the same person also reported via theempire) are collapsed by the existing
// dedupePersonas modes (exact / photo / loose) + the new `phash` mode.
//
// PAGINATION: PostgREST caps a response at 1000 rows. A bounded window of pages
// is pulled per run with a KV offset cursor (`rav:cursor`) so successive cron
// ticks cycle the whole ~53k set; the full backfill is driven out-of-band by
// scripts/pull-rav.mjs via POST /api/rav/run.

const CURSOR_KEY = 'rav:cursor';
const MAX_PAGES_PER_RUN = 5;       // ~5000 rows / 5 subrequests per cron tick

function upsertPersonaStmt(env: Env, p: PersonaUpsert) {
  return env.DB.prepare(
    `INSERT INTO personas
       (id, nombre, edad, ubicacion, fecha, descripcion, contacto, foto, estado,
        origen, ext_id, tags, synced_at, created_at, updated_at, pulled_at, moderation)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'approved')
     ON CONFLICT(id) DO UPDATE SET
        nombre=excluded.nombre, edad=excluded.edad, ubicacion=excluded.ubicacion, fecha=excluded.fecha,
        descripcion=excluded.descripcion, contacto=excluded.contacto,
        foto=CASE WHEN excluded.foto <> '' THEN excluded.foto ELSE personas.foto END,
        origen=excluded.origen, ext_id=excluded.ext_id, tags=excluded.tags,
        synced_at=excluded.synced_at, updated_at=excluded.updated_at, pulled_at=excluded.pulled_at`,
  ).bind(
    p.id, p.nombre, p.edad, p.ubicacion, p.fecha, p.descripcion, p.contacto, p.foto, p.estado,
    p.origen, p.ext_id, p.tags, p.synced_at, p.created_at, p.updated_at, p.pulled_at,
  );
}

export interface RavIngestResult { written: number; from: number; to: number; total: number; next: number; rejected?: number; }

// Ingest up to `pages` pages of RAV missing_persons starting at the KV cursor.
// `pages` defaults to the cron-safe window; the run endpoint passes a larger N
// for backfill. Advances/​wraps the cursor and returns a progress summary.
export async function ingestRav(env: Env, pages = MAX_PAGES_PER_RUN): Promise<RavIngestResult> {
  try {
    let offset = 0;
    try { offset = Math.max(0, parseInt((await env.CACHE.get(CURSOR_KEY)) || '0', 10) || 0); } catch { /* default 0 */ }

    const runIso = new Date().toISOString();
    let page0 = await ravFetch<RavPersonRow>(env, 'missing_persons', { offset, order: 'id.asc' });
    let total = page0.total;
    if (offset >= total) {   // dataset shrank / cursor past end → restart from 0
      offset = 0;
      page0 = await ravFetch<RavPersonRow>(env, 'missing_persons', { offset: 0, order: 'id.asc' });
      total = page0.total;
    }

    const collected: RavPersonRow[] = [...page0.rows];
    const want = Math.max(1, Math.min(pages, 25));
    let cur = offset + RAV_PAGE;
    for (let i = 1; i < want && cur < total; i++) {
      const pg = await ravFetch<RavPersonRow>(env, 'missing_persons', { offset: cur, order: 'id.asc' });
      collected.push(...pg.rows);
      cur += RAV_PAGE;
    }

    const stmts = [];
    let rejected = 0;
    for (const r of collected) {
      const p = mapRavPersona(r, runIso);
      if (!p || !p.nombre) continue;   // empty-name rows: skip; cleanPersonas handles junk that does get in
      // Door check: drop junk / link-spam / stored-XSS / flood-phrase rows before
      // they ever land (in-memory, no D1 — safe per-row at cron scale).
      if (!gatePersona(p).ok) { rejected++; continue; }
      stmts.push(upsertPersonaStmt(env, p));
    }
    let written = 0;
    for (let i = 0; i < stmts.length; i += 100) { await env.DB.batch(stmts.slice(i, i + 100)); written += Math.min(100, stmts.length - i); }

    const next = cur >= total ? 0 : cur;   // wrap to 0 after a full cycle
    await env.CACHE.put(CURSOR_KEY, String(next)).catch(() => {});
    await recordIngest(env, 'rav', true, written);
    const res = { written, from: offset, to: Math.min(cur, total), total, next, rejected };
    console.log(`[rav] ${offset}-${res.to}/${total}: upserted ${written}, rejected ${rejected}; next cursor=${next}`);
    return res;
  } catch (e: any) {
    console.error('[rav] ingest failed:', e?.message ?? e);
    await recordIngest(env, 'rav', false, 0, String(e?.message ?? e)).catch(() => {});
    return { written: 0, from: 0, to: 0, total: 0, next: 0 };
  }
}

// Single-row casualty counter (id=1 UPSERT — no dupes by construction).
export async function ingestRavStats(env: Env): Promise<number> {
  try {
    const runIso = new Date().toISOString();
    const { rows } = await ravFetch<RavStatsRow>(env, 'official_stats', { limit: 1 });
    if (!rows.length) return 0;
    const s = mapRavStats(rows[0], runIso);
    await env.DB.prepare(
      `INSERT INTO official_stats (id, fallecidos, heridos, refugiados, desaparecidos, source, origen, updated_at, pulled_at)
       VALUES (1,?,?,?,?,?, 'rav', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         fallecidos=excluded.fallecidos, heridos=excluded.heridos, refugiados=excluded.refugiados,
         desaparecidos=excluded.desaparecidos, source=excluded.source,
         updated_at=excluded.updated_at, pulled_at=excluded.pulled_at`,
    ).bind(s.fallecidos, s.heridos, s.refugiados, s.desaparecidos, s.source, s.updated_at, s.pulled_at).run();
    console.log('[rav] official_stats upserted', JSON.stringify(s));
    return 1;
  } catch (e: any) { console.error('[rav] stats failed:', e?.message ?? e); return 0; }
}

// Verified news (144 rows). PK = RAV uuid → no dupes by id. Cross-source title
// dedupe (same story, two outlets) keeps the EARLIEST-published per lower(title):
// later duplicates are dropped before the upsert.
export async function ingestRavVerified(env: Env): Promise<number> {
  try {
    const runIso = new Date().toISOString();
    const { rows } = await ravFetch<RavVerifiedRow>(env, 'verified_info', { order: 'published_at.asc' });
    if (!rows.length) return 0;
    const byTitle = new Map<string, ReturnType<typeof mapRavVerified>>();
    for (const r of rows) {
      const m = mapRavVerified(r, runIso);
      if (!m.title) continue;
      const key = m.title.trim().toLowerCase();
      const prev = byTitle.get(key);
      // keep earliest published (rows already asc by published_at, but be explicit)
      if (!prev || (m.published_at && prev.published_at && m.published_at < prev.published_at)) byTitle.set(key, m);
      else if (!prev) byTitle.set(key, m);
    }
    const stmts = [...byTitle.values()].map((m) =>
      env.DB.prepare(
        `INSERT INTO verified_info (id, source, title, body, url, topic, tags, published_at, origen, synced_at, pulled_at)
         VALUES (?,?,?,?,?,?,?,?, 'rav', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           source=excluded.source, title=excluded.title, body=excluded.body, url=excluded.url,
           topic=excluded.topic, tags=excluded.tags, published_at=excluded.published_at,
           synced_at=excluded.synced_at, pulled_at=excluded.pulled_at`,
      ).bind(m.id, m.source, m.title, m.body, m.url, m.topic, m.tags, m.published_at, m.synced_at, m.pulled_at));
    let n = 0;
    for (let i = 0; i < stmts.length; i += 100) { await env.DB.batch(stmts.slice(i, i + 100)); n += Math.min(100, stmts.length - i); }
    console.log(`[rav] verified_info upserted ${n} (deduped from ${rows.length})`);
    return n;
  } catch (e: any) { console.error('[rav] verified failed:', e?.message ?? e); return 0; }
}

// Citizen reports (pets/volunteers/trapped/aid/damage). PK = RAV uuid → no dupes
// by construction. Bounded page fetch (covers the current ~9.3k; if it ever grows
// past PAGES×1000 the tail is picked up next run). Skips empty-title junk.
export async function ingestRavReports(env: Env, pages = 15): Promise<number> {
  try {
    const runIso = new Date().toISOString();
    const first = await ravFetch<RavReportRow>(env, 'reports', { order: 'created_at.desc' });
    const total = first.total;
    const all = [...first.rows];
    const want = Math.max(1, Math.min(pages, 25));
    for (let i = 1, off = RAV_PAGE; i < want && off < total; i++, off += RAV_PAGE) {
      all.push(...(await ravFetch<RavReportRow>(env, 'reports', { offset: off, order: 'created_at.desc' })).rows);
    }
    const stmts = [];
    let rejected = 0;
    for (const r of all) {
      const m = mapRavReport(r, runIso);
      if (!m.title && !m.description) continue;   // skip empty junk
      if (!gateRavReport(m).ok) { rejected++; continue; }  // drop markup/link-spam/flood
      stmts.push(env.DB.prepare(
        `INSERT INTO rav_reports (id, kind, category, title, description, city, state, area, lat, lng,
            contact, status, photo_url, meta, tags, ext_id, created_at, synced_at, pulled_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           kind=excluded.kind, category=excluded.category, title=excluded.title, description=excluded.description,
           city=excluded.city, state=excluded.state, area=excluded.area, lat=excluded.lat, lng=excluded.lng,
           contact=excluded.contact, status=excluded.status, photo_url=excluded.photo_url, meta=excluded.meta,
           tags=excluded.tags, synced_at=excluded.synced_at, pulled_at=excluded.pulled_at`,
      ).bind(m.id, m.kind, m.category, m.title, m.description, m.city, m.state, m.area, m.lat, m.lng,
        m.contact, m.status, m.photo_url, m.meta, m.tags, m.ext_id, m.created_at, m.synced_at, m.pulled_at));
    }
    let n = 0;
    for (let i = 0; i < stmts.length; i += 100) { await env.DB.batch(stmts.slice(i, i + 100)); n += Math.min(100, stmts.length - i); }
    await recordIngest(env, 'rav-reports', true, n);
    console.log(`[rav] reports upserted ${n}/${total}, rejected ${rejected}`);
    return n;
  } catch (e: any) { console.error('[rav] reports failed:', e?.message ?? e); await recordIngest(env, 'rav-reports', false, 0, String(e?.message ?? e)).catch(() => {}); return 0; }
}

// "Estoy a salvo" safe check-ins. PK = RAV uuid → no dupes. Small (~300); one page.
export async function ingestRavSafe(env: Env): Promise<number> {
  try {
    const runIso = new Date().toISOString();
    const { rows } = await ravFetch<RavSafeRow>(env, 'safe_reports', { order: 'created_at.desc' });
    const stmts = [];
    for (const r of rows) {
      const m = mapRavSafe(r, runIso);
      if (!m.name) continue;
      stmts.push(env.DB.prepare(
        `INSERT INTO rav_safe_reports (id, slug, name, city, state, area, status, note, photo_url, tags, created_at, synced_at, pulled_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           slug=excluded.slug, name=excluded.name, city=excluded.city, state=excluded.state, area=excluded.area,
           status=excluded.status, note=excluded.note, photo_url=excluded.photo_url, tags=excluded.tags,
           synced_at=excluded.synced_at, pulled_at=excluded.pulled_at`,
      ).bind(m.id, m.slug, m.name, m.city, m.state, m.area, m.status, m.note, m.photo_url, m.tags, m.created_at, m.synced_at, m.pulled_at));
    }
    let n = 0;
    for (let i = 0; i < stmts.length; i += 100) { await env.DB.batch(stmts.slice(i, i + 100)); n += Math.min(100, stmts.length - i); }
    await recordIngest(env, 'rav-safe', true, n);
    console.log(`[rav] safe_reports upserted ${n}`);
    return n;
  } catch (e: any) { console.error('[rav] safe failed:', e?.message ?? e); await recordIngest(env, 'rav-safe', false, 0, String(e?.message ?? e)).catch(() => {}); return 0; }
}
