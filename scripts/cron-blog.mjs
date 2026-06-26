#!/usr/bin/env node
// SISMO911 — every-3h disaster→blog autopost orchestrator.
//
//   launchd (every 3h) → THIS → GET /api/blog/sources (rolling cutoff) → geolocate →
//   dedupe vs D1 → write one Spanish field report per NEW post via `claude -p`
//   → embed source video + poster → POST /api/admin/blog/ingest → live /blog.
//
// Honesty: every article derives from a REAL scraped post (caption, place,
// platform, engagement, source link). Never invents posts, casualties or facts.
// Dependency-free (Node 18+ fetch). Article-writing reuses the local `claude`
// CLI auth — no API key needed.
//
// Sources (GDELT/YouTube/Bluesky) are fetched by the Worker on Cloudflare's
// clean network via GET /api/blog/sources — this Mac's DNS is poisoned for
// several of those hosts, so the cron never fetches them directly.
//
// Env:
//   BLOG_INGEST_TOKEN  — required (reads /api/blog/sources + posts to ingest)
//   BASE_URL           — default https://sismo911.com
//   MAX_NEW            — max new articles per run (default 8)
//   WINDOW_HOURS       — fallback lookback if no prior run (default 6)
//   CLAUDE_MODEL       — optional `claude -p --model` override
//   DRY_RUN=1          — scrape + write, skip the ingest POST
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const HOME = homedir();
const STATE_DIR = join(HOME, '.cache', 'sismo911-blog-cron');
const STATE_FILE = join(STATE_DIR, 'state.json');
const GAZ_PATH = join(HOME, '.claude/skills/disaster-social-blog/references/gazetteer-venezuela.json');

const BASE = (process.env.BASE_URL || 'https://sismo911.com').replace(/\/$/, '');
const MAX_NEW = Number(process.env.MAX_NEW || 8);
const WINDOW_HOURS = Number(process.env.WINDOW_HOURS || 6);
const DRY = process.env.DRY_RUN === '1';

const INGEST = process.env.BLOG_INGEST_TOKEN;

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// ---------------- state (rolling cutoff) ----------------
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ---------------- gazetteer geolocate ----------------
const GAZ = (() => {
  try { const g = JSON.parse(readFileSync(GAZ_PATH, 'utf8')); delete g._note; return g; } catch { return {}; }
})();
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
function geolocate(caption) {
  const t = norm(caption);
  let best = null;
  for (const [name, ll] of Object.entries(GAZ)) {
    if (!Array.isArray(ll)) continue;
    if (t.includes(norm(name))) { if (!best || name.length > best.name.length) best = { name, ll }; }
  }
  if (best) return { place: titleCase(best.name), lat: best.ll[0], lon: best.ll[1] };
  return { place: 'Venezuela', lat: 8.0, lon: -66.0 };
}
function titleCase(s) { return String(s).replace(/\b\w/g, (c) => c.toUpperCase()); }

