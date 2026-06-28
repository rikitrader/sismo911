import { describe, it, expect } from 'vitest';
import { gateCasualty, CASUALTY_METRICS } from '../src/ingest/casualty-gate';

// gateCasualty is the door every casualty figure passes before it touches D1.
// These lock in: valid figures pass + normalize; junk numbers, unknown metrics/
// sources, markup/XSS text, future timestamps and bad citations are rejected or
// sanitized — so the ledger can never be infected.

const base = {
  source_key: 'gov_ve',
  source_name: 'Gobierno de Venezuela',
  metric: 'dead' as const,
  value_min: 589,
  value_max: 589,
  as_of_ms: Date.UTC(2026, 5, 26, 12),
  confidence: 0.7,
  citation_url: 'https://example.com/x',
  note: 'cifra oficial',
};

describe('gateCasualty — accepts valid figures', () => {
  it('passes a clean row and normalizes it', () => {
    const r = gateCasualty(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.row.value_min).toBe(589);
      expect(r.row.metric).toBe('dead');
      expect(r.row.confidence).toBeCloseTo(0.7);
    }
  });

  it('allows an open-ended figure (value_max null)', () => {
    const r = gateCasualty({ ...base, source_key: 'usgs_pager', value_min: 1000, value_max: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.row.value_max).toBeNull();
  });

  it('accepts every declared metric', () => {
    for (const m of CASUALTY_METRICS) {
      expect(gateCasualty({ ...base, metric: m as any }).ok, m).toBe(true);
    }
  });
});

describe('gateCasualty — rejects bad numbers', () => {
  it('rejects a negative value', () => {
    expect(gateCasualty({ ...base, value_min: -5 }).ok).toBe(false);
  });
  it('rejects a non-integer value', () => {
    expect(gateCasualty({ ...base, value_min: 12.5 }).ok).toBe(false);
  });
  it('rejects value_max < value_min', () => {
    expect(gateCasualty({ ...base, value_min: 1000, value_max: 10 }).ok).toBe(false);
  });
  it('rejects an implausibly huge figure (units/parse error)', () => {
    expect(gateCasualty({ ...base, value_min: 999_000_000 }).ok).toBe(false);
  });
});

describe('gateCasualty — rejects bad shape', () => {
  it('rejects an unknown metric', () => {
    expect(gateCasualty({ ...base, metric: 'zombies' as any }).ok).toBe(false);
  });
  it('rejects a malformed source_key', () => {
    expect(gateCasualty({ ...base, source_key: 'Bad Key!' }).ok).toBe(false);
  });
  it('rejects a far-future timestamp', () => {
    expect(gateCasualty({ ...base, as_of_ms: Date.now() + 1000 * 60 * 60 * 24 * 30 }).ok).toBe(false);
  });
});

describe('gateCasualty — sanitizes text + links (the AI filter)', () => {
  it('rejects markup / XSS in the note', () => {
    const r = gateCasualty({ ...base, note: '<script>alert(1)</script>' });
    expect(r.ok).toBe(false);
  });
  it('drops a non-http(s) citation (javascript:)', () => {
    const r = gateCasualty({ ...base, citation_url: 'javascript:alert(1)' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.row.citation_url).toBeNull();
  });
  it('clamps confidence into [0,1]', () => {
    const hi = gateCasualty({ ...base, confidence: 9 });
    const lo = gateCasualty({ ...base, confidence: -3 });
    expect(hi.ok && hi.row.confidence).toBe(1);
    expect(lo.ok && lo.row.confidence).toBe(0);
  });
});
