import { describe, it, expect } from 'vitest';
import {
  APPT_TYPES, APPT_TYPE_KEYS, isApptType, isStatus, canTransition,
  computeSlots, localToMs, weekdayOf, minToHHMM, STATUSES,
} from '../src/lib/telemed-slots';

describe('appointment types', () => {
  it('has the 5 spec types with sane durations', () => {
    expect(APPT_TYPE_KEYS).toEqual(['video', 'followup', 'urgent', 'mental_health', 'refill']);
    expect(APPT_TYPES.mental_health.duration).toBeGreaterThan(APPT_TYPES.refill.duration);
    expect(isApptType('video')).toBe(true);
    expect(isApptType('massage')).toBe(false);
  });
});

describe('status state machine', () => {
  it('exposes the 7 spec statuses', () => {
    expect([...STATUSES]).toEqual(['scheduled', 'checked_in', 'waiting_room', 'in_progress', 'completed', 'cancelled', 'no_show']);
    expect(isStatus('waiting_room')).toBe(true);
    expect(isStatus('napping')).toBe(false);
  });

  it('lets the doctor move the lifecycle forward and cancel/no-show anytime', () => {
    expect(canTransition('scheduled', 'checked_in', 'doctor')).toBe(true);
    expect(canTransition('scheduled', 'in_progress', 'doctor')).toBe(true); // forward jump ok
    expect(canTransition('checked_in', 'scheduled', 'doctor')).toBe(false); // no going back
    expect(canTransition('scheduled', 'no_show', 'doctor')).toBe(true);
    expect(canTransition('waiting_room', 'cancelled', 'doctor')).toBe(true);
  });

  it('restricts patient actions to check-in / waiting / cancel from open states', () => {
    expect(canTransition('scheduled', 'checked_in', 'patient')).toBe(true);
    expect(canTransition('scheduled', 'cancelled', 'patient')).toBe(true);
    expect(canTransition('checked_in', 'waiting_room', 'patient')).toBe(true);
    expect(canTransition('scheduled', 'in_progress', 'patient')).toBe(false); // doctor-only
    expect(canTransition('scheduled', 'completed', 'patient')).toBe(false);
  });

  it('treats completed/cancelled/no_show as terminal', () => {
    for (const s of ['completed', 'cancelled', 'no_show'] as const) {
      expect(canTransition(s, 'scheduled', 'doctor')).toBe(false);
      expect(canTransition(s, 'in_progress', 'doctor')).toBe(false);
    }
  });
});

describe('Caracas local-time math (fixed UTC-4)', () => {
  it('converts local date+minute to the right UTC instant', () => {
    // 2026-07-01 09:00 Caracas == 13:00 UTC
    expect(new Date(localToMs('2026-07-01', 9 * 60)).toISOString()).toBe('2026-07-01T13:00:00.000Z');
    expect(minToHHMM(9 * 60 + 30)).toBe('09:30');
  });
  it('computes weekday for a local date', () => {
    expect(weekdayOf('2026-07-01')).toBe(3); // Wednesday
  });
});

describe('computeSlots', () => {
  const base = {
    date: '2026-07-01',
    windows: [{ start_min: 9 * 60, end_min: 12 * 60 }], // 09:00–12:00
    blocks: [],
    busy: [],
    duration: 30,
    step: 30,
    nowMs: localToMs('2026-06-01', 0), // a month before → nothing is "past"
  };

  it('fills a window with back-to-back slots', () => {
    const slots = computeSlots(base);
    expect(slots.map((s) => s.label)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
    expect(slots[0].start_ms).toBe(localToMs('2026-07-01', 9 * 60));
  });

  it('drops slots that overlap a booked appointment', () => {
    const slots = computeSlots({ ...base, busy: [{ start_min: 10 * 60, end_min: 10 * 60 + 30 }] });
    expect(slots.map((s) => s.label)).not.toContain('10:00');
    expect(slots.map((s) => s.label)).toContain('10:30');
  });

  it('drops slots covered by a whole-day block (0..1440)', () => {
    expect(computeSlots({ ...base, blocks: [{ start_min: 0, end_min: 1440 }] })).toHaveLength(0);
  });

  it('hides slots already in the past', () => {
    const slots = computeSlots({ ...base, nowMs: localToMs('2026-07-01', 10 * 60 + 5) });
    expect(slots.map((s) => s.label)).toEqual(['10:30', '11:00', '11:30']);
  });

  it('respects longer durations (mental health) needing contiguous time', () => {
    const slots = computeSlots({ ...base, duration: 50, step: 30 });
    // 50-min visits starting on the half-hour that still fit before 12:00
    expect(slots.map((s) => s.label)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00']);
    expect(slots.every((s) => s.end_min - s.start_min === 50)).toBe(true);
  });
});
