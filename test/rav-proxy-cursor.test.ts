import { describe, it, expect } from 'vitest';
import { parseRavCursor, advanceRavCursor, RAV_MS_PAGE } from '../src/lib/rav';

// RAV /api/data proxy sweep cursor ("<status>:<page>") — the contract that lets
// the hourly cron cycle all `active` pages, then all `found` pages, then wrap.
// Legacy numeric offsets (pre-lockdown PostgREST cursor) must restart cleanly.

describe('parseRavCursor', () => {
  it('parses status:page', () => {
    expect(parseRavCursor('active:37')).toEqual({ status: 'active', page: 37 });
    expect(parseRavCursor('found:0')).toEqual({ status: 'found', page: 0 });
  });
  it('falls back to active:0 for legacy/invalid values', () => {
    expect(parseRavCursor('45000')).toEqual({ status: 'active', page: 0 });   // old row offset
    expect(parseRavCursor(null)).toEqual({ status: 'active', page: 0 });
    expect(parseRavCursor(undefined)).toEqual({ status: 'active', page: 0 });
    expect(parseRavCursor('')).toEqual({ status: 'active', page: 0 });
    expect(parseRavCursor('weird:abc')).toEqual({ status: 'active', page: 0 });
    expect(parseRavCursor('active:-3')).toEqual({ status: 'active', page: 0 });
  });
});

describe('advanceRavCursor', () => {
  it('continues within the same status while not exhausted', () => {
    expect(advanceRavCursor({ status: 'active', page: 10 }, 40, false)).toBe('active:40');
    expect(advanceRavCursor({ status: 'found', page: 3 }, 33, false)).toBe('found:33');
  });
  it('flips active→found→active on exhaustion (full sweep alternates)', () => {
    expect(advanceRavCursor({ status: 'active', page: 1090 }, 1092, true)).toBe('found:0');
    expect(advanceRavCursor({ status: 'found', page: 210 }, 211, true)).toBe('active:0');
  });
  it('round-trips through parse', () => {
    const next = advanceRavCursor(parseRavCursor('active:5'), 35, false);
    expect(parseRavCursor(next)).toEqual({ status: 'active', page: 35 });
  });
});

describe('RAV_MS_PAGE', () => {
  it('matches the upstream fixed page size', () => {
    expect(RAV_MS_PAGE).toBe(40);
  });
});
