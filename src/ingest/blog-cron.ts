import type { Env } from '../types';
import { fetchBlogSources, type SourceRecord } from './blog-sources';

// Always-on blog pipeline, run from the Worker's scheduled() handler so it
// publishes 24/7 regardless of any local machine. Every ~3h: fetch free
// sources (VE news RSS + YouTube + GDELT) → geolocate → dedupe vs blog_posts →
// write one Spanish field report per NEW item with Workers AI (env.AI) → insert.
//
// Honesty: each article derives from a REAL item (headline/caption, link,
// platform). Citizen/press reports are labelled unverified. No invented facts.

const EVERY_MS = 2.9 * 3600_000;     // gate: run at most ~every 3h
const MAX_NEW = 4;                    // posts per run
const LASTRUN_KEY = 'blog:cron:lastrun';
const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const EVENT_FACTS = 'Terremoto de magnitud 7,5 frente a la costa norte de Venezuela (cerca de Morón, Carabobo) el 24 de junio de 2026, 17:04 hora local (VET). Sismo somero sobre la falla de San Sebastián; sentido con fuerza en Caracas, La Guaira, Valencia y Maracay; reportes de daños estructurales y una alerta de tsunami inicial luego cancelada.';

// Compact Venezuela gazetteer (name → [lat, lon]).
const GAZ: Record<string, [number, number]> = {
  'moron': [10.49, -68.19], 'puerto cabello': [10.47, -68.01], 'carabobo': [10.18, -68], 'valencia': [10.16, -68],
  'guacara': [10.23, -67.88], 'yaracuy': [10.34, -68.74], 'san felipe': [10.34, -68.74], 'yumare': [10.62, -68.69],
  'caracas': [10.49, -66.88], 'distrito capital': [10.49, -66.88], 'chacao': [10.5, -66.85], 'petare': [10.48, -66.81],
  'catia': [10.51, -66.93], 'el valle': [10.45, -66.91], 'miranda': [10.25, -66.4], 'los teques': [10.34, -67.04],
  'guarenas': [10.47, -66.61], 'guatire': [10.47, -66.54], 'la guaira': [10.6, -66.93], 'vargas': [10.6, -66.93],
  'maiquetia': [10.59, -66.98], 'caraballeda': [10.61, -66.85], 'aragua': [10.24, -67.36], 'maracay': [10.25, -67.6],
  'la victoria': [10.23, -67.34], 'falcon': [11.4, -69.66], 'coro': [11.4, -69.67], 'punto fijo': [11.69, -70.2],
  'lara': [10.07, -69.32], 'barquisimeto': [10.07, -69.32], 'zulia': [10.4, -71.6], 'maracaibo': [10.65, -71.64],
  'merida': [8.6, -71.15], 'tachira': [7.77, -72.22], 'san cristobal': [7.77, -72.22], 'trujillo': [9.37, -70.43],
  'barinas': [8.62, -70.21], 'portuguesa': [9.04, -69.75], 'cojedes': [9.38, -68.31], 'guarico': [9.05, -67.35],
  'anzoategui': [9.3, -64.63], 'barcelona': [10.13, -64.69], 'puerto la cruz': [10.21, -64.63], 'sucre': [10.45, -63.23],
  'cumana': [10.45, -64.18], 'monagas': [9.75, -63.18], 'maturin': [9.75, -63.18], 'nueva esparta': [11, -63.85],
  'margarita': [11, -63.85], 'porlamar': [10.95, -63.85], 'bolivar': [8.12, -63.55], 'ciudad guayana': [8.35, -62.65],
  'apure': [7.89, -67.47], 'venezuela': [8, -66],
};
const norm = (s: string) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
function geolocate(caption: string): { place: string; lat: number; lon: number } {
  const t = norm(caption);
  let best: { name: string; ll: [number, number] } | null = null;
  for (const [name, ll] of Object.entries(GAZ)) {
    if (name === 'venezuela') continue;
    if (t.includes(norm(name)) && (!best || name.length > best.name.length)) best = { name, ll };
  }
  if (best) return { place: titleCase(best.name), lat: best.ll[0], lon: best.ll[1] };
  return { place: 'Venezuela', lat: 8, lon: -66 };
}
function slugify(s: string) {
  return norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'noticia';
}

