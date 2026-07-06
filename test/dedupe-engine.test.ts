// Layered dedupe scoring engine — table-driven cases per the plan's rules.
import { describe, it, expect } from 'vitest';
import { scorePair, pickKeeper, pairKey, completeness, nameSimilarity, AUTO_MERGE_THRESHOLD, REVIEW_THRESHOLD, type DedupeRecord } from '../src/db/dedupe';

function rec(over: Partial<DedupeRecord>): DedupeRecord {
  return {
    id: over.id ?? 'r1',
    fullName: null, cedula: null, phone: null, email: null, age: null,
    municipality: null, state: null, familyPhone: null, lastSeenLocation: null,
    sourceName: null, sourceRecordId: null, status: null, updatedMs: null,
    ...over,
  };
}

describe('scorePair — exact layer', () => {
  it('cedula match alone auto-merges (+100)', () => {
    const s = scorePair(rec({ id: 'a', cedula: '12345678', age: 30 }), rec({ id: 'b', cedula: 'V-12.345.678', age: 30 }));
    expect(s.signals).toContain('cedula');
    expect(s.score).toBeGreaterThanOrEqual(AUTO_MERGE_THRESHOLD);
    expect(s.decision).toBe('auto_merge');
  });
  it('same source + source_record_id (+95) auto-merges', () => {
    const s = scorePair(
      rec({ id: 'a', sourceName: 'civis', sourceRecordId: 'x1', age: 40 }),
      rec({ id: 'b', sourceName: 'civis', sourceRecordId: 'x1', age: 40 }),
    );
    expect(s.decision).toBe('auto_merge');
  });
  it('phone matches on last-10 digits across +58/0 prefixes (+90)', () => {
    const s = scorePair(rec({ id: 'a', phone: '+58 412-555-1234', age: 25 }), rec({ id: 'b', phone: '04125551234', age: 25 }));
    expect(s.signals).toContain('phone');
    expect(s.decision).toBe('auto_merge');
  });
  it('different sources with same upstream id do NOT count source_record', () => {
    const s = scorePair(rec({ id: 'a', sourceName: 'civis', sourceRecordId: 'x1' }), rec({ id: 'b', sourceName: 'rav', sourceRecordId: 'x1' }));
    expect(s.signals).not.toContain('source_record');
  });
});

describe('scorePair — strong fuzzy layer', () => {
  it('name+age+municipality reaches review, not auto (40+15+15=70)', () => {
    const s = scorePair(
      rec({ id: 'a', fullName: 'Maria Alejandra Gonzalez', age: 33, municipality: 'Vargas' }),
      rec({ id: 'b', fullName: 'MARÍA GONZÁLEZ Alejandra', age: 34, municipality: 'vargas' }),
    );
    expect(s.score).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
    expect(s.score).toBeLessThan(AUTO_MERGE_THRESHOLD);
    expect(s.decision).toBe('review');
  });
  it('name+age+family phone lands in review (40+15+30=85)', () => {
    const s = scorePair(
      rec({ id: 'a', fullName: 'Jose Perez Marcano', age: 50, familyPhone: '04141112233' }),
      rec({ id: 'b', fullName: 'Jose Perez Marcano', age: 50, familyPhone: '+58 414 111 2233' }),
    );
    expect(s.score).toBe(85);
    expect(s.decision).toBe('review');
  });
  it('fully-corroborated fuzzy match (name+age+family phone+last seen = 105) auto-merges', () => {
    const s = scorePair(
      rec({ id: 'a', fullName: 'Jose Perez Marcano', age: 50, familyPhone: '04141112233', lastSeenLocation: 'Catia La Mar, Vargas' }),
      rec({ id: 'b', fullName: 'Jose Perez Marcano', age: 50, familyPhone: '+58 414 111 2233', lastSeenLocation: 'catia la mar' }),
    );
    expect(s.score).toBeGreaterThanOrEqual(AUTO_MERGE_THRESHOLD);
    expect(s.decision).toBe('auto_merge');
  });
});

describe('scorePair — weak evidence never auto-merges', () => {
  it('name-only namesakes are ignored or review, never auto', () => {
    const s = scorePair(rec({ id: 'a', fullName: 'Maria Gonzalez' }), rec({ id: 'b', fullName: 'Maria Gonzalez' }));
    expect(s.score).toBe(40);
    expect(s.decision).toBe('ignore');
  });
});

describe('sensitive guards', () => {
  it('alive-vs-deceased is a CRITICAL conflict and blocks auto-merge even on cedula match', () => {
    const s = scorePair(
      rec({ id: 'a', cedula: '9876543', status: 'localizada' }),
      rec({ id: 'b', cedula: '9876543', status: 'fallecido' }),
    );
    expect(s.conflicts.some((c) => c.field === 'status' && c.severity === 'critical')).toBe(true);
    expect(s.decision).toBe('review');
  });
  it('minors are never auto-merged even on exact keys', () => {
    const s = scorePair(rec({ id: 'a', cedula: '5554443', age: 9 }), rec({ id: 'b', cedula: '5554443', age: 9 }));
    expect(s.decision).toBe('review');
  });
  it('large age gap records a review conflict', () => {
    const s = scorePair(rec({ id: 'a', cedula: '1112223', age: 27 }), rec({ id: 'b', cedula: '1112223', age: 53 }));
    expect(s.conflicts.some((c) => c.field === 'age')).toBe(true);
  });
});

describe('pickKeeper', () => {
  it('most complete record wins', () => {
    const a = rec({ id: 'a', fullName: 'X', cedula: '123456', phone: '04120000000' });
    const b = rec({ id: 'b', fullName: 'X' });
    expect(pickKeeper(a, b).keeper.id).toBe('a');
    expect(completeness(a)).toBeGreaterThan(completeness(b));
  });
  it('ties break by most recent update, then stable id order', () => {
    const a = rec({ id: 'a', fullName: 'X', updatedMs: 100 });
    const b = rec({ id: 'b', fullName: 'X', updatedMs: 200 });
    expect(pickKeeper(a, b).keeper.id).toBe('b');
    expect(pickKeeper(rec({ id: 'b', fullName: 'X' }), rec({ id: 'a', fullName: 'X' })).keeper.id).toBe('a');
  });
});

describe('pairKey idempotency', () => {
  it('is order-independent and stable', () => {
    expect(pairKey('personas', 'p2', 'p1')).toEqual(pairKey('personas', 'p1', 'p2'));
    expect(pairKey('personas', 'p1', 'p2').key).toBe('personas:p1:p2');
  });
});

describe('nameSimilarity', () => {
  it('is accent/case/order-insensitive', () => {
    expect(nameSimilarity('MARÍA GONZÁLEZ', 'gonzalez maria')).toBe(1);
    expect(nameSimilarity('Maria Gonzalez', 'Pedro Rodriguez')).toBe(0);
  });
});
