// src/ingest/casualty-cron.ts
//
// Trailing casualty-figure poller. Runs HOURLY on the :45 cron trigger.
//
// What it polls (machine-readable, no fabrication):
//   • USGS PAGER — the live alert color + magnitude for both events of the
//     24-Jun-2026 sequence → a transparent modeled "dead" floor (red = 1.000+).
//   • ReliefWeb / OCHA — reachability of the GLIDE disaster record (freshness
//     signal + live citation). ReliefWeb's disaster schema carries no death
//     count, so we record the source as reached but NEVER invent a number.
//   • AI extraction — Workers AI reads the continuously-updated LEAD summary of
//     the event article (en + es Wikipedia, which themselves aggregate CNN/AJ/
//     Reuters/AFP reporting) and extracts the live confirmed dead/injured/
//     missing/displaced figures. The model is told to return null for anything
//     absent from the text (no fabrication); figures land at MODEST confidence,
//     clearly labeled as a model extraction — never presented as the official count.
//
// Every candidate figure passes gateCasualty() (the in-memory ingestion filter:
// markup/spam/XSS on text + numeric/enum/timestamp sanity) BEFORE it touches D1.
// We only INSERT when a source's figure CHANGES, so the timeline stays meaningful
// and an hourly poll never floods the table with identical rows.

import type { Env } from '../types';
import { uid, recordIngest } from '../lib/db';
import { gateCasualty, type CasualtyRowInput } from './casualty-gate';
import { logAgentActivity } from '../lib/agent-activity';

/** The active event the public dashboard defaults to. */
export const CURRENT_EVENT_ID = 've-eq-2026-06-24';

// USGS event ids for the twin earthquakes (verified live).
const USGS_EVENTS = [
  { id: 'us6000t7zp', label: 'Mw 7,5 — 28 km SE de Yumare' }, // mainshock
  { id: 'us6000t7zc', label: 'Mw 7,2 — 24 km ENE de San Felipe' }, // foreshock
];
const USGS_EVENT_API = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
const RELIEFWEB_DISASTER = 'https://api.reliefweb.int/v1/disasters?appname=sismo911&query[value]=eq-2026-000093-ven&limit=1';

// Alert color → transparent modeled fatality FLOOR (mirrors src/lib/pager.ts
// fatalitiesBand: red 1.000+, orange 100–999, yellow 1–99, green 0).
const ALERT_FLOOR: Record<string, number> = { red: 1000, orange: 100, yellow: 1, green: 0 };

// AI extraction sources: the continuously-updated LEAD summaries of the event
// article as plaintext via the MediaWiki extracts API — a single stable JSON call
// each, no scraping. Workers AI reads the prose and extracts figures; it NEVER
// invents (a figure absent from the text comes back null and is skipped).
const AI_SOURCES = [
  { url: 'https://en.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&exintro=1&explaintext=1&redirects=1&titles=2026_Venezuela_earthquakes', cite: 'https://en.wikipedia.org/wiki/2026_Venezuela_earthquakes' },
  { url: 'https://es.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&exintro=1&explaintext=1&redirects=1&titles=Terremotos_de_Venezuela_de_2026', cite: 'https://es.wikipedia.org/wiki/Terremotos_de_Venezuela_de_2026' },
];
const DEFAULT_AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const AI_METRIC_LABEL: Record<string, string> = {
  dead: 'Fallecidos', injured: 'Heridos', missing: 'Desaparecidos', displaced: 'Desplazados/damnificados',
};

const UA = 'SISMO911/1.0 (+https://sismo911.com; casualty-poller)';

type AiNum = { min: number | null; max: number | null };
interface AiCasualties { dead?: AiNum; injured?: AiNum; missing?: AiNum; displaced?: AiNum; as_of?: string | null }

/** Pull the plaintext lead extract out of a MediaWiki extracts API response. */
function extractLead(j: any): string {
  const pages = j?.query?.pages;
  if (!pages || typeof pages !== 'object') return '';
  for (const k of Object.keys(pages)) {
    const ex = pages[k]?.extract;
    if (typeof ex === 'string' && ex.trim()) return ex.trim();
  }
  return '';
}

/** Non-negative integer or null — drops decimals/NaN/negatives the model may emit. */
function intOrNull(n: unknown): number | null {
  if (n == null) return null;
  const v = Number(n);
  return Number.isFinite(v) && Number.isInteger(v) && v >= 0 ? v : null;
}

