import type { Env } from '../types';
import { chunk } from '../lib/sql';

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

// AI-free content-hash backfill so the dedupePersonas `phash` mode can actually
// run. analyzeRavPhotos welds photo_phash to the slow Workers-AI vision call on a
// single `photo_caption IS NULL` queue (24/tick), so populating ~58k photos would
// take MONTHS and the phash dedupe stays a no-op. This pass hashes ONLY rows that
// already have a reliable R2 mirror — bytes are always available, so there's no
// dead-URL handling, no AI, no quota: R2 get + SHA-256 + a batched UPDATE. It
// never writes a sentinel into photo_phash (the dedupe groups by it, so a sentinel
// would collapse every failed row into one bogus duplicate group) — failures just
// leave the row NULL to retry. Query-driven + idempotent; the cron grinds it down.
// Leaves photo_caption untouched, so the vision queue is unaffected.
export async function backfillPhashes(
  env: Env,
  batch = 250,
): Promise<{ scanned: number; hashed: number; failed: number; remaining: number }> {
  if (!env.DESAP_FOTOS) return { scanned: 0, hashed: 0, failed: 0, remaining: 0 };
  const lim = Math.min(Math.max(batch, 1), 400);
  const phashPending = `(photo_phash IS NULL OR trim(photo_phash) = '') AND trim(coalesce(foto_r2,'')) <> ''`;
  const { results } = await env.DB.prepare(
    `SELECT id, foto_r2 FROM personas WHERE ${phashPending} ORDER BY updated_at DESC LIMIT ?`,
  ).bind(lim).all<{ id: string; foto_r2: string }>();
  const rows = results ?? [];
  let failed = 0;
  const updates: D1PreparedStatement[] = [];
  for (const row of rows) {
    try {
      const o = await env.DESAP_FOTOS.get(row.foto_r2);
      const buf = o ? new Uint8Array(await o.arrayBuffer()) : null;
      if (!buf || !buf.length) { failed++; continue; }
      const phash = await sha256Hex(buf);
      updates.push(env.DB.prepare(`UPDATE personas SET photo_phash = ? WHERE id = ?`).bind(phash, row.id));
    } catch (e: any) { failed++; console.warn('[phash-backfill] failed', row.id, e?.message ?? e); }
  }
  // Batch the writes (≤50/statement-group) so N hashes cost a few D1 subrequests,
  // not N — keeps the cron tick well under the Worker subrequest budget.
  for (const part of chunk(updates, 50)) await env.DB.batch(part);
  const remaining = (await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM personas WHERE ${phashPending}`,
  ).first<{ n: number }>())?.n ?? 0;
  console.log(`[phash-backfill] scanned ${rows.length}: hashed ${updates.length}, failed ${failed}, remaining ${remaining}`);
  return { scanned: rows.length, hashed: updates.length, failed, remaining };
}

export interface RavPhotoResult { scanned: number; analyzed: number; hashed: number; failed: number; }

export async function analyzeRavPhotos(env: Env, batch = BATCH): Promise<RavPhotoResult> {
  if (!env.AI) { console.warn('[rav-photos] no AI binding — skip'); return { scanned: 0, analyzed: 0, hashed: 0, failed: 0 }; }
  const model = (env as any).RAV_VISION_MODEL || VISION_MODEL_DEFAULT;
  const { results } = await env.DB.prepare(
    `SELECT id, foto, foto_r2, tags FROM personas
     WHERE trim(coalesce(foto,'')) <> '' AND photo_caption IS NULL
     ORDER BY updated_at DESC LIMIT ?`,
  ).bind(Math.min(Math.max(batch, 1), 25)).all<{ id: string; foto: string; foto_r2: string | null; tags: string | null }>();
  const rows = results ?? [];
  let analyzed = 0, hashed = 0, failed = 0;

  // Fetch the image bytes: prefer the self-hosted R2 mirror (reliable) over the
  // external URL (often dead/hotlink-protected on these citizen aggregators).
  const getBytes = async (row: { foto: string; foto_r2: string | null }): Promise<Uint8Array | null> => {
    if (row.foto_r2 && env.DESAP_FOTOS) {
      try { const o = await env.DESAP_FOTOS.get(row.foto_r2); if (o) { const b = new Uint8Array(await o.arrayBuffer()); if (b.length) return b; } } catch { /* fall through to URL */ }
    }
    try { const r = await fetch(row.foto); if (r.ok) { const b = new Uint8Array(await r.arrayBuffer()); if (b.length) return b; } } catch { /* unreachable */ }
    return null;
  };

  for (const row of rows) {
    try {
      const bytes = await getBytes(row);
      if (!bytes) {
        // Mark unreachable so the queue ADVANCES (never block on dead URLs); the
        // 'unreachable' flag lets a future sweep retry these if photos are mirrored.
        failed++;
        await env.DB.prepare(
          `UPDATE personas SET photo_caption=?, photo_flags=?, tags=? WHERE id=?`,
        ).bind('(foto no accesible)', JSON.stringify(['unreachable']), mergeTags(row.tags, 'unreachable'), row.id).run();
        continue;
      }
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
