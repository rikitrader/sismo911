import type { Env } from '../types';

// Free social/news source fetchers for the every-3h blog pipeline. These run
// INSIDE the Worker (Cloudflare's clean network) because this project's host
// Mac has poisoned local DNS for several external API hosts (USGS, Bluesky…),
// so the local cron can't reach them — it calls GET /api/blog/sources instead.
//
// All free: GDELT DOC 2.0 (keyless, news + share image + link), YouTube Data
// API v3 (free key, real video), Bluesky searchPosts (keyless, citizen posts).
// Each returns the cron's normalized record; geolocation + AI writing stay
// local. Every fetcher is defensive — a failure returns [] and is logged.

export interface SourceRecord {
  platform: string;          // youtube | bluesky | noticia
  id: string;                // platform-unique id
  author: string;
  caption: string;
  url: string;               // link to the original story/post
  image: string;             // poster / share image (may be empty)
  video: string;             // canonical video watch URL (empty = no video)
  ts: number;                // epoch ms
  views: number;
  likes: number;
  comments: number;
}

const QUERY_ES = ['terremoto venezuela', 'sismo venezuela', 'temblor venezuela'];
const UA = 'SISMO911/1.0 (+https://sismo911.com; emergencia sismica Venezuela)';

const num = (v: any) => (Number.isFinite(+v) ? +v : 0);
async function getJson(url: string, headers: Record<string, string> = {}) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', ...headers }, cf: { cacheTtl: 0 } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json<any>();
}

// ---- Venezuelan news RSS feeds (keyless, datacenter-friendly) ----
// Normal news sites' RSS — no IP-blocking — give DIRECT article links + images.
// We filter each feed to earthquake items and enrich the poster image from
// media:content/enclosure, else a bounded og:image fetch of the article.
const VE_FEEDS = [
  'https://efectococuyo.com/feed/',
  'https://runrun.es/feed/',
  'https://talcualdigital.com/feed/',
  'https://elpitazo.net/feed/',
  'https://cronica.uno/feed/',
];
const QUAKE_RE = /terremoto|sismo|sismic|temblor|r[ée]plica|magnitud|epicentr|tsunami|funvisis/i;
const stripTags = (s: string) => String(s).replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
const attr = (s: string, a: string) => (s.match(new RegExp(`${a}\\s*=\\s*["']([^"']+)["']`)) || [, ''])[1];

async function ogImage(link: string): Promise<string> {
  try {
    const r = await fetch(link, { headers: { 'user-agent': UA }, cf: { cacheTtl: 0 } });
    if (!r.ok) return '';
    const html = (await r.text()).slice(0, 60_000);
    const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    return m ? m[1] : '';
  } catch { return ''; }
}

async function fetchVeNews(sinceMs: number): Promise<SourceRecord[]> {
  const settled = await Promise.allSettled(VE_FEEDS.map(async (feed) => {
    const host = new URL(feed).hostname.replace(/^www\./, '');
    const out: SourceRecord[] = [];
    const r = await fetch(feed, { headers: { 'user-agent': UA }, cf: { cacheTtl: 0 } });
    if (!r.ok) throw new Error(`${host} HTTP ${r.status}`);
    const xml = await r.text();
    for (const block of xml.split(/<item[ >]/).slice(1)) {
      const pick = (tag: string) => (block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [, ''])[1];
      const title = stripTags(pick('title'));
      const link = stripTags(pick('link')) || stripTags(pick('guid'));
      const desc = pick('description') + pick('content:encoded');
      const ts = Date.parse(stripTags(pick('pubDate'))) || Date.now();
      if (!title || !link || ts < sinceMs) continue;
      if (!QUAKE_RE.test(`${title} ${stripTags(desc).slice(0, 300)}`)) continue;
      // image: media:content / media:thumbnail / enclosure / <img> in content
      let image = attr(block, 'url') && /media:|enclosure/.test(block)
        ? (block.match(/<(?:media:content|media:thumbnail|enclosure)[^>]*\burl=["']([^"']+)["']/) || [, ''])[1] : '';
      if (!image) image = (desc.match(/<img[^>]+src=["']([^"']+)["']/) || [, ''])[1];
      out.push({ platform: 'noticia', id: link, author: host, caption: title, url: link, image, video: '', ts, views: 0, likes: 0, comments: 0 });
    }
    return out;
  }));
  const items: SourceRecord[] = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') items.push(...s.value);
    else console.error('[blog-sources] venews', VE_FEEDS[i], (s.reason as any)?.message ?? s.reason);
  });
  // Bounded og:image enrichment for items still missing a poster (≤8 fetches).
  let budget = 8;
  for (const it of items) {
    if (it.image || budget <= 0) continue;
    budget--;
    it.image = await ogImage(it.url);
  }
  return items;
}

