// Social-profile handling for volunteer contact cards. Volunteers submit handles
// or URLs in the intake form; RAV "se ofreció" reports may embed them in free text
// (contact / description). We normalize everything to a canonical https profile URL
// per platform and never trust raw input as markup.

export type SocialPlatform = 'instagram' | 'facebook' | 'twitter' | 'tiktok' | 'telegram' | 'whatsapp' | 'web';

export const SOCIAL_PLATFORMS: { key: SocialPlatform; label: string }[] = [
  { key: 'instagram', label: 'Instagram' },
  { key: 'facebook', label: 'Facebook' },
  { key: 'twitter', label: 'X (Twitter)' },
  { key: 'tiktok', label: 'TikTok' },
  { key: 'telegram', label: 'Telegram' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'web', label: 'Sitio web' },
];

// URL patterns used to pull a handle out of a pasted profile link OR free text.
const HOSTS: Record<'instagram' | 'facebook' | 'twitter' | 'tiktok' | 'telegram', RegExp> = {
  instagram: /(?:instagram\.com|instagr\.am)\/([A-Za-z0-9._]{1,40})/i,
  facebook: /(?:facebook\.com|fb\.com|fb\.me)\/((?:profile\.php\?id=)?[A-Za-z0-9.\-]{2,60})/i,
  twitter: /(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,30})/i,
  tiktok: /tiktok\.com\/@?([A-Za-z0-9._]{1,40})/i,
  telegram: /(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{3,40})/i,
};

function base(p: SocialPlatform): string {
  return p === 'instagram' ? 'https://instagram.com/'
    : p === 'facebook' ? 'https://facebook.com/'
    : p === 'twitter' ? 'https://x.com/'
    : p === 'tiktok' ? 'https://tiktok.com/@'
    : p === 'telegram' ? 'https://t.me/'
    : '';
}

function cleanHandle(s: string): string {
  return s.trim().replace(/^@+/, '').replace(/[^A-Za-z0-9._=?\-]/g, '').slice(0, 60);
}

// Normalize ONE value (bare handle or full URL) for a platform → canonical https URL, or null.
export function normalizeSocial(platform: SocialPlatform, raw: any): string | null {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  if (platform === 'web') {
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    try { const u = new URL(s); return /^https?:$/.test(u.protocol) ? u.toString().slice(0, 200) : null; } catch { return null; }
  }
  if (platform === 'whatsapp') {
    const d = s.replace(/\D/g, '');
    return d.length >= 8 && d.length <= 15 ? 'https://wa.me/' + d : null;
  }
  const m = s.match(HOSTS[platform]);
  const h = cleanHandle(m ? m[1] : s);
  return h ? base(platform) + h : null;
}

// Build the social object from submitted intake-form fields. Returns {} when none valid.
export function buildSocial(input: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== 'object') return out;
  for (const def of SOCIAL_PLATFORMS) {
    const v = normalizeSocial(def.key, input[def.key]);
    if (v) out[def.key] = v;
  }
  return out;
}

// Opportunistically extract social profiles embedded in scraped free text (RAV
// reports put them in contact / description). Only matches explicit URLs / wa.me
// links — never bare words — so ordinary text can't produce false profiles.
export function extractSocial(...texts: (string | null | undefined)[]): Record<string, string> {
  const s = texts.filter(Boolean).join(' \n ');
  const out: Record<string, string> = {};
  if (!s) return out;
  for (const p of ['instagram', 'facebook', 'twitter', 'tiktok', 'telegram'] as const) {
    const m = s.match(HOSTS[p]);
    if (m) { const h = cleanHandle(m[1]); if (h) out[p] = base(p) + h; }
  }
  const wa = s.match(/wa\.me\/(\d{8,15})/i);
  if (wa) out.whatsapp = 'https://wa.me/' + wa[1];
  return out;
}

// Parse the stored JSON (or pass-through object) into a {platform: url} map.
export function parseSocial(json: any): Record<string, string> {
  if (!json) return {};
  if (typeof json === 'object') return json as Record<string, string>;
  try { const o = JSON.parse(String(json)); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}
