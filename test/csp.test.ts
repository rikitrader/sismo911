import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { setSecurityHeaders } from '../src/lib/security';

// Capture the CSP the Worker actually emits.
function getCsp(): string {
  const headers: Record<string, string> = {};
  setSecurityHeaders({ header: (k: string, v: string) => { headers[k] = v; } } as any);
  return headers['Content-Security-Policy'] || '';
}

const csp = getCsp();
const pages = readdirSync('public').filter((f) => f.endsWith('.html'));

describe('CSP core protections', () => {
  it('blocks framing + plugins', () => {
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });
});

// REGRESSION GUARD: the Tailwind Play CDN JIT-compiles classes via eval(). If a
// page uses it but the CSP omits 'unsafe-eval', Tailwind produces NO css and the
// whole page renders unstyled. This exact mismatch broke the live site once.
describe('CSP ↔ Tailwind CDN invariant', () => {
  const cdnPages = pages.filter((p) => readFileSync(`public/${p}`, 'utf8').includes('cdn.tailwindcss.com'));

  it('every page that loads the Tailwind Play CDN is allowed to compile', () => {
    if (cdnPages.length > 0) {
      expect(csp, `Pages ${cdnPages.join(', ')} use cdn.tailwindcss.com but CSP lacks 'unsafe-eval' → all CSS breaks`).toContain("'unsafe-eval'");
      expect(csp).toContain('https://cdn.tailwindcss.com');
    }
    // If cdnPages is empty (Tailwind was built to static CSS), this is a no-op —
    // and 'unsafe-eval' can then safely be removed from the CSP.
  });

  it('allows the CDNs the pages load (tailwind + leaflet/unpkg)', () => {
    expect(csp).toContain('https://unpkg.com');
  });
});