// ---- GDELT DOC 2.0 (keyless) — news coverage with a share image + link ----
// Best-effort: throttles hard (429) from shared datacenter IPs, so one retry.
async function fetchGdelt(sinceMs: number): Promise<SourceRecord[]> {
  const hours = Math.max(1, Math.min(168, Math.ceil((Date.now() - sinceMs) / 3600_000)));
  const q = `(terremoto OR sismo OR temblor OR earthquake) Venezuela`;
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}` +
    `&mode=artlist&format=json&timespan=${hours}h&maxrecords=75&sort=datedesc`;
  let j: any;
  try { j = await getJson(url); }
  catch (e: any) {
    if (!String(e?.message).includes('429')) throw e;
    await new Promise((r) => setTimeout(r, 5500));
    j = await getJson(url);
  }
  const arts: any[] = Array.isArray(j?.articles) ? j.articles : [];
  return arts
    // Keep Spanish/English so the Spanish field-report writer has a usable source headline.
    .filter((a) => !a.language || /spanish|english/i.test(a.language))
    .map((a) => {
      // seendate is "YYYYMMDDTHHMMSSZ"
      const m = String(a.seendate || '').match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
      const ts = m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) : Date.now();
      return {
        platform: 'noticia', id: a.url || a.title, author: a.domain || '',
        caption: a.title || '', url: a.url || '', image: a.socialimage || '',
        video: '', ts, views: 0, likes: 0, comments: 0,
      } as SourceRecord;
    }).filter((r) => r.id && r.caption);
}

// ---- YouTube Data API v3 (free key) — real citizen video ----
async function fetchYoutube(env: Env, sinceMs: number): Promise<SourceRecord[]> {
  if (!env.YOUTUBE_API_KEY) return [];
  const publishedAfter = new Date(sinceMs).toISOString();
  const out: SourceRecord[] = [];
  for (const q of QUERY_ES) {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=date` +
      `&maxResults=12&relevanceLanguage=es&publishedAfter=${encodeURIComponent(publishedAfter)}` +
      `&q=${encodeURIComponent(q)}&key=${env.YOUTUBE_API_KEY}`;
    try {
      const j = await getJson(url);
      for (const it of (j.items || [])) {
        const id = it.id?.videoId; if (!id) continue;
        const s = it.snippet || {};
        out.push({
          platform: 'youtube', id, author: s.channelTitle || '',
          caption: `${s.title || ''}. ${s.description || ''}`.trim(),
          url: `https://www.youtube.com/watch?v=${id}`,
          image: s.thumbnails?.high?.url || s.thumbnails?.medium?.url || '',
          video: `https://www.youtube.com/watch?v=${id}`,
          ts: Date.parse(s.publishedAt) || Date.now(), views: 0, likes: 0, comments: 0,
        });
      }
    } catch (e: any) { console.error('[blog-sources] youtube', q, e?.message ?? e); }
  }
  return out;
}

// ---- Bluesky searchPosts (keyless public appview) — citizen posts ----
async function fetchBluesky(sinceMs: number): Promise<SourceRecord[]> {
  const out: SourceRecord[] = [];
  for (const q of QUERY_ES) {
    const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&limit=25&sort=latest`;
    try {
      const j = await getJson(url);
      for (const p of (j.posts || [])) {
        const handle = p.author?.handle || '';
        const rkey = String(p.uri || '').split('/').pop();
        const ts = Date.parse(p.record?.createdAt) || Date.now();
        if (ts < sinceMs) continue;
        const e = p.embed || {};
        const t = e['$type'] || '';
        let image = '', video = '';
        if (t.includes('images')) image = e.images?.[0]?.thumb || e.images?.[0]?.fullsize || '';
        else if (t.includes('video')) { video = e.playlist || ''; image = e.thumbnail || ''; }
        else if (t.includes('external')) image = e.external?.thumb || '';
        out.push({
          platform: 'bluesky', id: p.uri || `${handle}/${rkey}`, author: handle,
          caption: p.record?.text || '',
          url: handle && rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : '',
          image, video, ts, views: 0, likes: num(p.likeCount), comments: num(p.replyCount),
        });
      }
    } catch (e: any) { console.error('[blog-sources] bluesky', q, e?.message ?? e); }
  }
  return out.filter((r) => r.id && r.caption);
}

// Fetch all free sources, dedupe by platform:id, newest first.
export async function fetchBlogSources(env: Env, sinceMs: number): Promise<{ candidates: SourceRecord[]; counts: Record<string, number> }> {
  const results = await Promise.allSettled([fetchVeNews(sinceMs), fetchYoutube(env, sinceMs), fetchGdelt(sinceMs), fetchBluesky(sinceMs)]);
  const names = ['venews', 'youtube', 'gdelt', 'bluesky'];
  const counts: Record<string, number> = {};
  const seen = new Set<string>();
  const candidates: SourceRecord[] = [];
  results.forEach((res, i) => {
    const arr = res.status === 'fulfilled' ? res.value : [];
    counts[names[i]] = res.status === 'fulfilled' ? arr.length : -1;
    if (res.status === 'rejected') console.error(`[blog-sources] ${names[i]} failed:`, (res.reason as any)?.message ?? res.reason);
    for (const r of arr) {
      const key = `${r.platform}:${r.id}`;
      if (seen.has(key)) continue;
      seen.add(key); candidates.push(r);
    }
  });
  candidates.sort((a, b) => b.ts - a.ts);
  return { candidates, counts };
}
