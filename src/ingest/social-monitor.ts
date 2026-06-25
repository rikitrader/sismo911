import type { Env } from '../types';
import { recordIngest } from '../lib/db';

// ---- Keyword + city dictionaries -------------------------------------------
// Disaster hashtags/terms (Spanish-first) and Venezuelan cities. Matched
// case-insensitively against each item's title/text to tag + classify it.
export const TAGS = [
  'terremoto', 'sismo', 'temblor', 'réplica', 'replica', 'sosvenezuela', 'sos venezuela',
  'atrapados', 'atrapado', 'derrumbe', 'colapso', 'escombros', 'rescate', 'damnificados',
  'evacuación', 'evacuacion', 'sepultado', 'desaparecidos', 'tsunami', 'deslave',
];
export const CITIES = [
  'Caracas', 'Maracaibo', 'Valencia', 'Barquisimeto', 'Maracay', 'Ciudad Guayana', 'San Cristóbal',
  'Maturín', 'Barcelona', 'Cumaná', 'Mérida', 'Cabimas', 'Barinas', 'Los Teques', 'Puerto La Cruz',
  'Petare', 'Turmero', 'Ciudad Bolívar', 'Guarenas', 'Punto Fijo', 'Acarigua', 'Coro', 'Carúpano',
  'Guacara', 'El Tigre', 'Valera', 'Trujillo', 'San Fernando', 'La Guaira', 'Porlamar', 'Guanare',
];
const CRITICAL = ['atrapado', 'atrapados', 'derrumbe', 'colapso', 'escombros', 'rescate', 'sepultado', 'sos', 'desaparecid'];
const ALERT = ['terremoto', 'sismo', 'temblor', 'réplica', 'replica', 'evacuaci', 'damnificados', 'tsunami', 'deslave'];

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}
export function sigId(platform: string, key: string): string {
  return `${platform}_${djb2(key)}`;
}

export interface RawSignal {
  platform: string; title?: string; text?: string; author?: string;
  lang?: string; url: string; score?: number; posted_ms?: number;
}

/** Tag + classify an item. Returns null if it matches no disaster keyword. */
export function classify(text: string): { tags: string; city: string | null; severity: string } | null {
  const lc = text.toLowerCase();
  const tags = TAGS.filter((t) => lc.includes(t.toLowerCase()));
  if (!tags.length) return null;
  const city = CITIES.find((c) => lc.includes(c.toLowerCase())) ?? null;
  const severity = CRITICAL.some((k) => lc.includes(k)) ? 'critical'
    : ALERT.some((k) => lc.includes(k)) ? 'alert' : 'info';
  // dedupe tag list
  return { tags: [...new Set(tags)].join(','), city, severity };
}

/** Persist a batch of raw signals (INSERT OR IGNORE → natural dedupe by id). */
export async function storeSignals(env: Env, rows: RawSignal[]): Promise<number> {
  const now = Date.now();
  const stmts = [];
  for (const r of rows) {
    const blob = `${r.title ?? ''} ${r.text ?? ''}`.trim();
    const cls = classify(blob);
    if (!cls) continue;
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO social_signals
           (id, platform, severity, city, tags, title, text, author, lang, url, score, posted_ms, ingested_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        sigId(r.platform, r.url), r.platform, cls.severity, cls.city, cls.tags,
        (r.title ?? '').slice(0, 300), (r.text ?? '').slice(0, 1000),
        r.author ?? null, r.lang ?? null, r.url, r.score ?? 0, r.posted_ms ?? now, now
      )
    );
  }
  if (!stmts.length) return 0;
  await env.DB.batch(stmts);
  return stmts.length;
}

// ---- Free sources (HTTP, no key) -------------------------------------------
async function fromGdelt(): Promise<RawSignal[]> {
  const query = `(${TAGS.slice(0, 12).map((t) => `"${t}"`).join(' OR ')}) sourcelang:spanish`;
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=ArtList&format=json&maxrecords=75&timespan=90min&sort=DateDesc`;
  const res = await fetch(url, { headers: { 'User-Agent': 'sismo911-monitor/1.0' } });
  if (!res.ok) throw new Error(`gdelt ${res.status}`);
  const data = await res.json<{ articles?: any[] }>().catch(() => ({ articles: [] }));
  return (data.articles ?? []).map((a) => ({
    platform: 'gdelt', title: a.title, text: a.title, url: a.url,
    author: a.domain, lang: a.language,
    posted_ms: a.seendate ? Date.parse(a.seendate.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z')) : undefined,
  })).filter((r) => r.url);
}

async function fromReddit(): Promise<RawSignal[]> {
  const q = `(${TAGS.slice(0, 8).join(' OR ')})`;
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&sort=new&t=day&limit=50`;
  const res = await fetch(url, { headers: { 'User-Agent': 'sismo911-monitor/1.0 (disaster monitor)' } });
  if (!res.ok) throw new Error(`reddit ${res.status}`);
  const data = await res.json<{ data?: { children?: any[] } }>().catch(() => ({ data: { children: [] } }));
  return (data.data?.children ?? []).map((c) => c.data).filter(Boolean).map((d: any) => ({
    platform: 'reddit', title: d.title, text: d.selftext || d.title,
    url: `https://www.reddit.com${d.permalink}`, author: d.author,
    score: d.score, posted_ms: d.created_utc ? d.created_utc * 1000 : undefined, lang: 'es',
  }));
}

