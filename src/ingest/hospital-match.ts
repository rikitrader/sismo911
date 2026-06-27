import type { Env } from '../types';

// Cross-match desaparecidos against hospital intakes (rav_reports kind=hospital).
// A name match is a LEAD, never an identity: we persist it in hospital_matches and
// add a PENDING docket note so an operator verifies. Status is never changed here.
//
// The matcher is cursor-drained: each call processes a few pages of personas/persons
// against an in-memory index of hospital names, so a cron can complete the whole
// registry over several ticks and keep matching new intakes thereafter.

const norm = (s: string | null | undefined) =>
  String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

function hospNameFrom(r: any): string {
  const hit = String(r.description || '').split(/\n|\.|·|\//).map((s: string) => s.trim())
    .find((s: string) => /hospital|cl[ií]nic|cdi|ambulatori|perif[eé]ric|materni|centro de salud|seguro social/i.test(s));
  const parts = [hit, r.contact, r.city, r.state].filter((x: any) => x && !/^\+?\d[\d\s-]{5,}$/.test(String(x)));
  return parts[0] || 'Hospital no indicado';
}

// Build name_key → {report_id, hospital_name} from all visible hospital intakes.
// First occurrence wins (a representative hospital for the badge/note).
async function buildIndex(env: Env): Promise<Map<string, { report_id: string; hospital_name: string }>> {
  const { results } = await env.DB.prepare(
    `SELECT id, title, substr(coalesce(description,''),1,200) AS description, contact, city, state
     FROM rav_reports WHERE kind='hospital' AND coalesce(hidden,0)=0`,
  ).all<any>();
  const idx = new Map<string, { report_id: string; hospital_name: string }>();
  for (const r of results ?? []) {
    const k = norm(r.title);
    if (k.length > 5 && !idx.has(k)) idx.set(k, { report_id: String(r.id), hospital_name: hospNameFrom(r) });
  }
  return idx;
}

export interface HospMatchResult { phase: string; scanned: number; matched: number; noted: number; done: boolean; }

export async function backfillHospitalMatches(
  env: Env,
  opts: { pages?: number; pageSize?: number } = {},
): Promise<HospMatchResult> {
  const pages = Math.min(Math.max(opts.pages ?? 2, 1), 40);
  const pageSize = Math.min(Math.max(opts.pageSize ?? 3000, 100), 5000);
  const now = Date.now();

  const st: any = await env.DB.prepare(`SELECT phase, cursor, scanned, matched FROM hospital_match_state WHERE id=1`).first()
    || { phase: 'personas', cursor: '', scanned: 0, matched: 0 };
  if (st.phase === 'done') {
    // Idle maintenance: a finished backfill that's asked to run again restarts at
    // the personas phase so newly-ingested intakes get matched against the registry.
    st.phase = 'personas'; st.cursor = '';
  }
  const idx = await buildIndex(env);
  let { phase, cursor } = st as { phase: string; cursor: string };
  let scanned = 0, matched = 0, noted = 0;

  for (let p = 0; p < pages; p++) {
    const isFam = phase === 'personas';
    const rows = isFam
      ? (await env.DB.prepare(
          `SELECT id, nombre AS name, estado FROM personas
           WHERE id > ? AND estado NOT IN ('localizado','fallecido','hospitalizado','aparecido')
           ORDER BY id LIMIT ?`).bind(cursor, pageSize).all<any>()).results
      : (await env.DB.prepare(
          `SELECT id, full_name AS name, status FROM persons
           WHERE id > ? AND status='missing' AND review='approved'
           ORDER BY id LIMIT ?`).bind(cursor, pageSize).all<any>()).results;
    const list = rows ?? [];
    scanned += list.length;

    // Find this page's matches, then skip any already recorded (idempotent).
    const hits: { caseId: string; rawId: string; hit: { report_id: string; hospital_name: string } }[] = [];
    for (const r of list) {
      const hit = idx.get(norm(r.name));
      if (hit) hits.push({ caseId: isFam ? 'fam-' + r.id : String(r.id), rawId: String(r.id), hit });
    }
    if (hits.length) {
      const ids = hits.map((h) => h.caseId);
      const existing = new Set<string>();
      for (let i = 0; i < ids.length; i += 90) {
        const slice = ids.slice(i, i + 90);
        const { results: ex } = await env.DB.prepare(
          `SELECT person_id FROM hospital_matches WHERE person_id IN (${slice.map(() => '?').join(',')})`,
        ).bind(...slice).all<any>();
        (ex ?? []).forEach((e: any) => existing.add(String(e.person_id)));
      }
      const fresh = hits.filter((h) => !existing.has(h.caseId));
      if (fresh.length) {
        const stmts = [] as any[];
        for (const h of fresh) {
          stmts.push(env.DB.prepare(
            `INSERT OR IGNORE INTO hospital_matches (person_id, report_id, hospital_name, name_key, noted, created_ms)
             VALUES (?,?,?,?,1,?)`,
          ).bind(h.caseId, h.hit.report_id, h.hit.hospital_name, norm(h.hit.hospital_name).slice(0, 80) || null, now));
          // Pending docket note — visible in the case timeline, awaiting operator review.
          stmts.push(env.DB.prepare(
            `INSERT INTO person_events (id, person_id, kind, status_to, detail, source, review, created_ms)
             VALUES (?,?,?,?,?,?,?,?)`,
          ).bind(
            'hm_' + h.caseId.replace(/[^a-zA-Z0-9]/g, '').slice(-16) + '_' + (now % 1000000),
            h.caseId, 'hospital', null,
            `🏥 Posible ingreso hospitalario: ${h.hit.hospital_name} — coincidencia de nombre con un reporte de hospital. Verificar identidad.`,
            'system', 'pending', now,
          ));
        }
        for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
        matched += fresh.length; noted += fresh.length;
      }
    }

    if (list.length < pageSize) {
      // Page exhausted → advance to the next phase (or finish).
      phase = isFam ? 'persons' : 'done'; cursor = '';
      if (phase === 'done') break;
    } else {
      cursor = String(list[list.length - 1].id);
    }
  }

  await env.DB.prepare(
    `UPDATE hospital_match_state SET phase=?, cursor=?, scanned=scanned+?, matched=matched+?, updated_ms=? WHERE id=1`,
  ).bind(phase, cursor, scanned, matched, now).run();
  return { phase, scanned, matched, noted, done: phase === 'done' };
}