// ---- Workers AI article writer ----
export async function writeArticle(env: Env, rec: SourceRecord & { place: string }): Promise<{ headline: string; meta_desc: string; body_html: string } | null> {
  const ai = env.AI;
  if (!ai) return null;
  const model = env.BLOG_AI_MODEL || DEFAULT_MODEL;
  const sys = `Eres redactor del medio de emergencia sísmica SISMO911 (Venezuela). Escribes noticias breves en español periodístico, sobrio y verificable. Devuelves SIEMPRE únicamente un objeto JSON válido, sin texto adicional ni fences.`;
  const user = `Contexto de fondo (NO es la noticia, solo referencia): ${EVENT_FACTS}

Tu tarea: redactar UNA noticia sobre ESTA publicación específica.
Reglas IMPORTANTES:
- El TITULAR debe describir el contenido CONCRETO de esta publicación (qué muestra o dice el video/artículo), NO un resumen genérico del terremoto. PROHIBIDO usar titulares genéricos como "Terremoto de magnitud 7,5 sacude Venezuela".
- 130-260 palabras; explica el contenido a partir del campo "texto"; cita el texto una vez entre comillas.
- Menciona los hechos de fondo solo de pasada; el foco es esta publicación. No inventes cifras de víctimas ni datos ausentes del texto.
- Atribuye a "${rec.author}" en "${rec.platform}". Marca el material como reporte SIN verificación independiente.
- Cierra con una línea de seguridad: activar una alerta SOS en sismo911.com/sos.

Devuelve SOLO: {"headline":"titular específico de esta publicación","meta_desc":"resumen de 1 frase, <=160 caracteres","body_html":"<p>...</p><p>...</p>"}

Publicación:
${JSON.stringify({ plataforma: rec.platform, medio_o_autor: rec.author, lugar: rec.place, texto: rec.caption.slice(0, 700) })}`;
  try {
    const resp: any = await ai.run(model, {
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      max_tokens: 900, temperature: 0.3,
    });
    // The model returns BOTH a plain-text `response` (no JSON) AND OpenAI-style
    // `choices[0].message.content` (the JSON). Pick whichever candidate actually
    // contains a brace, so we never grab the brace-less plain-text version.
    const cands = [
      resp?.choices?.[0]?.message?.content,
      resp?.response,
      resp?.result?.response,
      typeof resp === 'string' ? resp : '',
    ].filter((x) => typeof x === 'string') as string[];
    const text = (cands.find((x) => x.includes('{')) || cands[0] || '').trim();
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a === -1 || b === -1) { console.error('[blog-cron] AI no-json:', JSON.stringify(resp).slice(0, 300)); return null; }
    const obj = JSON.parse(text.slice(a, b + 1));
    if (!obj.headline || !obj.body_html) { console.error('[blog-cron] AI missing fields:', text.slice(0, 200)); return null; }
    return { headline: String(obj.headline), meta_desc: String(obj.meta_desc || ''), body_html: String(obj.body_html) };
  } catch (e: any) {
    console.error('[blog-cron] writeArticle failed:', e?.message ?? e);
    return null;
  }
}

