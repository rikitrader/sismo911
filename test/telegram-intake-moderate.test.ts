// Unit tests for operator intake moderation by ITK code (/aprobar | /rechazar).
import { describe, it, expect } from 'vitest';
import {
  normalizeItkCode,
  parseModerationCommand,
  buildModerationReply,
  resolveIntakeModeration,
} from '../src/telegram/intake/moderate';
import type { Env } from '../src/types';

describe('normalizeItkCode', () => {
  it('round-trips the public code to the internal id', () => {
    expect(normalizeItkCode('ITK-6439A061')).toEqual({ display: 'ITK-6439A061', id: 'itk_6439a061' });
  });
  it('tolerates lowercase, spaces and missing dash', () => {
    expect(normalizeItkCode('itk 6439a061').id).toBe('itk_6439a061');
    expect(normalizeItkCode('ITK6439A061').id).toBe('itk_6439a061');
  });
});

describe('parseModerationCommand', () => {
  it('parses approve variants', () => {
    expect(parseModerationCommand('/aprobar ITK-6439A061')).toEqual({ action: 'approve', code: 'ITK-6439A061' });
    expect(parseModerationCommand('aprobado ITK-6439A061')?.action).toBe('approve');
    expect(parseModerationCommand('/aprovar ITK-6439A061')?.action).toBe('approve');
  });
  it('parses reject variants', () => {
    expect(parseModerationCommand('/rechazar ITK-6439A061')).toEqual({ action: 'reject', code: 'ITK-6439A061' });
    expect(parseModerationCommand('rechazado ITK-6439A061')?.action).toBe('reject');
  });
  it('ignores non-moderation text', () => {
    expect(parseModerationCommand('/buscar Juan')).toBeNull();
    expect(parseModerationCommand('hola')).toBeNull();
    expect(parseModerationCommand('/aprobar')).toBeNull(); // needs a code
  });
});

/** Minimal D1 stub that records UPDATEs and returns a canned submission row. */
function fakeEnv(row: Record<string, unknown> | null) {
  const runs: string[] = [];
  const DB = {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async first() {
              return sql.includes('FROM intake_submissions') ? row : null;
            },
            async run() {
              runs.push(sql.replace(/\s+/g, ' ').trim());
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  return { env: { DB } as unknown as Env, runs };
}

const draft = {
  id: 'itk_6439a061',
  person_id: 'fam-pc_754d2f5a',
  intel_id: 'intl_9ba139e2',
  outcome: 'created',
  name: 'EDISON ALVARENGA CISNEROS',
  mod: 'pending',
};

describe('resolveIntakeModeration', () => {
  it('rejects non-admin callers (forbidden)', async () => {
    const { env } = fakeEnv(draft);
    const r = await resolveIntakeModeration(env, { code: 'ITK-6439A061', action: 'approve', role: 'public', actor: 'tg:1' });
    expect(r.kind).toBe('forbidden');
  });

  it('approves a draft: publishes persona + verifies lead + marks submission', async () => {
    const { env, runs } = fakeEnv(draft);
    const r = await resolveIntakeModeration(env, { code: 'ITK-6439A061', action: 'approve', role: 'admin', actor: 'tg:1' });
    expect(r.kind).toBe('approved');
    expect(r.name).toBe('EDISON ALVARENGA CISNEROS');
    expect(runs.some((s) => s.includes("personas SET moderation='approved'"))).toBe(true);
    expect(runs.some((s) => s.includes("case_intel SET status='verified'"))).toBe(true);
    expect(runs.some((s) => s.includes("intake_submissions SET outcome='approved'"))).toBe(true);
  });

  it('rejects a draft: hides persona + dismisses lead', async () => {
    const { env, runs } = fakeEnv(draft);
    const r = await resolveIntakeModeration(env, { code: 'ITK-6439A061', action: 'reject', role: 'admin', actor: 'tg:1' });
    expect(r.kind).toBe('rejected');
    expect(runs.some((s) => s.includes("personas SET moderation='rejected'"))).toBe(true);
    expect(runs.some((s) => s.includes("case_intel SET status='dismissed'"))).toBe(true);
  });

  it('returns not_found for an unknown code', async () => {
    const { env } = fakeEnv(null);
    const r = await resolveIntakeModeration(env, { code: 'ITK-DEADBEEF', action: 'approve', role: 'admin', actor: 'tg:1' });
    expect(r.kind).toBe('not_found');
  });
});

describe('buildModerationReply', () => {
  it('renders each outcome', () => {
    expect(buildModerationReply({ kind: 'approved', code: 'ITK-1', name: 'Ana' })).toContain('aprobado');
    expect(buildModerationReply({ kind: 'rejected', code: 'ITK-1' })).toContain('rechazado');
    expect(buildModerationReply({ kind: 'forbidden', code: 'ITK-1' })).toContain('administrador');
    expect(buildModerationReply({ kind: 'not_found', code: 'ITK-1' })).toContain('No encontré');
  });
});
