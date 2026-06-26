import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CRON_GROUPS, jobsForCron } from '../src/cron';

// The whole point of the split is that no single invocation runs too many jobs.
// These tests lock in: groups are non-empty, jobs are disjoint (each runs once
// per hour), every job has a runner, and the cron keys match wrangler.toml.

const ALL_JOB_NAMES = [
  'usgs', 'kobo', 'quake-announce', 'sos-damage', 'case-score-sweep', 'sos-sheet',
  'familia-ingest', 'personas-clean', 'personas-name-floods', 'personas-dedupe-exact', 'personas-dedupe-photo',
  'familia-photo-mirror', 'monitor-sheet', 'social-monitor', 'blog',
];

describe('cron groups', () => {
  it('every group is non-empty and every job has a name + runner', () => {
    for (const [cron, jobs] of Object.entries(CRON_GROUPS)) {
      expect(jobs.length, `group ${cron} is empty`).toBeGreaterThan(0);
      for (const j of jobs) {
        expect(typeof j.name).toBe('string');
        expect(typeof j.run).toBe('function');
      }
    }
  });

  it('jobs are disjoint across groups (no job runs twice in an hour)', () => {
    const names = Object.values(CRON_GROUPS).flatMap((g) => g.map((j) => j.name));
    expect(new Set(names).size).toBe(names.length);
  });

  it('covers exactly the expected job set', () => {
    const names = Object.values(CRON_GROUPS).flatMap((g) => g.map((j) => j.name)).sort();
    expect(names).toEqual([...ALL_JOB_NAMES].sort());
  });

  it('no single group is large enough to risk the subrequest ceiling', () => {
    // Coarse guardrail: keep groups small so even multi-subrequest jobs stay well
    // under the ~1000/invocation cap. Tighten/loosen deliberately, not by accident.
    for (const [cron, jobs] of Object.entries(CRON_GROUPS)) {
      expect(jobs.length, `group ${cron} has too many jobs`).toBeLessThanOrEqual(6);
    }
  });

  it('jobsForCron returns the group for a known cron, and ALL jobs for unknown/undefined', () => {
    const firstCron = Object.keys(CRON_GROUPS)[0];
    expect(jobsForCron(firstCron)).toBe(CRON_GROUPS[firstCron]);
    const total = Object.values(CRON_GROUPS).flat().length;
    expect(jobsForCron(undefined).length).toBe(total);   // fallback: full cycle
    expect(jobsForCron('99 * * * *').length).toBe(total); // unknown cron → full cycle
  });

  it('wrangler.toml crons exactly match CRON_GROUPS keys', () => {
    const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
    const line = toml.split('\n').find((l) => l.trim().startsWith('crons ='));
    expect(line, 'no crons line in wrangler.toml').toBeTruthy();
    const declared = [...line!.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(declared).toEqual(Object.keys(CRON_GROUPS).sort());
  });
});
