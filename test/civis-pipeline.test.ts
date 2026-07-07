// Consolidated CIVIS pipeline: sequential stages, failure isolation, dedupe last.
import { describe, it, expect } from 'vitest';
import { runCivisPipeline, CIVIS_STAGES, type PipelineStage } from '../src/ingest/civis-pipeline';
import type { Env } from '../src/types';

const env = {} as Env;

describe('runCivisPipeline', () => {
  it('runs stages in order and reports each', async () => {
    const order: string[] = [];
    const stages: PipelineStage[] = ['a', 'b', 'c'].map((n) => ({ name: n, run: async () => { order.push(n); return { n }; } }));
    const s = await runCivisPipeline(env, stages);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(s.ok).toBe(3);
    expect(s.failed).toBe(0);
  });

  it('a failing source never blocks the rest (dedupe still runs last)', async () => {
    const order: string[] = [];
    const stages: PipelineStage[] = [
      { name: 'boom', run: async () => { throw new Error('upstream 429'); } },
      { name: 'ok', run: async () => { order.push('ok'); } },
      { name: 'dedupe-pass', run: async () => { order.push('dedupe'); } },
    ];
    const s = await runCivisPipeline(env, stages);
    expect(order).toEqual(['ok', 'dedupe']);
    expect(s.failed).toBe(1);
    expect(s.stages[0]).toMatchObject({ name: 'boom', ok: false });
    expect(s.stages[0].error).toContain('429');
  });

  it('default stage order ends with the dedupe pass', () => {
    expect(CIVIS_STAGES[CIVIS_STAGES.length - 1].name).toBe('dedupe-pass');
    // civis-edificaciones moved to the :15 personas-hourly-pipeline (fresh
    // building data before that tick's matching) — it must NOT reappear here.
    expect(CIVIS_STAGES.map((s) => s.name).slice(0, 3)).toEqual(['civis-desaparecidos', 'civis-atendidos', 'civis-extras']);
  });
});
