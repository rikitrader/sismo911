// Consolidated RAV pipeline: stage order, failure isolation, dedupe last.
import { describe, it, expect } from 'vitest';
import { runRavPipeline, RAV_STAGES } from '../src/ingest/rav-pipeline';
import type { PipelineStage } from '../src/ingest/pipeline';
import type { Env } from '../src/types';

const env = {} as Env;

describe('runRavPipeline', () => {
  it('runs stages in order via the shared runner', async () => {
    const order: string[] = [];
    const stages: PipelineStage[] = ['a', 'b'].map((n) => ({ name: n, run: async () => { order.push(n); } }));
    const s = await runRavPipeline(env, stages);
    expect(order).toEqual(['a', 'b']);
    expect(s.ok).toBe(2);
  });

  it('a failing source never blocks the dedupe stages', async () => {
    const order: string[] = [];
    const stages: PipelineStage[] = [
      { name: 'rav-ingest', run: async () => { throw new Error('supabase 429'); } },
      { name: 'rav-reports-dedupe-extid', run: async () => { order.push('extid'); } },
      { name: 'dedupe-pass', run: async () => { order.push('scored'); } },
    ];
    const s = await runRavPipeline(env, stages);
    expect(order).toEqual(['extid', 'scored']);
    expect(s.failed).toBe(1);
    expect(s.stages[0].error).toContain('429');
  });

  it('default stage order: person ingest first, both dedupe passes last', () => {
    const names = RAV_STAGES.map((s) => s.name);
    expect(names[0]).toBe('rav-ingest');
    expect(names.slice(-2)).toEqual(['rav-reports-dedupe-extid', 'dedupe-pass']);
    expect(names).toContain('pacientes-rvz');
  });
});