async function fromTelegram(env: Env): Promise<RawSignal[]> {
  const channels = (env.TELEGRAM_CHANNELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!channels.length) return [];
  const out: RawSignal[] = [];
  for (const ch of channels) {
    try {
      const res = await fetch(`https://t.me/s/${encodeURIComponent(ch)}`, { headers: { 'User-Agent': 'Mozilla/5.0 sismo911-monitor' } });
      if (!res.ok) continue;
      const html = await res.text();
      const re = /tgme_widget_message_text[^>]*>(.*?)<\/div>[\s\S]*?datetime="([^"]+)"[\s\S]*?href="(https:\/\/t\.me\/[^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) && out.length < 200) {
        const text = m[1].replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').trim();
        out.push({ platform: 'telegram', title: text.slice(0, 120), text, author: ch, url: m[3], lang: 'es', posted_ms: Date.parse(m[2]) || undefined });
      }
    } catch { /* best-effort per channel */ }
  }
  return out;
}

// ---- Apify (TikTok / Instagram) — gated on APIFY_TOKEN ----------------------
/** Fire-and-forget actor runs; results arrive via the webhook → /api/monitor/apify. */
export async function triggerApifyScrapers(env: Env): Promise<void> {
  if (!env.APIFY_TOKEN || !env.MONITOR_WEBHOOK_SECRET) return;
  const base = (env.PUBLIC_BASE_URL ?? 'https://sismo911.com').replace(/\/$/, '');
  const hashtags = ['terremoto', 'sosvenezuela', 'atrapados', 'sismovenezuela', 'temblor'];
  const jobs: Array<{ actor: string; platform: string; input: unknown }> = [
    { actor: env.APIFY_TIKTOK_ACTOR ?? 'clockworks~tiktok-scraper', platform: 'tiktok', input: { hashtags, resultsPerPage: 30, shouldDownloadVideos: false, shouldDownloadCovers: false } },
    { actor: env.APIFY_IG_ACTOR ?? 'apify~instagram-hashtag-scraper', platform: 'instagram', input: { hashtags, resultsLimit: 30 } },
  ];
  for (const j of jobs) {
    const webhooks = btoa(JSON.stringify([{
      eventTypes: ['ACTOR.RUN.SUCCEEDED'],
      requestUrl: `${base}/api/monitor/apify?secret=${env.MONITOR_WEBHOOK_SECRET}&platform=${j.platform}`,
    }]));
    try {
      await fetch(`https://api.apify.com/v2/acts/${j.actor}/runs?token=${env.APIFY_TOKEN}&webhooks=${webhooks}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(j.input),
      });
    } catch (e: any) { console.error(`[monitor] apify ${j.platform} trigger failed:`, e?.message ?? e); }
  }
}

/** Normalize an Apify dataset (TikTok/IG) into RawSignals. */
export function fromApifyItems(platform: string, items: any[]): RawSignal[] {
  return (items ?? []).map((it) => {
    if (platform === 'tiktok') {
      return { platform, title: it.text, text: it.text, author: it.authorMeta?.name ?? it['authorMeta.name'],
        url: it.webVideoUrl ?? it.videoUrl ?? it.url, score: it.diggCount ?? it.playCount ?? 0,
        posted_ms: it.createTimeISO ? Date.parse(it.createTimeISO) : (it.createTime ? it.createTime * 1000 : undefined), lang: 'es' };
    }
    // instagram
    return { platform, title: it.caption, text: it.caption, author: it.ownerUsername,
      url: it.url ?? it.postUrl, score: it.likesCount ?? 0,
      posted_ms: it.timestamp ? Date.parse(it.timestamp) : undefined, lang: 'es' };
  }).filter((r) => r.url);
}

// ---- Orchestrator (called hourly from the cron) ----------------------------
export async function ingestSocialMonitor(env: Env): Promise<number> {
  const results = await Promise.allSettled([fromGdelt(), fromReddit(), fromTelegram(env)]);
  const rows: RawSignal[] = [];
  const errs: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') rows.push(...r.value);
    else errs.push(`${['gdelt', 'reddit', 'telegram'][i]}:${r.reason?.message ?? r.reason}`);
  });
  const written = await storeSignals(env, rows);
  await recordIngest(env, 'social_monitor', errs.length < 3, written, errs.join('; ') || undefined);
  // fire the paid scrapers (async; ingested later via webhook)
  await triggerApifyScrapers(env).catch(() => {});
  return written;
}
