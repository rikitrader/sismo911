import { describe, it, expect } from 'vitest';
import { subjectLimit, normEmail, normPhone } from '../src/lib/security';

// In-memory fake of the atomic D1 rate_buckets upsert (keyed by the first bind
// param = the hashed subject), mirroring the RETURNING count semantics.
function rlEnv() {
  const buckets = new Map<string, { count: number; reset: number }>();
  return {
    DB: {
      prepare: (sql: string) => ({
        bind: (...a: any[]) => ({
          first: async () => {
            if (!/rate_buckets/.test(sql)) return null;
            const [key, reset, now] = a;
            const b = buckets.get(key);
            if (!b || b.reset < now) { buckets.set(key, { count: 1, reset }); return { count: 1 }; }
            b.count++; return { count: b.count };
          },
        }),
      }),
    },
  } as any;
}

describe('subjectLimit (per email/phone)', () => {
  it('blocks repeated attempts past the limit for the same subject', async () => {
    const env = rlEnv();
    const hits: boolean[] = [];
    for (let i = 0; i < 5; i++) hits.push(await subjectLimit(env, 'book_email', 'a@b.com', 3, 3600));
    expect(hits).toEqual([false, false, false, true, true]); // 4th+ blocked at limit 3
  });
  it('isolates distinct subjects and never blocks an empty subject', async () => {
    const env = rlEnv();
    for (let i = 0; i < 4; i++) await subjectLimit(env, 'book_email', 'a@b.com', 3, 3600); // exhaust a@b.com
    expect(await subjectLimit(env, 'book_email', 'c@d.com', 3, 3600)).toBe(false); // different subject fresh
    expect(await subjectLimit(env, 'book_email', '', 3, 3600)).toBe(false);          // empty = no-op
  });
  it('fails OPEN on DB error (never blocks a legit user)', async () => {
    const env = { DB: { prepare: () => { throw new Error('db down'); } } } as any;
    expect(await subjectLimit(env, 'x', 'a@b.com', 1, 60)).toBe(false);
  });
});

describe('subject normalizers (can\'t be sidestepped by formatting)', () => {
  it('normEmail trims + lowercases', () => {
    expect(normEmail('  A@B.Com ')).toBe('a@b.com');
  });
  it('normPhone keeps digits only (last 12)', () => {
    expect(normPhone('+58 (412) 555-1234')).toBe('584125551234');
    expect(normPhone('0412.555.1234')).toBe('04125551234');
  });
});
