import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { inlineScriptHashes } from '../scripts/gen-csp.mjs';
import { STRICT_SCRIPT_SRC } from '../src/lib/csp';
import { evaluateGate } from '../src/rbac/route-policy';

// Drift guard for the Report-Only strict CSP. If anyone edits a public/*.html
// inline <script> without regenerating (node scripts/gen-csp.mjs --write), the committed
// STRICT_SCRIPT_SRC no longer covers that script and this test fails — preventing a
// silently-stale report-only policy (and, later, a broken enforcing policy).

describe('strict CSP script-src', () => {
  it('has NO unsafe-inline and starts from self + CDN hosts', () => {
    expect(STRICT_SCRIPT_SRC).not.toContain("'unsafe-inline'");
    expect(STRICT_SCRIPT_SRC.startsWith("'self'")).toBe(true);
    expect(STRICT_SCRIPT_SRC).toContain('https://unpkg.com');
  });

  it('covers every current static inline-script hash (no drift)', () => {
    const current = inlineScriptHashes('public');
    const missing = current.filter((h) => !STRICT_SCRIPT_SRC.includes(h));
    expect(
      missing,
      'These inline-script hashes are missing from src/lib/csp.ts — run `node scripts/gen-csp.mjs --write` and recommit:\n  ' +
        missing.join('\n  '),
    ).toEqual([]);
    expect(current.length).toBeGreaterThan(80);
  });

  it('the CSP report endpoint is public (not blocked by M1 default-deny)', () => {
    expect(evaluateGate('/api/csp-report', 'POST').kind).toBe('open');
  });
});