/**
 * Extract casualty figures from event-summary prose with Workers AI. Returns the
 * raw parsed object (figures NOT yet gated) or null. The model is instructed to
 * return null for any figure absent from the text — no fabrication.
 */
async function extractCasualtiesAI(env: Env, text: string): Promise<AiCasualties | null> {
  const ai = env.AI;
  if (!ai) return null;
  const model = env.CASUALTY_AI_MODEL || DEFAULT_AI_MODEL;
  const sys = `Eres un extractor de datos preciso. Lees texto periodístico sobre los terremotos de Venezuela del 24 de junio de 2026 y devuelves SOLO un objeto JSON con las cifras de víctimas que el texto declara EXPLÍCITAMENTE. NUNCA inventes ni estimes: si una cifra no aparece en el texto, devuelve null. Los números son enteros sin separadores de miles.`;
  const user = `Extrae las cifras de: fallecidos (dead), heridos (injured), desaparecidos (missing) y desplazados/damnificados (displaced). Si el texto da "al menos N" usa min=N, max=null; si da un rango N–M usa min=N, max=M; si da un solo número N usa min=N, max=N. Devuelve SOLO este objeto:
{"dead":{"min":int|null,"max":int|null},"injured":{"min":int|null,"max":int|null},"missing":{"min":int|null,"max":int|null},"displaced":{"min":int|null,"max":int|null},"as_of":"fecha mencionada en el texto o null"}

TEXTO:
${text.slice(0, 4000)}`;
  try {
    const resp: any = await ai.run(model, {
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      max_tokens: 400, temperature: 0,
    });
    const cands = [
      resp?.choices?.[0]?.message?.content,
      resp?.response,
      resp?.result?.response,
      typeof resp === 'string' ? resp : '',
    ].filter((x) => typeof x === 'string') as string[];
    const t = (cands.find((x) => x.includes('{')) || cands[0] || '').trim();
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a === -1 || b === -1) { console.error('[casualties] AI no-json:', JSON.stringify(resp).slice(0, 300)); return null; }
    return JSON.parse(t.slice(a, b + 1)) as AiCasualties;
  } catch (e: any) {
    console.error('[casualties] extractCasualtiesAI failed:', e?.message ?? e);
    return null;
  }
}

async function fetchJson(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, accept: 'application/json' } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/** Latest stored figure for a source+metric (to decide whether anything changed). */
async function latestValue(
  env: Env, eventId: string, sourceKey: string, metric: string,
): Promise<{ value_min: number; value_max: number | null } | null> {
  return env.DB.prepare(
    `SELECT value_min, value_max FROM casualty_reports
     WHERE event_id = ? AND source_key = ? AND metric = ?
     ORDER BY as_of_ms DESC LIMIT 1`,
  ).bind(eventId, sourceKey, metric).first<{ value_min: number; value_max: number | null }>().catch(() => null);
}

/** Gate a candidate row and insert it only if the figure changed. Returns 1/0. */
async function recordIfChanged(env: Env, eventId: string, input: CasualtyRowInput): Promise<number> {
  const gated = gateCasualty(input);
  if (!gated.ok) {
    console.log(`[casualties] dropped ${input.source_key}/${input.metric}: ${gated.reason} ${gated.detail}`);
    return 0;
  }
  const r = gated.row;
  const prev = await latestValue(env, eventId, r.source_key, r.metric);
  if (prev && prev.value_min === r.value_min && (prev.value_max ?? null) === (r.value_max ?? null)) {
    return 0; // unchanged — don't flood the timeline
  }
  await env.DB.prepare(
    `INSERT INTO casualty_reports
       (id, event_id, source_key, metric, value_min, value_max, as_of_ms, confidence, citation_url, note, method, ingested_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'cron', ?)`,
  ).bind(
    uid('cas'), eventId, r.source_key, r.metric, r.value_min, r.value_max,
    r.as_of_ms, r.confidence, r.citation_url, r.note, Date.now(),
  ).run();
  return 1;
}

/**
 * Scheduled trailing poll — runs hourly. Never throws: a failed external source
 * is logged and the rest still run (No-Pre-Existing-Failure: a real error is
 * surfaced via recordIngest, not swallowed silently).
 */
