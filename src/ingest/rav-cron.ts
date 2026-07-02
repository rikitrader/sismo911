import type { Env } from '../types';
import { recordIngest } from '../lib/db';
import {
  ravFetch, ravData, RAV_MS_PAGE, parseRavCursor, advanceRavCursor,
  mapRavPersona, mapRavVerified, mapRavStats, mapRavReport, mapRavSafe,
  type RavPersonRow, type RavVerifiedRow, type RavStatsRow, type RavReportRow, type RavSafeRow, type PersonaUpsert,
} from '../lib/rav';
import { gatePersona, gateRavReport } from './gate-config';
import { logAgentActivity, missingStats, missingPhrase } from '../lib/agent-activity';

// Ingest of redayudavenezuela.com (RAV) into D1.
//
// DEDUPE BY CONSTRUCTION: personas.id for these rows is `rav_<uuid>` and every
// write is an UPSERT, so re-runs refresh rather than duplicate. APP-OWNED status
// columns (estado / localizado_* / reportada* / moderation / foto_r2 / photo_*)
// are NEVER overwritten — same golden rule as familia-cron. Cross-source dups
// (the same person also reported via theempire) are collapsed by the existing
// dedupePersonas modes (exact / photo / loose) + the new `phash` mode.
//
// PAGINATION (2026-07 proxy era): RAV revoked anon SELECT on missing_persons /
// reports / safe_reports, so bulk reads go through the site's own /api/data
// proxy (op missing_search — fixed 40 rows/page). A bounded window of pages is
// pulled per run with a KV cursor (`rav:cursor`, format "<status>:<page>") that
// sweeps all `active` pages, then all `found` pages, then wraps — so the whole
// ~52k set (and located-status updates) cycles over successive cron ticks. The
// full backfill is driven out-of-band by scripts/pull-rav.mjs via POST /api/rav/run.

const CURSOR_KEY = 'rav:cursor';
const MAX_PAGES_PER_RUN = 30;      // 40 rows/page → ~1,200 rows + 1 count + ~12 D1 batches per tick

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

export interface RavIngestResult { written: number; from: number; to: number; total: number; next: string | null; wrapped?: boolean; rejected?: number; }

