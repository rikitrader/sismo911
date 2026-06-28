import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { rateLimit, validLatLon } from '../lib/security';
import { scanFile } from '../security/file-scan';

export const damage = new Hono<{ Bindings: Env }>();

const VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const SEVERITIES = ['ninguno', 'leve', 'moderado', 'grave', 'severo'];

const PROMPT = `Eres un inspector de Protección Civil evaluando daños estructurales tras un sismo en Venezuela. Analiza la imagen y responde EN ESPAÑOL en este formato exacto:
SEVERIDAD: <ninguno|leve|moderado|grave|severo>
RESUMEN: <2-3 frases sobre el daño visible>
PELIGROS: <lista separada por comas de peligros: grietas estructurales, colapso, vidrios rotos, fuga, incendio, etc.>
ACCIÓN: <recomendación inmediata>
Si la imagen no muestra una estructura o daño, indica SEVERIDAD: indeterminado.`;

function parseAssessment(text: string) {
  const grab = (label: string) => {
    const m = text.match(new RegExp(label + ':\\s*(.+)', 'i'));
    return m ? m[1].trim() : '';
  };
  let sev = grab('SEVERIDAD').toLowerCase();
  sev = SEVERITIES.find((s) => sev.includes(s)) || 'indeterminado';
  const hazards = grab('PELIGROS').split(',').map((h) => h.trim()).filter(Boolean);
  return { severity: sev, hazards, action: grab('ACCIÓN') };
}

// POST /api/damage — multipart (field "photo") or JSON { imageBase64, lat, lon }
damage.post('/', async (c) => {
  const limited = await rateLimit(c.env, c, 'damage_post', 6, 300);
  if (limited) return limited;
  if (!c.env.AI) return c.json({ error: 'ai_unavailable', hint: 'Workers AI no configurado' }, 503);

  let bytes: Uint8Array | null = null;
  let contentType = 'image/jpeg';
  let lat: number | null = null, lon: number | null = null, reporter: string | null = null;

  const ct = c.req.header('content-type') || '';
  if (ct.includes('multipart/form-data')) {
    const form = await c.req.formData();
    const file = form.get('photo') as any;
    if (file && typeof file !== 'string' && typeof file.arrayBuffer === 'function') {
      bytes = new Uint8Array(await file.arrayBuffer());
      contentType = file.type || contentType;
    }
    lat = form.get('lat') ? Number(form.get('lat')) : null;
    lon = form.get('lon') ? Number(form.get('lon')) : null;
    reporter = (form.get('reporter') as string) || null;
  } else {
    const b = await c.req.json().catch(() => null);
    if (b?.imageBase64) {
      const raw = b.imageBase64.replace(/^data:[^;]+;base64,/, '');
      let bin = '';
      try { bin = atob(raw); } catch { return c.json({ error: 'invalid_base64' }, 400); }
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      contentType = b.contentType || contentType;
    }
    lat = b?.lat ?? null; lon = b?.lon ?? null; reporter = b?.reporter ?? null;
  }
  if (!bytes || !bytes.length) return c.json({ error: 'no_image' }, 400);
  if (bytes.length > 6_000_000) return c.json({ error: 'image_too_large', maxBytes: 6_000_000 }, 413);
  // Full upload scan (magic-byte ↔ MIME agreement, no executable/SVG/polyglot) —
  // not just the lightweight isImageBytes() check. Trust the sniffed type, not the
  // client's claimed Content-Type.
  const scan = await scanFile(bytes, { maxSize: 6_000_000, declaredMime: contentType, allowSvg: false });
  if (!scan.ok) return c.json({ error: 'unsupported_image_type', reason: scan.reason }, 415);
  contentType = `image/${scan.detectedType}`;
  if ((lat != null || lon != null) && !validLatLon(Number(lat), Number(lon))) return c.json({ error: 'bad_lat_lon' }, 400);

  // Run the vision model (image as array of 0-255 bytes per the model schema).
  let raw = '';
  try {
    const r: any = await c.env.AI.run(VISION_MODEL, {
      prompt: PROMPT,
      image: Array.from(bytes),
      max_tokens: 320,
    });
    raw = r.response ?? r.description ?? '';
  } catch (e: any) {
    console.error('[damage] ai assessment failed:', e?.message ?? e);
    return c.json({ error: 'ai_failed' }, 502);
  }
  const parsed = parseAssessment(raw);

  // Persist photo (KV) + report (D1).
  const id = uid('dmg');
  const photoKey = `photo/${id}`;
  await c.env.PHOTOS.put(photoKey, bytes, { metadata: { contentType } });
  await c.env.DB.prepare(
    `INSERT INTO damage_reports (id,photo_key,content_type,severity,summary,hazards,lat,lon,event_id,ai_model,reporter,created_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, photoKey, contentType, parsed.severity, raw.slice(0, 4000), JSON.stringify(parsed.hazards), lat, lon, null, VISION_MODEL, reporter ? reporter.slice(0, 120) : null, Date.now()).run();

  return c.json({ ok: true, id, photoUrl: `/api/damage/photo/${id}`, severity: parsed.severity, hazards: parsed.hazards, action: parsed.action, summary: raw }, 201);
});

// GET /api/damage — recent assessments
damage.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, severity, summary, hazards, lat, lon, created_ms FROM damage_reports ORDER BY created_ms DESC LIMIT 100`
  ).all();
  return c.json({ reports: results ?? [] });
});

// GET /api/damage/photo/:id — serve the stored image
damage.get('/photo/:id', async (c) => {
  const row: any = await c.env.DB.prepare(`SELECT photo_key, content_type FROM damage_reports WHERE id = ?`).bind(c.req.param('id')).first();
  if (!row) return c.notFound();
  const obj = await c.env.PHOTOS.get(row.photo_key, 'arrayBuffer');
  if (!obj) return c.notFound();
  return new Response(obj, {
    headers: {
      'Content-Type': row.content_type || 'image/jpeg',
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    },
  });
});
