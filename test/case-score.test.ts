import { describe, it, expect } from 'vitest';
import { scoreCase, priorityOf, type CaseSignals } from '../src/lib/case-score';

// Fixed clock so every time-based rule is deterministic.
const NOW = 1_750_000_000_000; // arbitrary fixed epoch ms
const h = (n: number) => n * 3_600_000;
const d = (n: number) => n * 86_400_000;
const base = (over: Partial<CaseSignals> = {}): CaseSignals => ({ status: 'missing', now: NOW, ...over });

describe('case-score: status overrides (found / missing / deceased)', () => {
  it('found_safe → MENOR / baja, low score, no search', () => {
    const s = scoreCase(base({ status: 'found_safe', age: 8 }));
    expect(s.priority).toBe('baja');
    expect(s.triage).toBe('minor');
    expect(s.label).toBe('MENOR');
    expect(s.score).toBeLessThanOrEqual(10);
    expect(s.reasons.join(' ')).toMatch(/resuelto/i);
  });

  it('found_deceased → FALLECIDA / baja (recovery track, distinct triage)', () => {
    const s = scoreCase(base({ status: 'found_deceased', age: 8 }));
    expect(s.priority).toBe('baja');
    expect(s.triage).toBe('deceased');
    expect(s.label).toBe('FALLECIDA');
  });

  it('found overrides even a vulnerable minor (status dominates)', () => {
    // A minor who would otherwise be INMEDIATA, once located, is MENOR.
    expect(scoreCase(base({ status: 'found_safe', age: 4 })).triage).toBe('minor');
  });

  it('aparecido → MENOR / baja (found alive, resolved), overrides vulnerability', () => {
    const s = scoreCase(base({ status: 'aparecido', age: 4, eventAlert: 'red', createdMs: NOW - h(2) }));
    expect(s.triage).toBe('minor');
    expect(s.priority).toBe('baja');
    expect(s.reasons.join(' ')).toMatch(/con vida/i);
  });

  it('hospitalizado → MENOR / baja (found alive, medical follow-up)', () => {
    const s = scoreCase(base({ status: 'hospitalizado', age: 70 }));
    expect(s.triage).toBe('minor');
    expect(s.priority).toBe('baja');
    expect(s.reasons.join(' ')).toMatch(/hospitalizada/i);
  });
});

describe('case-score: missing person urgency', () => {
  it('missing adult, recent quake-week → DEMORADA (media)', () => {
    const s = scoreCase(base({ age: 35, createdMs: NOW - d(2), eventMag: 6.1 }));
    expect(s.priority).toBe('media');
    expect(s.triage).toBe('delayed');
  });

  it('missing young child in the 72h window with a red PAGER → INMEDIATA (alta)', () => {
    const s = scoreCase(base({ age: 5, createdMs: NOW - h(10), eventAlert: 'red' }));
    expect(s.priority).toBe('alta');
    expect(s.triage).toBe('immediate');
    expect(s.score).toBeGreaterThanOrEqual(70);
    expect(s.reasons.join(' ')).toMatch(/menor/i);
  });

  it('elderly missing person scores higher than an average adult', () => {
    const ctx = { createdMs: NOW - d(2), eventMag: 6.5 };
    const elderly = scoreCase(base({ age: 80, ...ctx })).score;
    const adult = scoreCase(base({ age: 40, ...ctx })).score;
    expect(elderly).toBeGreaterThan(adult);
  });
});

describe('case-score: time dynamics', () => {
  it('the 72h critical window boosts vs an older case', () => {
    const fresh = scoreCase(base({ age: 40, createdMs: NOW - h(12) })).score;
    const week = scoreCase(base({ age: 40, createdMs: NOW - d(5) })).score;
    expect(fresh).toBeGreaterThan(week);
  });

  it('a cold case (>30d, no docket activity) is de-prioritized', () => {
    const cold = scoreCase(base({ age: 40, createdMs: NOW - d(60), docketCount: 0 }));
    const recent = scoreCase(base({ age: 40, createdMs: NOW - h(12) }));
    expect(cold.score).toBeLessThan(recent.score);
    expect(cold.reasons.join(' ')).toMatch(/frío/i);
  });

  it('new info in the last 48h re-escalates the score', () => {
    const noInfo = scoreCase(base({ age: 40, createdMs: NOW - d(10), docketCount: 0 }));
    const newLead = scoreCase(base({ age: 40, createdMs: NOW - d(10), docketCount: 2, lastActivityMs: NOW - h(5) }));
    expect(newLead.score).toBeGreaterThan(noInfo.score);
    expect(newLead.reasons.join(' ')).toMatch(/pista|actividad/i);
  });
});

describe('case-score: floors and buckets', () => {
  it('a still-missing minor never drops below DEMORADA, even when cold', () => {
    const s = scoreCase(base({ age: 9, createdMs: NOW - d(120), docketCount: 0 }));
    // would compute low, but the minor floor keeps it at least delayed/media.
    expect(['delayed', 'immediate']).toContain(s.triage);
    expect(s.priority === 'media' || s.priority === 'alta').toBe(true);
  });

  it('the minor floor does NOT apply once the minor is found', () => {
    expect(scoreCase(base({ status: 'found_safe', age: 9 })).triage).toBe('minor');
  });

  it('unknown status starts lower than confirmed missing', () => {
    const unk = scoreCase(base({ status: 'unknown', age: 40, createdMs: NOW - d(5) })).score;
    const miss = scoreCase(base({ status: 'missing', age: 40, createdMs: NOW - d(5) })).score;
    expect(unk).toBeLessThan(miss);
  });

  it('score is always clamped to 0–100', () => {
    const max = scoreCase(base({ age: 2, createdMs: NOW - h(1), eventAlert: 'red', incidentType: 'medico', docketCount: 3, lastActivityMs: NOW - h(1) }));
    expect(max.score).toBeLessThanOrEqual(100);
    expect(max.score).toBeGreaterThanOrEqual(0);
  });
});

describe('case-score: determinism + helpers', () => {
  it('same input → identical output (pure)', () => {
    const sig = base({ age: 7, createdMs: NOW - d(1), eventMag: 7.5 });
    expect(scoreCase(sig)).toEqual(scoreCase(sig));
  });

  it('priorityOf returns just the bucket', () => {
    expect(priorityOf(base({ status: 'found_safe' }))).toBe('baja');
    expect(['alta', 'media', 'baja']).toContain(priorityOf(base({ age: 30, createdMs: NOW - d(3) })));
  });

  it('PAGER alert outranks magnitude when both present', () => {
    const redLowMag = scoreCase(base({ age: 40, createdMs: NOW - d(2), eventAlert: 'red', eventMag: 5 }));
    const noAlertHighMag = scoreCase(base({ age: 40, createdMs: NOW - d(2), eventMag: 7 }));
    expect(redLowMag.score).toBeGreaterThan(noAlertHighMag.score);
  });
});
