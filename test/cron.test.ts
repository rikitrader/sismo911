import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CRON_GROUPS, jobsForCron } from '../src/cron';
import { PERSONAS_STAGES } from '../src/ingest/personas-pipeline';
import { BUILDINGS_CASES_STAGES } from '../src/ingest/buildings-cases-pipeline';
import { CIVIS_STAGES } from '../src/ingest/civis-pipeline';

// The whole point of the split is that no single invocation runs too many jobs.
// These tests lock in: groups are non-empty, jobs are disjoint (each runs once
// per hour), every job has a runner, and the cron keys match wrangler.toml.

const ALL_JOB_NAMES = [
  'usgs', 'funvisis', 'funvisis-catchup-05', 'funvisis-catchup-15', 'funvisis-catchup-30', 'funvisis-catchup-45', 'kobo', 'quake-announce', 'sos-damage', 'case-score-sweep', 'sos-sheet', 'telemed-reminders', 'hospital-registry-sync', 'civis-pipeline',
  'personas-hourly-pipeline',
  'buildings-cases-hourly-pipeline',
  'social-monitor', 'blog', 'casualties', 'rav-photos', 'personas-phash-backfill', 'personas-dedupe-phash', 'personas-dedupe-dhash',
  'history-bootstrap', 'personas-phash-backfill-05',
  'rav-pipeline', 'sismos-bot-broadcast', 'botcommands-sync',
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
      // :15 is ONE seat (personas-hourly-pipeline: same bounded stages as before,
      // ordered inside the pipeline); :00 carries the seismic core + every-6h
      // hospital pull. :45 carries the external-fetch ingests incl. the CIVIS
      // pulls (atendidos ~28 subreq, desaparecidos ~10, both bounded/paged);
      // every job is bounded so the group stays far under the ~1000/invocation cap.
      expect(jobs.length, `group ${cron} has too many jobs`).toBeLessThanOrEqual(11);
    }
  });

  it('keeps RAV jobs isolated from the :30 buildings/cases group', () => {
    expect(CRON_GROUPS['30 * * * *'].map((j) => j.name)).toEqual([
      'funvisis-catchup-30',
      'buildings-cases-hourly-pipeline',
    ]);
    expect(CRON_GROUPS['5 * * * *'].map((j) => j.name)).toEqual([
      'funvisis-catchup-05',
      'history-bootstrap',
      'rav-pipeline',
      'personas-phash-backfill-05',
      'sismos-bot-broadcast',
    ]);
  });

  it(':15 is the single personas-hourly-pipeline seat with the dependency-driven stage order', () => {
    expect(CRON_GROUPS['15 * * * *'].map((j) => j.name)).toEqual(['funvisis-catchup-15', 'personas-hourly-pipeline']);
    // Order is load-bearing: ingest → clean → index (dedupes group on name_norm)
    // → dedupe cheapest/most deterministic first → purge → hospital matching.
    expect(PERSONAS_STAGES.map((s) => s.name)).toEqual([
      'familia-ingest',
      'civis-edificaciones',
      'personas-clean',
      'personas-name-floods',
      'search-index-backfill',
      'personas-dedupe-extid',
      'personas-dedupe-exact',
      'personas-dedupe-photo',
      'personas-purge-rejected',
      'hospital-match',
      'hospital-registry-match',
    ]);
    // civis-edificaciones moved to :15 — it must NOT also run in the :45 CIVIS
    // pipeline (stages must stay disjoint across the hour, like cron jobs).
    expect(CIVIS_STAGES.map((s) => s.name)).not.toContain('civis-edificaciones');
  });

  it(':30 is the single buildings-cases-hourly-pipeline seat with the dependency-driven stage order', () => {
    expect(CRON_GROUPS['30 * * * *'].map((j) => j.name)).toEqual(['funvisis-catchup-30', 'buildings-cases-hourly-pipeline']);
    // Order is load-bearing: buildings + CRM-sheet ingest BEFORE the
    // building↔case linker; hash backfill BEFORE the dedupes; case-alerts LAST
    // so alerts see the freshest case/building/sheet state. tv-building-cases
    // stays near the FRONT (it died at the tail of the old :30 group, 2026-07-02).
    expect(BUILDINGS_CASES_STAGES.map((s) => s.name)).toEqual([
      'tv-buildings',
      'cases-sheet-sync',
      'tv-building-cases',
      'monitor-sheet',
      'hospital-sheet',
      'familia-photo-mirror',
      'personas-phash-backfill-30',
      'personas-dedupe-fuzzyphone',
      'dedupe-engine-hourly',
      'bulk-import-sweep',
      'case-alerts',
    ]);
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
