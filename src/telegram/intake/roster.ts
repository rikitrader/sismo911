// SISMO911 — Telegram/console intake: extract a LIST of people from a roster.
// ---------------------------------------------------------------------------
// The single-record extractor (extract.ts) is built for one cédula/flyer and
// structures ONE person. A "padrón" / multi-page expediente lists MANY people,
// so this path:
//   1. OCRs the whole document to markdown (large cap, not the 8k single cap).
//   2. Splits the markdown into line-bounded chunks (one Workers-AI call each,
//      hard-capped so a huge doc can't blow the subrequest budget).
//   3. Asks the text model for a JSON ARRAY of people per chunk, normalizes each
//      with the same rules as the single path, and de-dupes within the job.
//
// Never throws — returns [] on any failure (caller treats [] as "no names read").

import type { Env } from '../../types';
import type { ExtractedRecord, IntakeMedia } from './types';
import { markdownFromMedia, normalize } from './extract';
import { normalizeName } from '../../lib/search-normalize';

const STRUCT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const MAX_OCR_CHARS = 40000; // far more than the single-record path (8k) — a padrón is long.
const CHUNK_CHARS = 3500; // per struct-model call (leaves room for the array reply).
const MAX_CHUNKS = 24; // hard cap on AI calls per job (subrequest + CPU budget guard).
const MAX_RECORDS = 500; // safety cap on people created from one document.

const SYS = `Eres un extractor de datos de un sistema de personas desaparecidas en Venezuela.
Recibes TEXTO (OCR) de un documento que puede listar MUCHAS personas (un padrón o expediente de varias páginas).
Devuelve SOLO un ARRAY JSON. Cada elemento es UNA persona con EXACTAMENTE estas claves. Usa null cuando el dato NO aparezca. NUNCA inventes datos.
[{"nombre":string|null,"cedula":string|null,"edad":number|null,"ubicacion":string|null,"fecha":string|null,"contacto":string|null,"descripcion":string|null}]
Reglas:
- Una entrada por persona listada. Si aparecen 30 nombres, devuelve 30 entradas.
- cedula: SOLO dígitos (sin "V-", sin puntos). Si no hay, null.
- Si el texto no contiene personas, devuelve [].
Responde únicamente con el ARRAY JSON, sin texto adicional.`;

/** Parse the first [...] block as a JSON array. */
function parseArray(raw: string): unknown[] {
  const s = raw.indexOf('[');
  const e = raw.lastIndexOf(']');
  if (s < 0 || e <= s) return [];
  try {
    const v = JSON.parse(raw.slice(s, e + 1));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Split OCR markdown into line-bounded chunks of ~CHUNK_CHARS, capped at MAX_CHUNKS. */
export function chunkText(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const chunks: string[] = [];
  let buf = '';
  for (const line of lines) {
    if (buf.length + line.length + 1 > CHUNK_CHARS && buf) {
      chunks.push(buf);
      buf = '';
      if (chunks.length >= MAX_CHUNKS) return chunks;
    }
    buf += (buf ? '\n' : '') + line;
  }
  if (buf && chunks.length < MAX_CHUNKS) chunks.push(buf);
  return chunks;
}

/** Dedupe key: cédula wins; otherwise the normalized name. */
function keyFor(rec: ExtractedRecord): string | null {
  if (rec.cedula) return `c:${rec.cedula}`;
  if (rec.nombre) {
    const n = normalizeName(rec.nombre);
    return n ? `n:${n}` : null;
  }
  return null;
}

/**
 * Extract every person named in the document. Returns a de-duplicated list;
 * empty array when OCR fails, AI is unavailable, or no names are found.
 */
export async function extractRoster(env: Env, media: IntakeMedia): Promise<ExtractedRecord[]> {
  if (!env.AI) return [];
  const ocr = (await markdownFromMedia(env, media, MAX_OCR_CHARS)).trim();
  return extractRosterFromText(env, ocr);
}

/**
 * Same chunk→AI→dedupe pipeline over raw text (a pasted list, not a file).
 * Used by the text-roster path when its deterministic parser reads too little.
 */
export async function extractRosterFromText(env: Env, text: string): Promise<ExtractedRecord[]> {
  if (!env.AI || !text.trim()) return [];
  const ocr = text.slice(0, MAX_OCR_CHARS);

  const chunks = chunkText(ocr);
  const out: ExtractedRecord[] = [];
  const seen = new Set<string>();

  for (const chunk of chunks) {
    let raw = '';
    try {
      const res = (await env.AI.run(STRUCT_MODEL as never, {
        messages: [
          { role: 'system', content: SYS },
          { role: 'user', content: chunk },
        ],
        max_tokens: 1800,
      } as never)) as { response?: unknown; result?: { response?: unknown } };
      const r = res?.response ?? res?.result?.response;
      raw = typeof r === 'string' ? r : JSON.stringify(r ?? '');
    } catch {
      continue; // one bad chunk never sinks the whole roster.
    }
    for (const item of parseArray(raw)) {
      const rec = normalize(item as Record<string, unknown> | null);
      if (!rec.nombre && !rec.cedula) continue; // skip empty/garbage rows.
      const key = keyFor(rec);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(rec);
      if (out.length >= MAX_RECORDS) return out;
    }
  }
  return out;
}
