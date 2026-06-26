import type { Env } from '../types';

// Photo-analysis enrichment pass for `personas` (RAV + any photo-bearing row).
//
// For each photo we compute TWO things, both bounded per run to respect the
// Worker subrequest/CPU budget:
//   1. photo_phash — SHA-256 of the image bytes (crypto.subtle, no deps). This
//      is a CONTENT hash, not a true perceptual hash: it collapses byte-identical
//      images that aggregators re-host at DIFFERENT URLs (the common cross-source
//      duplicate), which same-URL dedupe alone misses. The dedupePersonas
//      `phash` mode then removes those duplicate rows.
//   2. photo_caption + photo_flags — Workers AI vision describes the image and
//      flags it (person / non_person / placeholder / low_quality), enriching the
//      case and letting operators spot junk (logos, screenshots, blank avatars).
//
// Query-driven (WHERE photo_caption IS NULL), so it needs no cursor and is
// idempotent: successive cron ticks grind down the backlog.

const VISION_MODEL_DEFAULT = '@cf/meta/llama-3.2-11b-vision-instruct';
const BATCH = 24;   // per cron tick; the backfill drives larger batches via /api/rav/run?kind=photos
const PROMPT =
  `Eres analista del registro de desaparecidos SISMO911. Describe esta foto en UNA frase breve en español ` +
  `(¿es una persona? ¿rostro visible? ¿edad/sexo aparente?). Luego, en una segunda línea exacta, clasifica con ` +
  `UNA etiqueta: PERSONA (foto real de una persona), NO_PERSONA (objeto, logo, captura, mapa, texto), ` +
  `PLACEHOLDER (avatar genérico/silueta/imagen vacía) o BAJA_CALIDAD (borrosa/ilegible). ` +
  `Formato:\nDESCRIPCION: <frase>\nCLASE: <etiqueta>`;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function parseVision(text: string): { caption: string; flag: string } {
  const desc = /DESCRIPCION:\s*(.+)/i.exec(text)?.[1]?.trim() || text.trim().split('\n')[0]?.slice(0, 240) || '';
  const cls = /CLASE:\s*([A-Z_]+)/i.exec(text)?.[1]?.toUpperCase() || '';
  const flag = cls.includes('NO_PERSONA') ? 'non_person'
    : cls.includes('PLACEHOLDER') ? 'placeholder'
    : cls.includes('BAJA') ? 'low_quality'
    : cls.includes('PERSONA') ? 'person' : 'unknown';
  return { caption: desc.slice(0, 240), flag };
}

function mergeTags(tagsJson: string | null, photoFlag: string): string {
  let tags: string[] = [];
  try { const p = JSON.parse(tagsJson || '[]'); if (Array.isArray(p)) tags = p.map(String); } catch { /* reset */ }
  tags = tags.filter((t) => !t.startsWith('photo:'));
  tags.push(`photo:${photoFlag}`);
  return JSON.stringify([...new Set(tags)]);
}

export interface RavPhotoResult { scanned: number; analyzed: number; hashed: number; failed: number; }

export async function analyzeRavPhotos(env: Env, batch = BATCH): Promise<RavPhotoResult> {
  if (!env.AI) { console.warn('[rav-photos] no AI binding — skip'); return { scanned: 0, analyzed: 0, hashed: 0, failed: 0 }; }
  const model = (env as any).RAV_VISION_MODEL || VISION_MODEL_DEFAULT;
  const { results } = await env.DB.prepare(
    `SELECT id, foto, tags FROM personas
     WHERE trim(coalesce(foto,'')) <> '' AND photo_caption IS NULL
     ORDER BY updated_at DESC LIMIT ?`,
  ).bind(Math.min(Math.max(batch, 1), 25)).all<{ id: string; foto: string; tags: string | null }>();
  const rows = results ?? [];
  let analyzed = 0, hashed = 0, failed = 0;

  for (const row of rows) {
    try {
      const res = await fetch(row.foto);
      if (!res.ok) { failed++; continue; }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!bytes.length) { failed++; continue; }
      const phash = await sha256Hex(bytes);

      let caption = ''; let flag = 'unknown';
      try {
        const out: any = await env.AI.run(model, { prompt: PROMPT, image: Array.from(bytes), max_tokens: 160 });
        const text = out?.response ?? out?.choices?.[0]?.message?.content ?? '';
        ({ caption, flag } = parseVision(String(text)));
        if (caption) analyzed++;
      } catch (e: any) { console.warn('[rav-photos] vision failed', row.id, e?.message ?? e); }

      await env.DB.prepare(
        `UPDATE personas SET photo_phash=?, photo_caption=?, photo_flags=?, tags=? WHERE id=?`,
      ).bind(phash, caption || '(sin descripción)', JSON.stringify([flag]), mergeTags(row.tags, flag), row.id).run();
      hashed++;
    } catch (e: any) { failed++; console.warn('[rav-photos] failed', row.id, e?.message ?? e); }
  }
  console.log(`[rav-photos] scanned ${rows.length}: hashed ${hashed}, captioned ${analyzed}, failed ${failed}`);
  return { scanned: rows.length, analyzed, hashed, failed };
}
