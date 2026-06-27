// Defensive sanitizers shared by ingestion paths (blog AI output, photo fetches,
// the ingestion gatekeeper). Worker runtime — no DOM, so HTML sanitization is a
// conservative allowlist over the raw string. Used as defense-in-depth; callers
// should still prefer structured/escaped output where possible.

// Tags permitted in stored rich text (e.g. AI-generated blog bodies). Everything
// else is stripped; dangerous elements are removed with their content.
const ALLOWED_TAGS = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li', 'a', 'h2', 'h3', 'h4', 'blockquote']);
const DANGEROUS = 'script|style|iframe|object|embed|svg|math|template|noscript|link|meta|base|form';

// Allowlist-sanitize untrusted HTML. Strips disallowed tags, ALL attributes
// (except a safe href on <a>), inline event handlers, and javascript:/data: URIs.
export function sanitizeHtml(input: string): string {
  let s = String(input ?? '');
  // 1) Remove dangerous elements entirely (with their content), then any stray openers.
  s = s.replace(new RegExp(`<\\s*(${DANGEROUS})\\b[\\s\\S]*?<\\s*/\\s*\\1\\s*>`, 'gi'), '');
  s = s.replace(new RegExp(`<\\s*/?\\s*(${DANGEROUS})\\b[^>]*>`, 'gi'), '');
  // 2) Rewrite remaining tags: keep allowlisted (attribute-free, except a[href]); drop the rest.
  s = s.replace(/<\s*(\/?)\s*([a-zA-Z0-9]+)([^>]*)>/g, (_m, slash, tag, attrs) => {
    const t = String(tag).toLowerCase();
    if (!ALLOWED_TAGS.has(t)) return '';
    if (slash) return `</${t}>`;
    if (t === 'a') {
      const m = String(attrs).match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const href = m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
      if (/^(https?:|mailto:)/i.test(href.trim())) {
        return `<a href="${href.trim().replace(/"/g, '&quot;')}" rel="noopener nofollow ugc" target="_blank">`;
      }
      return '<a>';
    }
    return `<${t}>`;
  });
  // 3) Belt-and-suspenders: kill any surviving handlers / dangerous URI schemes.
  s = s.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/javascript:/gi, '').replace(/\bdata:\s*text\/html/gi, '');
  return s;
}

// SSRF guard for server-side fetch() of externally-sourced URLs. Allows only
// public http(s); rejects non-HTTP schemes, localhost, and private/link-local
// IPv4 ranges. (Workers have no cloud-metadata endpoint, but this blocks the
// obvious internal-fetch attempts and keeps ingestion to public web assets.)
export function isSafePublicUrl(raw: unknown): boolean {
  let u: URL;
  try { u = new URL(String(raw ?? '')); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' || h === '[::1]' || h.endsWith('.local') || h.endsWith('.internal')) return false;
  // Private / loopback / link-local IPv4.
  if (/^(10|127|0)\./.test(h)) return false;
  if (/^169\.254\./.test(h)) return false;
  if (/^192\.168\./.test(h)) return false;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) return false;
  return true;
}
