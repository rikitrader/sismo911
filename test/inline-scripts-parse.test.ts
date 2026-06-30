import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// Guard against a whole class of "the page silently broke" bugs: every classic
// inline <script> in a public/*.html page shares ONE global lexical scope at
// runtime, so a `const`/`let`/`function` declared in two blocks of the same page
// is a SyntaxError that kills the second block — invisible to the build, the
// CSP hasher, and the backend tests. (This actually happened: a duplicate
// `const money` across two blocks of suministros.html broke Kits/Almacenes.)
//
// We concatenate each page's classic inline scripts and COMPILE them together
// (parse only, never execute) so cross-block redeclarations fail the suite.

const PUBLIC_DIR = join(__dirname, '..', 'public');
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

function inlineClassicScripts(html: string): string {
  let m: RegExpExecArray | null;
  let code = '';
  SCRIPT_RE.lastIndex = 0;
  while ((m = SCRIPT_RE.exec(html))) {
    const attrs = m[1] || '';
    if (/\bsrc=/i.test(attrs)) continue;            // external script, no inline body
    // Only classic JS runs in the shared page scope. Skip modules + non-JS
    // payloads (application/ld+json, importmap, text/template, etc.).
    const type = /type=["']([^"']*)["']/i.exec(attrs)?.[1]?.toLowerCase();
    if (type && type !== 'text/javascript' && type !== 'application/javascript') continue;
    code += '\n;\n' + m[2];                          // same global scope, in document order
  }
  return code;
}

const pages = readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html'));

describe('inline page scripts compile (no cross-block redeclaration)', () => {
  for (const page of pages) {
    it(`${page} — all inline <script> blocks parse together`, () => {
      const html = readFileSync(join(PUBLIC_DIR, page), 'utf8');
      const code = inlineClassicScripts(html);
      if (!code.trim()) return; // no inline scripts on this page
      expect(() => new vm.Script(code, { filename: page })).not.toThrow();
    });
  }
});
