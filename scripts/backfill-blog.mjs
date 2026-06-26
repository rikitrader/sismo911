#!/usr/bin/env node
// One-time continuity backfill: load the 49 already-live static blog articles
// (public/blog/*.html) into the new blog_posts D1 table via /api/blog/ingest,
// PRESERVING their exact slugs so existing URLs keep resolving once the dynamic
// /blog shadows the static files. Clean body/headline come from the original
// terremoto-news ai_out_*.json (keyed by the idx suffix in each filename);
// platform/source/place are parsed from the rendered HTML + the gazetteer.
//
// Env: BLOG_INGEST_TOKEN (required), BASE_URL (default http://localhost:8799),
//      PUBLIC_DIR (default ~/projects/sismo911/public), DATA_DIR (default
//      ~/projects/terremoto-news/data), DRY_RUN=1.
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const BASE = (process.env.BASE_URL || 'http://localhost:8799').replace(/\/$/, '');
const PUBLIC_DIR = process.env.PUBLIC_DIR || join(HOME, 'projects/sismo911/public');
const DATA_DIR = process.env.DATA_DIR || join(HOME, 'projects/terremoto-news/data');
const GAZ_PATH = join(HOME, '.claude/skills/disaster-social-blog/references/gazetteer-venezuela.json');
const INGEST = process.env.BLOG_INGEST_TOKEN;
const DRY = process.env.DRY_RUN === '1';
const log = (...a) => console.log(...a);

const GAZ = (() => { try { const g = JSON.parse(readFileSync(GAZ_PATH, 'utf8')); delete g._note; return g; } catch { return {}; } })();
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const titleCase = (s) => String(s).replace(/\b\w/g, (c) => c.toUpperCase());
function geolocate(text) {
  const t = norm(text); let best = null;
  for (const [name, ll] of Object.entries(GAZ)) {
    if (!Array.isArray(ll)) continue;
    if (t.includes(norm(name)) && (!best || name.length > best.name.length)) best = { name, ll };
  }
  return best ? { place: titleCase(best.name), lat: best.ll[0], lon: best.ll[1] } : { place: 'Venezuela', lat: 8.0, lon: -66.0 };
}

// idx -> clean article from ai_out_*.json
const ART = new Map();
for (const f of readdirSync(DATA_DIR).filter((x) => /^ai_out_\d+\.json$/.test(x))) {
  for (const a of JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8'))) if (typeof a.idx === 'number') ART.set(a.idx, a);
}

const m1 = (s, re) => { const m = s.match(re); return m ? m[1] : ''; };
function platformOf(url) {
  if (/tiktok\.com/.test(url)) return 'tiktok';
  if (/youtu\.?be/.test(url)) return 'youtube';
  if (/instagram\.com/.test(url)) return 'instagram';
  if (/facebook\.com|fb\.watch/.test(url)) return 'facebook';
  if (/(twitter|x)\.com/.test(url)) return 'x';
  return 'redes';
}
const isVideo = (url, plat) => plat === 'tiktok' || plat === 'youtube' || /\/(reel|tv)\//.test(url);

const files = readdirSync(PUBLIC_DIR + '/blog').filter((x) => /-\d+\.html$/.test(x));
const posts = [];
for (const fn of files) {
  const slug = fn.replace(/\.html$/, '');
  const idx = Number(slug.match(/-(\d+)$/)?.[1]);
  const html = readFileSync(join(PUBLIC_DIR, 'blog', fn), 'utf8');
  const art = ART.get(idx);

  const headline = (art?.headline) || m1(html, /<title>([^<]*?)(?:\s*—\s*SISMO911)?<\/title>/).trim();
  const meta_desc = (art?.metaDesc) || m1(html, /property="og:description" content="([^"]*)"/);
  const body_html = (art?.body_html) || '';
  const source_url = m1(html, /href="(https:\/\/[^"]*(?:tiktok|youtube|youtu\.be|instagram|facebook|fb\.watch|twitter|x)\.[^"]*)"/);
  const platform = source_url ? platformOf(source_url) : 'redes';
  // Prefer the handle from the source URL (/@handle/), then a @mention in the meta.
  const author = m1(source_url, /\/@([A-Za-z0-9_.]+)/) || m1(meta_desc, /@([A-Za-z0-9_.]+)/);
  const g = geolocate(`${headline} ${meta_desc}`);

  if (!headline) { log('skip (no headline):', fn); continue; }
  posts.push({
    source_post_id: `legacy:${slug}`,
    slug,
    headline, meta_desc, body_html,
    place: g.place, lat: g.lat, lon: g.lon,
    platform, author: author || '',
    source_url, image_url: '',
    video_url: source_url && isVideo(source_url, platform) ? source_url : '',
    views: 0, likes: 0, comments: 0, featured: 0,
    published_at: '2026-06-24T21:04:00.000Z', // event time → sorts below fresh cron posts
  });
}

log(`parsed ${posts.length} legacy articles (of ${files.length} files); ${posts.filter((p) => p.video_url).length} with video, ${posts.filter((p) => p.body_html).length} with clean body`);
if (DRY) { log(JSON.stringify(posts.slice(0, 2), null, 2)); process.exit(0); }
if (!INGEST) { log('FATAL: no BLOG_INGEST_TOKEN'); process.exit(1); }

// ingest in chunks of 50 (the route caps at 60/call)
let ins = 0, upd = 0;
for (let i = 0; i < posts.length; i += 50) {
  const chunk = posts.slice(i, i + 50);
  const res = await fetch(`${BASE}/api/blog/ingest`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${INGEST}` },
    body: JSON.stringify({ posts: chunk }),
  });
  const out = await res.json().catch(() => ({}));
  log(`chunk ${i / 50}: HTTP ${res.status} ${JSON.stringify(out)}`);
  ins += out.inserted || 0; upd += out.updated || 0;
}
log(`backfill done: inserted ${ins}, updated ${upd}`);
