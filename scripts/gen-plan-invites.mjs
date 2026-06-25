#!/usr/bin/env node
/**
 * Generate N invite codes for the gated /plan deck and a Wrangler KV bulk file.
 *
 * Codes are validated by src/routes/plan.ts against KV keys `plan:invite:<CODE>`
 * (in addition to the master PLAN_INVITE_CODES env list). The actual generated
 * codes are access tokens — do NOT commit them; load straight into KV and track
 * them in the invite Google Sheet.
 *
 * Usage:
 *   node scripts/gen-plan-invites.mjs 100 ./kv-bulk.json ./codes.json
 *   npx wrangler kv bulk put ./kv-bulk.json --binding CACHE --remote
 *
 * Magic link per code: https://sismo911.com/plan/i/<CODE>
 */
import { randomInt } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const n = Math.max(1, parseInt(process.argv[2] || '100', 10));
const bulkPath = process.argv[3] || './kv-bulk.json';
const codesPath = process.argv[4] || './codes.json';

// Unambiguous alphabet — no 0/O/1/I/L to avoid read/transcription errors.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const block = (len) => Array.from({ length: len }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

const batch = new Date().toISOString().slice(0, 7); // YYYY-MM
const codes = new Set();
while (codes.size < n) codes.add(`SIS-${block(3)}-${block(4)}`); // e.g. SIS-K7M-QR4P
const list = [...codes];

const bulk = list.map((code, i) => ({
  key: `plan:invite:${code}`,
  value: JSON.stringify({ n: i + 1, batch, label: '', redeemed_ms: 0 }),
}));

writeFileSync(bulkPath, JSON.stringify(bulk));
writeFileSync(codesPath, JSON.stringify(list));
console.log(`Generated ${list.length} codes (batch ${batch}).`);
console.log(`  KV bulk → ${bulkPath}`);
console.log(`  codes   → ${codesPath}`);
console.log(`Load:  npx wrangler kv bulk put ${bulkPath} --binding CACHE --remote`);