async function upsert(env: Env, p: any): Promise<boolean> {
  try {
    await env.DB.prepare(
      `INSERT INTO blog_posts
         (slug, source_post_id, headline, meta_desc, body_html, place, lat, lon,
          platform, author, source_url, image_url, video_url, video_embed_html,
          views, likes, comments, featured, status, published_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(source_post_id) DO NOTHING`,
    ).bind(
      p.slug, p.source_post_id, p.headline, p.meta_desc, p.body_html, p.place, p.lat, p.lon,
      p.platform, p.author, p.source_url, p.image_url, p.video_url, '',
      0, 0, 0, p.featured ? 1 : 0, 'published', p.published_at,
    ).run();
    return true;
  } catch (e: any) {
    // slug collision on a different source → suffix + retry
    if (String(e?.message).includes('UNIQUE')) {
      try {
        p.slug = `${p.slug}-${String(p.source_post_id).replace(/\W+/g, '').slice(-6)}`;
        await env.DB.prepare(
          `INSERT OR IGNORE INTO blog_posts (slug, source_post_id, headline, meta_desc, body_html, place, lat, lon, platform, author, source_url, image_url, video_url, video_embed_html, views, likes, comments, featured, status, published_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).bind(p.slug, p.source_post_id, p.headline, p.meta_desc, p.body_html, p.place, p.lat, p.lon, p.platform, p.author, p.source_url, p.image_url, p.video_url, '', 0, 0, 0, p.featured ? 1 : 0, 'published', p.published_at).run();
        return true;
      } catch (e2: any) { console.error('[blog-cron] upsert retry failed:', e2?.message ?? e2); return false; }
    }
    console.error('[blog-cron] upsert failed:', e?.message ?? e);
    return false;
  }
}

export async function ingestBlog(env: Env, opts: { force?: boolean } = {}): Promise<{ ran: boolean; counts?: Record<string, number>; candidates?: number; published?: number }> {
  if (!env.AI) { console.error('[blog-cron] no AI binding; skipping'); return { ran: false }; }
  const now = Date.now();
  const last = Number(await env.CACHE.get(LASTRUN_KEY).catch(() => null)) || 0;
  if (!opts.force && now - last < EVERY_MS) return { ran: false }; // ~3h gate (cron fires hourly)

  const since = last || (now - 6 * 3600_000);
  const { candidates, counts } = await fetchBlogSources(env, since);
  console.log('[blog-cron] sources', JSON.stringify(counts), '→', candidates.length, 'candidates');
  if (!candidates.length) { await env.CACHE.put(LASTRUN_KEY, String(now)).catch(() => {}); return { ran: true, counts, candidates: 0, published: 0 }; }

  // dedupe vs already-published source ids
  const { results: existing } = await env.DB.prepare(
    `SELECT source_post_id FROM blog_posts ORDER BY published_at DESC LIMIT 1000`,
  ).all<any>().catch(() => ({ results: [] as any[] }));
  const known = new Set((existing || []).map((r: any) => r.source_post_id));

  const fresh: Array<SourceRecord & { source_post_id: string; place: string; lat: number; lon: number }> = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const src = `${c.platform}:${c.id}`;
    if (known.has(src) || seen.has(src)) continue;
    seen.add(src);
    fresh.push({ ...c, source_post_id: src, ...geolocate(c.caption) });
    if (fresh.length >= MAX_NEW) break;
  }
  if (!fresh.length) { await env.CACHE.put(LASTRUN_KEY, String(now)).catch(() => {}); return { ran: true, counts, candidates: candidates.length, published: 0 }; }

  let published = 0;
  for (let i = 0; i < fresh.length; i++) {
    const rec = fresh[i];
    const art = await writeArticle(env, rec);
    if (!art) continue;
    const ok = await upsert(env, {
      source_post_id: rec.source_post_id,
      slug: slugify(art.headline) + '-' + rec.platform[0] + String(rec.id).replace(/\W+/g, '').slice(-5),
      headline: art.headline, meta_desc: art.meta_desc, body_html: art.body_html,
      place: rec.place, lat: rec.lat, lon: rec.lon, platform: rec.platform, author: rec.author,
      source_url: rec.url, image_url: rec.image || '', video_url: rec.video || '',
      featured: i === 0 ? 1 : 0,
      published_at: (rec.ts ? new Date(rec.ts) : new Date(now)).toISOString(),
    });
    if (ok) published++;
  }
  console.log(`[blog-cron] published ${published}/${fresh.length}`);
  await env.CACHE.put(LASTRUN_KEY, String(now)).catch(() => {});
  await env.CACHE.delete('sitemap:blog').catch(() => {});
  return { ran: true, counts, candidates: candidates.length, published };
}
