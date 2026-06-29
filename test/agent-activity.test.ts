import { describe, it, expect } from 'vitest';
import { nameKeySql } from '../src/lib/agent-activity';

// nameKeySql builds the SQL that normalizes a name into the de-dup key behind the
// "unique missing" estimate. The single-quote (apostrophe) fold is the dangerous
// bit: `replace(x, ''', '')` is INVALID SQL and made the whole COUNT(DISTINCT)
// throw → unique silently 0. These tests lock the escaping + the accent folds.
describe('nameKeySql', () => {
  const sql = nameKeySql('nombre');

  it('escapes the apostrophe fold as a doubled quote (no bare triple-quote)', () => {
    // correct escaped literal for a single quote is '''' (open + '' + close)
    expect(sql).toContain("replace(");
    expect(sql).toContain("'''', ''");      // fold a single quote → empty string
    expect(sql).not.toMatch(/[^']'''[^']/); // never a lone ''' (unescaped quote)
  });

  it('folds Spanish accents to their base letter (both cases)', () => {
    for (const [a, b] of [["'á', 'a'", 'á'], ["'é', 'e'", 'é'], ["'ñ', 'n'", 'ñ'], ["'Ñ', 'n'", 'Ñ'], ["'ü', 'u'", 'ü']] as const) {
      expect(sql).toContain(a as string);
    }
  });

  it('lower-cases the result and trims the column', () => {
    expect(sql.startsWith('lower(')).toBe(true);
    expect(sql).toContain('trim(nombre)');
  });

  it('collapses hyphens to spaces and drops punctuation', () => {
    expect(sql).toContain("'-', ' '");
    expect(sql).toContain("'.', ''");
  });
});