// Ingest up to `pages` proxy pages of RAV missing persons starting at the KV
// cursor. `pages` defaults to the cron-safe window; the run endpoint passes a
// larger N for backfill. Advances the cursor ("<status>:<page>", flipping
// active↔found on exhaustion) and returns a progress summary; `wrapped` = this
// run finished the found list (a full active+found cycle completed).
export async function ingestRav(env: Env, pages = MAX_PAGES_PER_RUN): Promise<RavIngestResult> {
  try {
    let stored: string | null = null;
    try { stored = await env.CACHE.get(CURSOR_KEY); } catch { /* default */ }
    const cur = parseRavCursor(stored);

    const runIso = new Date().toISOString();
    const total = Number(await ravData<number>(env, 'missing_count', { status: cur.status })) || 0;

    const collected: RavPersonRow[] = [];
    const want = Math.max(1, Math.min(pages, 60));
    let page = cur.page;
    let exhausted = false;
    for (let i = 0; i < want; i++, page++) {
      const rows = await ravData<RavPersonRow[]>(env, 'missing_search', { term: '', status: cur.status, page });
      if (!Array.isArray(rows) || rows.length === 0) { exhausted = true; break; }
      collected.push(...rows);
      if (rows.length < RAV_MS_PAGE) { exhausted = true; page++; break; }   // short page = end of list
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

    const next = advanceRavCursor(cur, page, exhausted);
    const wrapped = exhausted && cur.status === 'found';   // full active+found sweep done
    await env.CACHE.put(CURSOR_KEY, next).catch(() => {});
    await recordIngest(env, 'rav', true, written);
    const from = cur.page * RAV_MS_PAGE;
    const to = Math.min(page * RAV_MS_PAGE, total || page * RAV_MS_PAGE);
    const res = { written, from, to, total, next, wrapped, rejected };
    console.log(`[rav] ${cur.status} rows ${from}-${to}/${total}: upserted ${written}, rejected ${rejected}; next cursor=${next}`);
    // CRM tracking heartbeat — the desaparecidos firehose (redayudavenezuela).
    const m = await missingStats(env);
    await logAgentActivity(env, {
      source: 'rav', action: 'ingest', fetched: written + rejected, created: written, stillMissing: m.total, stillUnique: m.unique,
      summary: `🤖 Ingesta RAV (desaparecidos, ${cur.status}) — ${written} sincronizados (filas ${from}–${to}/${total}). ${missingPhrase(m)}.`,
    });
    return res;
  } catch (e: any) {
    console.error('[rav] ingest failed:', e?.message ?? e);
    await recordIngest(env, 'rav', false, 0, String(e?.message ?? e)).catch(() => {});
    return { written: 0, from: 0, to: 0, total: 0, next: null };
  }
}

// Single-row casualty counter (id=1). The HEADLINE balance (fallecidos/heridos)
// is now owned by the canonical AI-extract pipeline (lib/canonical-casualties →
// syncOfficialStats, called from the casualty cron) so the DB row and every page
// stay standardized. RAV must NOT clobber the balance back to its own figure —
// it only contributes refugiados/desaparecidos when it actually has them, and
// never overwrites fallecidos/heridos/source/origen.
export async function ingestRavStats(env: Env): Promise<number> {
  try {
    const runIso = new Date().toISOString();
    const { rows } = await ravFetch<RavStatsRow>(env, 'official_stats', { limit: 1 });
    if (!rows.length) return 0;
    const s = mapRavStats(rows[0], runIso);
    // Only fill refugiados/desaparecidos when RAV provides a value AND the row
    // doesn't already have one — never touch the AI-owned balance or labels.
    if (s.refugiados == null && s.desaparecidos == null) return 0;
    await env.DB.prepare(
      `UPDATE official_stats SET
         refugiados    = COALESCE(?, refugiados),
         desaparecidos = COALESCE(desaparecidos, ?),
         pulled_at     = ?
       WHERE id = 1`,
    ).bind(s.refugiados, s.desaparecidos, s.pulled_at).run();
    console.log('[rav] official_stats refugiados/desaparecidos merged (balance untouched)');
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
// by construction. Direct table access was revoked (2026-07), so this now pulls
// through the /api/data proxy op `reports_list`, which serves at most the 1,000
// most-recent rows in ONE call (no offset param upstream). The ~10k historical
// rows are already in D1; hourly runs keep the fresh edge synced. Skips
// empty-title junk. (`pages` kept for API compat; the proxy ignores it.)
export async function ingestRavReports(env: Env, _pages = 15): Promise<number> {
  try {
    const runIso = new Date().toISOString();
    const all = (await ravData<RavReportRow[]>(env, 'reports_list', { limit: 1000 })) ?? [];
    const total = all.length;
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

// "Estoy a salvo" safe check-ins. PK = RAV uuid → no dupes. STRUCTURALLY
// DEGRADED since 2026-07: RAV revoked anon SELECT on safe_reports AND exposes
// no bulk op on the /api/data proxy (only per-slug `safe_by_slug` + capped
// term search `search_people`). We keep attempting the direct read once per
// run — it costs 1 subrequest, self-heals if RAV ever re-grants access, and a
// 401 is recorded as an explicit `degraded:` reason (not a mystery error) so
// /api/status tells the operator exactly what happened. The ~300 already-synced
// rows remain served as a snapshot.
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
  } catch (e: any) {
    const raw = String(e?.message ?? e);
    // 401 here is the known lockdown, not a transient fault — record the real reason.
    const msg = /HTTP 401/.test(raw)
      ? 'degraded:upstream_access_revoked (RAV cerró el acceso público masivo a safe_reports; se mantiene el snapshot local)'
      : raw;
    console.error('[rav] safe failed:', msg);
    await recordIngest(env, 'rav-safe', false, 0, msg).catch(() => {});
    return 0;
  }
}