export async function ingestCasualties(env: Env): Promise<{ written: number; usgs: number; reliefweb: boolean; ai: number }> {
  let written = 0;
  let usgsOk = 0;
  let reliefweb = false;
  let aiFigures = 0;
  const now = Date.now();

  try {
    // ── USGS PAGER: live alert color → modeled fatality floor ────────────────
    let worstFloor = -1;
    let worstNote = '';
    let citation = 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000t7zp/pager';
    for (const ev of USGS_EVENTS) {
      const j = await fetchJson(`${USGS_EVENT_API}?eventid=${ev.id}&format=geojson`);
      const alert = String(j?.properties?.alert ?? '').toLowerCase();
      if (!(alert in ALERT_FLOOR)) continue;
      usgsOk++;
      const floor = ALERT_FLOOR[alert];
      if (floor > worstFloor) {
        worstFloor = floor;
        worstNote = `Alerta ${alert.toUpperCase()} PAGER (${ev.label}); banda modelada de fallecidos.`;
        if (j?.properties?.detail) citation = String(j.properties.detail);
      }
    }
    if (worstFloor >= 0) {
      written += await recordIfChanged(env, CURRENT_EVENT_ID, {
        source_key: 'usgs_pager', source_name: 'USGS PAGER', metric: 'dead',
        value_min: worstFloor, value_max: null, as_of_ms: now, confidence: 0.9,
        citation_url: citation, note: worstNote,
      });
    }

    // ── ReliefWeb / OCHA reachability (freshness signal; no fabricated figure) ─
    const rw = await fetchJson(RELIEFWEB_DISASTER);
    reliefweb = Array.isArray(rw?.data) && rw.data.length > 0;

    // ── AI extraction over the live event summary (news-aggregating prose) ────
    // Read en+es lead extracts, let Workers AI pull the confirmed figures. Each
    // is gated, stored at modest confidence, and labeled a model extraction.
    let corpus = '';
    let aiCite = AI_SOURCES[0].cite;
    for (const s of AI_SOURCES) {
      const txt = extractLead(await fetchJson(s.url));
      if (txt) corpus += `\n\n${txt}`;
    }
    if (corpus.trim().length > 80) {
      const ext = await extractCasualtiesAI(env, corpus.trim());
      if (ext) {
        const rawAsOf = ext.as_of == null ? '' : String(ext.as_of).slice(0, 40);
        // Keep only plain date-ish text in the note (no markup; gate would reject anyway).
        const asOfNote = /[<>]/.test(rawAsOf) || !rawAsOf.trim() ? '' : ` (al ${rawAsOf.trim()})`;
        for (const metric of ['dead', 'injured', 'missing', 'displaced'] as const) {
          const cell = ext[metric];
          const vmin = intOrNull(cell?.min);
          if (vmin == null) continue;
          const vmaxRaw = intOrNull(cell?.max);
          const written0 = written;
          written += await recordIfChanged(env, CURRENT_EVENT_ID, {
            source_key: 'ai_extract', source_name: 'Extracción IA — resumen de medios (Wikipedia)',
            metric, value_min: vmin, value_max: vmaxRaw != null && vmaxRaw >= vmin ? vmaxRaw : null,
            as_of_ms: now, confidence: 0.6, citation_url: aiCite,
            note: `${AI_METRIC_LABEL[metric]} extraído por IA del resumen del evento${asOfNote}; cifra modelada, no conteo oficial.`,
          });
          if (written > written0) aiFigures++;
        }
        // Label the source nicely in the registry (the dashboard LEFT JOINs it).
        if (aiFigures > 0) {
          await env.DB.prepare(
            `INSERT OR IGNORE INTO casualty_sources (source_key, name, tier, kind, default_confidence)
             VALUES ('ai_extract', 'Extracción IA — resumen de medios (Wikipedia)', 3, 'model', 0.6)`,
          ).run().catch(() => {});
        }
      }
    }

    await recordIngest(env, 'casualties', true, written,
      reliefweb ? undefined : 'reliefweb_unreachable');
  } catch (err: any) {
    await recordIngest(env, 'casualties', false, written, String(err?.message ?? err));
    // Do not rethrow: a poll failure must not abort the rest of the :45 group.
  }

  // CRM tracking — hourly toll poll.
  await logAgentActivity(env, {
    source: 'casualties', action: 'poll', fetched: usgsOk, updated: written,
    summary: `🤖 Balance — ${written} cifra(s) actualizada(s) (USGS PAGER ${usgsOk}; IA ${aiFigures}; ReliefWeb ${reliefweb ? 'OK' : 'sin alcance'}).`,
  });
  return { written, usgs: usgsOk, reliefweb, ai: aiFigures };
}
