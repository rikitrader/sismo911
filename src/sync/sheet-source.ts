// Sheet-as-source-of-truth: pull the curated "Casos CRM" Google Sheet into D1.
// The sheet is authoritative for status (desaparecido/localizado/fallecido/hospitalizado),
// geo, names/phones, and dedup merges. D1 stays the fast serving layer the site reads.
//
// 90k rows can't be processed in one cron tick, so field-sync is CHUNKED with a KV
// cursor and drains over ticks. Dedup-merge reads the small, TIGHT "Duplicados" tab
// (same name AND same phone/photo) — never the loose same-name column, to avoid
// merging distinct people who happen to share a name.
import type { Env } from '../types';
import { googleAccessToken } from '../lib/sheets-sync';

const SHEET_TAB = 'Casos CRM';
const DUP_TAB = 'Duplicados';
const CHUNK = 4000;                 // data rows per pass (bounded for Worker CPU/subrequests)
const CURSOR_KEY = 'sheetsync:cursor';
const STATUS_KEY = 'sheetsync:status';

// Casos CRM column indices (0-based, row starts at column A)
const C = { NO: 0, REF: 1, NOMBRE: 3, ESTADO: 8, HOSP: 9, GEO_EST: 12, GEO_MUN: 13, TEL1: 18, GRUPO: 33 };

function baseId(ref: string): string { return (ref || '').replace(/-\d{1,2}$/, ''); }

async function readRange(env: Env, sheetId: string, token: string, range: string): Promise<string[][]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`sheets read ${r.status} for ${range}`);
  const j = await r.json<{ values?: string[][] }>();
  return j.values ?? [];
}

interface Governed { estado: string; status: string; hospitalizado: number; fallecido: number;
  hospital: string; nombre: string; tel: string; geoEst: string; geoMun: string; caseNo: string; }

function mapRow(row: string[]): Governed | null {
  const ref = (row[C.REF] || '').trim();
  if (!ref) return null;
  const est = (row[C.ESTADO] || '').trim();
  const hospCell = (row[C.HOSP] || '').trim();
  const located = /^Localizado/i.test(est);
  const fallecido = /^Fallecido/i.test(est) || hospCell === 'Fallecido' ? 1 : 0;
  const hospitalizado = hospCell === 'Sí' ? 1 : 0;
  return {
    // personas.estado must be the string the site RENDERS (estadoToStatus in familia.ts):
    // fallecido→found_deceased, hospitalizado→hospitalizado, localizado→found_safe, else missing.
    estado: fallecido ? 'fallecido' : hospitalizado ? 'hospitalizado' : located ? 'localizado' : 'sin-contacto',
    status: fallecido ? 'found_deceased' : (hospitalizado || located) ? 'found_alive' : 'missing', // persons enum
    hospitalizado, fallecido,
    hospital: hospitalizado || fallecido ? (row[10] || '').trim() : '', // K = Hospital
    nombre: (row[C.NOMBRE] || '').trim(),
    tel: (row[C.TEL1] || '').trim(),
    geoEst: (row[C.GEO_EST] || '').trim(),
    geoMun: (row[C.GEO_MUN] || '').trim(),
    caseNo: (row[C.NO] || '').trim(),
  };
}

type Recon = { pass: string; cursorFrom: number; scanned: number; matched: number; notFound: number;
  changed: number; applied: number; byStatus: Record<string, number>; wrap: boolean; dry: boolean; merges?: number };

