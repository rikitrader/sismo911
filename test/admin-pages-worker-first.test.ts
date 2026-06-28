import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

// Security guard: every admin page shell (public/admin-*.html) MUST be in
// wrangler.toml's run_worker_first list, or the Cloudflare edge serves it
// directly and the Worker auth gate (evaluateGate → page → /login redirect)
// never runs — leaving the page client-gated only. A QA sweep found 4 such pages
// (/admin-dup-review, /admin-flota-*, /admin-x402) served 200 unauthenticated.
describe('admin page shells are Worker-first (server-gated)', () => {
  it('every public/admin-*.html route is in run_worker_first', () => {
    // Isolate the run_worker_first = [ ... ] array (skip any comment that mentions
    // the key first), then collect the quoted paths inside it.
    const toml = readFileSync('wrangler.toml', 'utf8');
    const start = toml.search(/run_worker_first\s*=\s*\[/);
    const block = toml.slice(start);
    const list = new Set(
      [...block.slice(0, block.indexOf(']')).matchAll(/"([^"]+)"/g)].map((m) => m[1]),
    );
    const adminPages = readdirSync('public')
      .filter((f) => /^admin-.*\.html$/.test(f))
      .map((f) => '/' + f.replace(/\.html$/, ''));
    expect(adminPages.length).toBeGreaterThan(0);
    const uncovered = adminPages.filter((r) => !list.has(r));
    expect(uncovered, `These admin shells are NOT Worker-first → edge serves them past the auth gate. Add to run_worker_first in wrangler.toml:\n  ${uncovered.join('\n  ')}`).toEqual([]);
  });
});
