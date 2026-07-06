// SISMO911 — Telegram intake: extract structured fields from the media.
// ---------------------------------------------------------------------------
// Fully in-edge, Workers AI only (no external API):
//   1. env.AI.toMarkdown() OCRs the PDF or image to markdown text (Spanish image
//      descriptions), handling cédulas, missing-person flyers and reports alike.
//   2. A text model structures that markdown into the fields we store. The model
//      is instructed to return null (never invent) for anything not present.
//
// toMarkdown lives on the experimental Workers-types surface; the binding is
// cast where called (same style as the existing `const out: any = env.AI.run`).

import type { Env } from '../../types';
import type { ExtractedRecord, IntakeMedia } from './types';
import { DOCX_MIME, extractDocxText } from './docx';
import { cleanOcrName } from '../../lib/ocr-normalize';

const STRUCT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const EMPTY: ExtractedRecord = {
  nombre: null,
  cedula: null,
  edad: null,
  ubicacion: null,
  fecha: null,
  contacto: null,
  descripcion: null,
};

const SYS = `Eres un extractor de datos para un sistema de personas desaparecidas en Venezuela.
Recibes el TEXTO (OCR) de una foto o PDF: puede ser una cédula, un volante de persona desaparecida, o un reporte.
Devuelve SOLO un objeto JSON válido con exactamente estas claves. Usa null cuando el dato NO aparezca. NUNCA inventes datos.
{"nombre":string|null,"cedula":string|null,"edad":number|null,"ubicacion":string|null,"fecha":string|null,"contacto":string|null,"descripcion":string|null}
Reglas:
- cedula: SOLO dígitos (sin "V-", sin puntos). Si no hay cédula, null.
- nombre: nombre completo de la persona desaparecida o identificada.
- edad: número entero de años, o null.
- ubicacion: última ubicación conocida, ciudad o estado.
- fecha: fecha de desaparición o del evento tal cual aparezca.
- contacto: teléfono o correo de contacto si aparece.
- descripcion: rasgos físicos, vestimenta o notas relevantes.
- Si un dato es ilegible o el OCR está corrupto, usa null — NUNCA adivines ni "repares" un nombre.
Responde únicamente con el JSON, sin texto adicional.`;

/** Best-effort JSON extraction: parse the first {...} block. */
function parseJson(raw: string): Record<string, unknown> | null {
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try {
    return JSON.parse(raw.slice(s, e + 1));
  } catch {
    return null;
  }
}

function str(v: unknown, max: number): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t ? t.slice(0, max) : null;
}

function intOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? '').replace(/\D/g, ''), 10);
  // 0 is a legitimate age (an infant) — the July-5 roster had "0 años".
  return Number.isFinite(n) && n >= 0 && n < 130 ? Math.trunc(n) : null;
}

export function normalize(obj: Record<string, unknown> | null): ExtractedRecord {
  if (!obj) return { ...EMPTY };
  const cedRaw = str(obj.cedula, 20);
  const cedula = cedRaw ? cedRaw.replace(/\D/g, '').slice(0, 9) || null : null;
  // OCR hygiene on the name: strip junk, flag (never rewrite) suspect text.
  const cleaned = cleanOcrName(str(obj.nombre, 140));
  return {
    nombre: cleaned.name,
    cedula,
    edad: intOrNull(obj.edad),
    ubicacion: str(obj.ubicacion, 200),
    fecha: str(obj.fecha, 60),
    contacto: str(obj.contacto, 160),
    descripcion: str(obj.descripcion, 1000),
    ...(cleaned.flags.length ? { ocrFlags: cleaned.flags } : {}),
  };
}

/** OCR the media to markdown via Workers AI toMarkdown (PDF + image). Empty string on failure.
 *  `maxChars` bounds the returned text: the single-record path keeps ~8k (one cédula/flyer),
 *  the bulk roster path passes a much larger cap so a multi-page padrón isn't truncated.
 *  DOCX is parsed natively FIRST (deterministic, no AI call — see docx.ts for why);
 *  toMarkdown stays as the fallback in case the file is a mislabeled/odd variant. */
export async function markdownFromMedia(env: Env, media: IntakeMedia, maxChars = 8000): Promise<string> {
  if (media.mime === DOCX_MIME) {
    const text = await extractDocxText(media.bytes);
    if (text) return text.slice(0, maxChars);
  }
  const ai = env.AI as unknown as {
    toMarkdown?: (
      files: Array<{ name: string; blob: Blob }>,
      options?: { conversionOptions?: { image?: { descriptionLanguage?: string } } },
    ) => Promise<Array<{ format?: string; data?: string; error?: string }>>;
  };
  if (!ai?.toMarkdown) return '';
  const blob = new Blob([media.bytes], { type: media.mime });
  const out = await ai
    .toMarkdown([{ name: media.fileName, blob }], { conversionOptions: { image: { descriptionLanguage: 'es' } } })
    .catch(() => null);
  const first = Array.isArray(out) ? out[0] : null;
  if (!first || first.format !== 'markdown') return '';
  return String(first.data || '').slice(0, maxChars);
}

/** Extract structured fields. Never throws — returns EMPTY on any failure. */
export async function extractFields(env: Env, media: IntakeMedia): Promise<{ fields: ExtractedRecord; ocr: string }> {
  if (!env.AI) return { fields: { ...EMPTY }, ocr: '' };
  const ocr = await markdownFromMedia(env, media);
  if (!ocr.trim()) return { fields: { ...EMPTY }, ocr: '' };
  try {
    const out = (await env.AI.run(STRUCT_MODEL as never, {
      messages: [
        { role: 'system', content: SYS },
        { role: 'user', content: ocr },
      ],
      max_tokens: 400,
    } as never)) as { response?: unknown; result?: { response?: unknown } };
    const raw = out?.response ?? out?.result?.response;
    const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : parseJson(String(raw ?? ''));
    return { fields: normalize(obj), ocr };
  } catch {
    return { fields: { ...EMPTY }, ocr };
  }
}