/** One bounded field-sync pass over the Casos CRM tab (cursor drains across cron ticks). */
export async function syncCasesFieldsPass(env: Env, opts: { dryRun?: boolean } = {}): Promise<Recon> {
  const dry = !!opts.dryRun;
  const sheetId = env.CASES_SHEET_ID;
  const token = sheetId ? await googleAccessToken(env) : null;
  if (!sheetId || !token) return { pass: 'field', cursorFrom: 0, scanned: 0, matched: 0, notFound: 0, changed: 0, applied: 0, byStatus: {}, wrap: false, dry, merges: 0 };

  const cursor = Number((await env.CACHE.get(CURSOR_KEY)) || 0);
  const first = cursor + 2;                       // sheet row (header is row 1)
  const range = `${SHEET_TAB}!A${first}:AH${first + CHUNK - 1}`;
  const rows = await readRange(env, sheetId, token, range);

  const byStatus: Record<string, number> = {};
  if (rows.length === 0) {
    await env.CACHE.put(CURSOR_KEY, '0');         // wrap to top for the next cycle
    const rec: Recon = { pass: 'field', cursorFrom: cursor, scanned: 0, matched: 0, notFound: 0, changed: 0, applied: 0, byStatus, wrap: true, dry };
    await env.CACHE.put(STATUS_KEY, JSON.stringify({ ...rec, at: Date.now() }));
    return rec;
  }

  // dedupe by base id (split rows share a base + identical curated values); first wins
  const want = new Map<string, Governed>();
  for (const row of rows) { const g = mapRow(row); if (g) { const b = baseId((row[C.REF] || '')); if (!want.has(b)) want.set(b, g); } }

  const idsPersonas = [...want.keys()].filter((id) => !id.startsWith('per_'));
  const idsPersons = [...want.keys()].filter((id) => id.startsWith('per_'));
  let matched = 0, changed = 0, applied = 0;
  const now = Date.now();

  async function reconcile(table: 'personas' | 'persons', ids: string[]) {
    const nameCol = table === 'personas' ? 'nombre' : 'full_name';
    const statusCol = table === 'personas' ? 'estado' : 'status';
    const phoneCol = table === 'personas' ? 'contacto' : 'contact_phone';
    for (let i = 0; i < ids.length; i += 150) {
      const slice = ids.slice(i, i + 150);
      const ph = slice.map(() => '?').join(',');
      const cur = await env.DB.prepare(
        `SELECT id, ${nameCol} AS nm, ${statusCol} AS st, geo_estado AS ge, geo_municipio AS gm,
                ${phoneCol} AS ph, hospitalizado AS hz, fallecido AS fa FROM ${table} WHERE id IN (${ph})`
      ).bind(...slice).all<any>();
      const curMap = new Map<string, any>((cur.results ?? []).map((r) => [r.id, r]));
      const stmts: D1PreparedStatement[] = [];
      for (const id of slice) {
        const d1 = curMap.get(id); if (!d1) continue; matched++;
        const g = want.get(id)!;
        const wantSt = table === 'personas' ? g.estado : g.status;
        byStatus[wantSt] = (byStatus[wantSt] || 0) + 1;
        const diff = (d1.st !== wantSt) || (Number(d1.hz) !== g.hospitalizado) || (Number(d1.fa) !== g.fallecido)
          || (g.geoEst && d1.ge !== g.geoEst) || (g.geoMun && d1.gm !== g.geoMun)
          || (g.nombre && d1.nm !== g.nombre) || (g.tel && d1.ph !== g.tel);
        if (!diff) continue; changed++;
        if (dry) continue;
        stmts.push(env.DB.prepare(
          `UPDATE ${table} SET ${statusCol}=?, hospitalizado=?, fallecido=?, hospital_nombre=?,
             geo_estado=COALESCE(NULLIF(?,''), geo_estado), geo_municipio=COALESCE(NULLIF(?,''), geo_municipio),
             ${nameCol}=COALESCE(NULLIF(?,''), ${nameCol}), ${phoneCol}=COALESCE(NULLIF(?,''), ${phoneCol}),
             sheet_case_no=?, synced_from_sheet_ms=? WHERE id=?`
        ).bind(wantSt, g.hospitalizado, g.fallecido, g.hospital || null, g.geoEst, g.geoMun, g.nombre, g.tel, g.caseNo, now, id));
      }
      if (stmts.length) { for (let k = 0; k < stmts.length; k += 50) { await env.DB.batch(stmts.slice(k, k + 50)); applied += Math.min(50, stmts.length - k); } }
    }
  }
  await reconcile('personas', idsPersonas);
  await reconcile('persons', idsPersons);

  const notFound = want.size - matched;
  if (!dry) await env.CACHE.put(CURSOR_KEY, String(cursor + rows.length));
  const rec: Recon = { pass: 'field', cursorFrom: cursor, scanned: rows.length, matched, notFound, changed, applied, byStatus, wrap: false, dry };
  await env.CACHE.put(STATUS_KEY, JSON.stringify({ ...rec, at: Date.now() }));
  return rec;
}

/** Apply TIGHT dedup merges from the Duplicados tab: first row of each DUP group is primary. */
export async function syncDedupMerges(env: Env, opts: { dryRun?: boolean } = {}): Promise<{ groups: number; merged: number; dry: boolean }> {
  const dry = !!opts.dryRun;
  const sheetId = env.CASES_SHEET_ID;
  const token = sheetId ? await googleAccessToken(env) : null;
  if (!sheetId || !token) return { groups: 0, merged: 0, dry };
  // Duplicados columns: A=Grupo, C=Referencia (ID)
  const rows = await readRange(env, sheetId, token, `${DUP_TAB}!A2:C100000`);
  const primaryOf = new Map<string, string>();   // group -> primary base id
  const merges: Array<{ id: string; into: string }> = [];
  for (const r of rows) {
    const grp = (r[0] || '').trim(); const ref = baseId((r[2] || '').trim());
    if (!grp || !ref) continue;
    if (!primaryOf.has(grp)) { primaryOf.set(grp, ref); continue; }
    const into = primaryOf.get(grp)!; if (ref !== into) merges.push({ id: ref, into });
  }
  let merged = 0;
  if (!dry) {
    const stmts = merges.filter((m) => !m.id.startsWith('per_')).map((m) =>
      env.DB.prepare(`UPDATE personas SET merged_into=? WHERE id=? AND (merged_into IS NULL OR merged_into='')`).bind(m.into, m.id));
    for (let k = 0; k < stmts.length; k += 50) { await env.DB.batch(stmts.slice(k, k + 50)); merged += Math.min(50, stmts.length - k); }
  } else merged = merges.length;
  return { groups: primaryOf.size, merged, dry };
}

/** Cron entry: advance one field pass; run dedup once per full cycle (on wrap).
 * Fail-closed: no-op until an operator has dry-run/validated and set SHEET_SYNC_ENABLED='1'.
 * (The /api/admin/sheet-sync endpoints stay usable for manual dry-run + controlled apply.) */
export async function syncCasesSheetToD1(env: Env): Promise<unknown> {
  if (env.SHEET_SYNC_ENABLED !== '1') return { skipped: 'disabled' };
  const field = await syncCasesFieldsPass(env, {});
  let dedup: unknown = { skipped: true };
  if (field.wrap) dedup = await syncDedupMerges(env, {});
  return { field, dedup };
}

export async function lastSyncStatus(env: Env): Promise<unknown> {
  const s = await env.CACHE.get(STATUS_KEY);
  return s ? JSON.parse(s) : { note: 'no sync yet' };
}
