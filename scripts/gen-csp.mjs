#!/usr/bin/env node
// Generate the STRICT (no 'unsafe-inline') script-src for a Report-Only CSP:
// 'self' + the allowed CDN hosts + a sha256 hash of every STATIC inline <script>
// in public/*.html. Inline event handlers (on*=) and dynamic Worker-rendered
// inline scripts are intentionally NOT covered — they will REPORT under the
// report-only policy, which is exactly how we find what to refactor before
// enforcing. Run: node scripts/gen-csp.mjs  (output is committed into src/lib/csp.ts;
// test/csp-hashes.test.ts fails if the committed hashes drift from the pages).

import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const CDN_HOSTS = ['https://unpkg.com', 'https://esm.sh', 'https://static.cloudflareinsights.com', 'https://maps.googleapis.com', 'https://js.stripe.com', 'https://*.crossmint.com'];

export function inlineScriptHashes(dir = 'public') {
  const hashes = new Set();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.html'))) {
    const html = readFileSync(`${dir}/${f}`, 'utf8');
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      hashes.add(`'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
    }
  }
  return [...hashes].sort();
}

export function strictScriptSrc(dir = 'public') {
  return ["'self'", ...CDN_HOSTS, ...inlineScriptHashes(dir)].join(' ');
}

// CLI: print the script-src so it can be pasted into src/lib/csp.ts.
if (import.meta.url === `file://${process.argv[1]}`) {
  const hashes = inlineScriptHashes('public');
  process.stderr.write(`# ${hashes.length} inline-script hashes from public/*.html\n`);
  process.stdout.write(strictScriptSrc('public') + '\n');
}