// ---------------- free sources (fetched by the Worker on CF's clean network) ----------------
// This host Mac has poisoned local DNS for several external API hosts, so the
// cron does NOT fetch GDELT/YouTube/Bluesky directly — it asks the Worker
// (GET /api/blog/sources) to do it from Cloudflare's network and return
// normalized candidates. anyOk=false only when the endpoint itself is
// unreachable (don't advance the cutoff in that case).
async function scrape(cutoffMs) {
  const url = `${BASE}/api/blog/sources?since=${cutoffMs}`;
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${INGEST}` } });
    if (!res.ok) { log(`  /api/blog/sources HTTP ${res.status}`); return { posts: [], anyOk: false }; }
    const j = await res.json();
    log(`  sources counts: ${JSON.stringify(j.counts)} → ${j.candidates?.length || 0} candidates`);
    return { posts: j.candidates || [], anyOk: true };
  } catch (e) {
    log(`  /api/blog/sources FAILED: ${e.message}`);
    return { posts: [], anyOk: false };
  }
}

// ---------------- article writing via `claude -p` ----------------
function writeArticles(posts) {
  const facts = 'Terremoto de magnitud 7.5 frente a la costa norte de Venezuela (cerca de Morón, Carabobo) el 24 de junio de 2026, 17:04 hora local (VET). Sismo somero, sentido en Caracas, La Guaira, Valencia, Maracay y gran parte del centro-norte; reportes de daños estructurales y alerta de tsunami inicial.';
  const items = posts.map((p, i) => ({ idx: i, plataforma: p.platform, autor: p.author, lugar: p.place, texto: p.caption.slice(0, 600), vistas: p.views, likes: p.likes }));
  const prompt = `Eres redactor de SISMO911, plataforma de emergencia sísmica de Venezuela. Contexto del evento: ${facts}

Para CADA publicación ciudadana de redes sociales en este JSON, redacta UNA noticia breve en español periodístico.
Reglas estrictas:
- 150-300 palabras, tono informativo y sobrio.
- Explica lo que muestra la publicación SOLO a partir de su "texto" (caption). Cita el caption una vez entre comillas.
- Entreteje los hechos del evento (magnitud, fecha, zonas). NO inventes cifras de víctimas, daños ni detalles que no estén en el caption.
- Atribuye a la plataforma y autor. Marca el contenido como TESTIMONIO CIUDADANO SIN VERIFICAR.
- Incluye una línea de seguridad / cómo pedir ayuda (SOS) al final.
- Si el caption es muy escueto, escribe una nota contextual honesta sin inventar.

Devuelve SOLO un array JSON válido, sin texto adicional, sin fences markdown:
[{"idx":0,"headline":"...","meta_desc":"resumen 1 frase <=160 chars","body_html":"<p>...</p><p>...</p>"}]

Publicaciones:
${JSON.stringify(items, null, 0)}`;

  const args = ['-p', prompt];
  if (process.env.CLAUDE_MODEL) args.push('--model', process.env.CLAUDE_MODEL);
  log(`  calling claude -p for ${posts.length} articles…`);
  const raw = execFileSync('claude', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 8 * 60 * 1000 });
  const json = extractJsonArray(raw);
  if (!json) throw new Error('claude returned no parseable JSON array');
  return json;
}
function extractJsonArray(s) {
  let t = String(s).trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const a = t.indexOf('['), b = t.lastIndexOf(']');
  if (a === -1 || b === -1) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

function slugify(s) {
  return norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'noticia';
}

// ---------------- main ----------------
(async () => {
  if (!INGEST) { log('FATAL: no BLOG_INGEST_TOKEN (required to read /api/blog/sources and ingest)'); process.exit(1); }

  const state = loadState();
  const cutoff = state.lastRun ? Date.parse(state.lastRun) : Date.now() - WINDOW_HOURS * 3600_000;
  log(`run start · cutoff=${new Date(cutoff).toISOString()} · base=${BASE}`);

  // existing source_post_ids (server-side UNIQUE is the real guard; this avoids re-writing)
  let existing = new Set();
  try {
    const j = await fetch(`${BASE}/api/blog`).then((r) => r.json());
    existing = new Set((j.items || []).map((x) => x.source_post_id));
    log(`  ${existing.size} posts already published`);
  } catch (e) { log(`  /api/blog read failed (continuing): ${e.message}`); }

  const { posts: scraped, anyOk } = await scrape(cutoff);
  log(`scraped ${scraped.length} raw posts (scrape ok: ${anyOk})`);
  if (!anyOk) { log('ABORT: /api/blog/sources unreachable — NOT advancing cutoff so the window retries next run'); return; }

  // normalize + geolocate + dedupe + cutoff filter
  const seen = new Set();
  const fresh = [];
  for (const p of scraped) {
    const src = `${p.platform}:${p.id}`;
    if (seen.has(src) || existing.has(src)) continue;
    if (p.ts && p.ts < cutoff) continue;
    seen.add(src);
    const g = geolocate(p.caption);
    fresh.push({ ...p, source_post_id: src, ...g });
  }
  fresh.sort((a, b) => (b.views + b.likes * 3) - (a.views + a.likes * 3));
  const batch = fresh.slice(0, MAX_NEW);
  log(`${fresh.length} new candidates → writing ${batch.length}`);

  if (!batch.length) { state.lastRun = new Date().toISOString(); saveState(state); log('nothing new; done'); return; }

  const articles = writeArticles(batch);
  const byIdx = new Map(articles.map((a) => [a.idx, a]));

  const posts = batch.map((p, i) => {
    const a = byIdx.get(i) || {};
    if (!a.headline) return null;
    return {
      source_post_id: p.source_post_id,
      slug: slugify(`${a.headline}`) + '-' + p.platform[0] + (p.id || '').toString().replace(/\W+/g, '').slice(-5),
      headline: a.headline,
      meta_desc: a.meta_desc || '',
      body_html: a.body_html || '',
      place: p.place, lat: p.lat, lon: p.lon,
      platform: p.platform, author: p.author, source_url: p.url,
      image_url: p.image || '', video_url: p.video || '',
      views: p.views, likes: p.likes, comments: p.comments,
      featured: i === 0 ? 1 : 0,
      published_at: (p.ts ? new Date(p.ts) : new Date()).toISOString(),
    };
  }).filter(Boolean);

  log(`built ${posts.length} posts`);
  if (DRY) { writeFileSync(join(STATE_DIR, 'last_dry.json'), JSON.stringify(posts, null, 2)); log(`DRY_RUN → wrote ${join(STATE_DIR, 'last_dry.json')}`); return; }

  const res = await fetch(`${BASE}/api/blog/ingest`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${INGEST}` },
    body: JSON.stringify({ posts }),
  });
  const out = await res.json().catch(() => ({}));
  log(`ingest → HTTP ${res.status}: ${JSON.stringify(out)}`);
  if (res.ok) { state.lastRun = new Date().toISOString(); saveState(state); }
  log('done');
})().catch((e) => { log('FATAL', e.stack || e.message); process.exit(1); });
