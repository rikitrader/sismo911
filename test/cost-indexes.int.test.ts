import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { makeDb } from './helpers/d1';

const migrations = readdirSync('migrations')
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => `migrations/${name}`);

describe('starter D1 cost indexes', () => {
  it('uses the covering public-status index for registry counters', () => {
    const db = makeDb(migrations);
    const personasPlan = db.raw.prepare(
      `EXPLAIN QUERY PLAN
       SELECT COUNT(*) FROM personas
       WHERE moderation='approved' AND protected=0
         AND estado NOT IN ('localizado','aparecido','hospitalizado','fallecido')`,
    ).all() as Array<{ detail: string }>;
    const personsPlan = db.raw.prepare(
      `EXPLAIN QUERY PLAN
       SELECT COUNT(*) FROM persons
       WHERE review='approved' AND protected=0 AND status='missing'`,
    ).all() as Array<{ detail: string }>;
    expect(personasPlan.map((row) => row.detail).join(' ')).toContain('idx_personas_public_status_cost');
    expect(personsPlan.map((row) => row.detail).join(' ')).toContain('idx_persons_public_status_cost');
  });
});
