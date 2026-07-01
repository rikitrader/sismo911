import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// REGRESSION GUARD for the /casos spam bug (#299/#300): every PUBLIC read of the
// `personas` registry must filter moderation='approved' (mirror of persons'
// review='approved'), or junk/rejected rows leak to /casos, /personas, the stat
// counters and search. Each entry below is the literal filter on one public read
// path — this test FAILS if any of them is removed.
const GUARDS: Array<[file: string, marker: string, where: string]> = [
  ['src/routes/persons.ts', `if (!op) { fWhere.push("moderation = 'approved'");`, '/casos federation (public)'],
  // /api/persons/stats no longer has its own personas SQL — it delegates to the
  // shared, moderation-guarded registrySummary() (asserted here), whose personas
  // counter is anchored by the '/casos summary counters' guard just below. So the
  // /personas banner cannot regain an unguarded count without failing this test.
  ['src/routes/persons.ts', `const s = await registrySummary(c.env, false);`, '/api/persons/stats delegates to moderation-guarded registrySummary'],
  ['src/routes/persons.ts', `deceased, COUNT(*) AS total FROM personas WHERE moderation = 'approved'`, '/casos + /stats summary counters (shared registrySummary)'],
  ['src/routes/persons.ts', `FROM personas WHERE moderation = 'approved' AND nombre LIKE ?`, 'federated name search'],
  ['src/routes/familia.ts', `if (!op) { base.push("moderation = 'approved'");`, '/api/familia/persons list'],
  ['src/routes/familia.ts', `['foto_r2 IS NOT NULL', "moderation = 'approved'"`, '/api/familia/gallery'],
  ['src/routes/desaparecidos.ts', `moderation = 'approved'`, '/desaparecidos public list + single'],
];

describe('personas public reads keep their moderation filter', () => {
  for (const [file, marker, where] of GUARDS) {
    it(`${where} (${file})`, () => {
      expect(readFileSync(file, 'utf8'), `missing moderation filter for ${where}`).toContain(marker);
    });
  }
});
