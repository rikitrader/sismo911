// Tests for the operator write command (/actualizar): parsing + resolveUpdate.
import { describe, it, expect } from 'vitest';
import { parseCommand } from '../src/telegram/commands';
import { resolveUpdate } from '../src/telegram/update';
import { buildUpdateResponse } from '../src/telegram/responses';
import type { Env } from '../src/types';
import type { ParsedCommand, ViewerRole } from '../src/telegram/types';

// ---- parsing --------------------------------------------------------------
describe('parseCommand /actualizar', () => {
  it('parses field + value', () => {
    const c = parseCommand('/actualizar FAM-abc estado localizado');
    expect(c.kind).toBe('actualizar');
    expect(c.caseId).toBe('FAM-abc');
    expect(c.updateField).toBe('estado');
    expect(c.updateValue).toBe('localizado');
  });
  it('keeps a quoted multi-word value', () => {
    const c = parseCommand('/actualizar pc_x nota "Visto en el refugio de Catia"');
    expect(c.updateField).toBe('nota');
    expect(c.updateValue).toBe('Visto en el refugio de Catia');
  });
  it('accepts campo=valor form', () => {
    const c = parseCommand('/actualizar pc_x estado=localizado');
    expect(c.updateField).toBe('estado');
    expect(c.updateValue).toBe('localizado');
  });
  it('parses a no-value action (aprobar) and aliases', () => {
    expect(parseCommand('/actualizar pc_x aprobar').updateField).toBe('aprobar');
    expect(parseCommand('/editar pc_x edad 34').updateField).toBe('edad');
    expect(parseCommand('/update pc_x name "Juan Perez"').updateField).toBe('nombre');
  });
});

// ---- resolveUpdate --------------------------------------------------------
const PERSONA = { id: 'pc_x', nombre: 'Juan Perez', edad: 30, estado: 'sin-contacto', moderation: 'pending', protected: 0, contacto: '', ubicacion: 'Caracas', localizado_contacto: null, updated_at: 1 };

function fakeEnv(row: any, capture: Array<{ sql: string; args: any[] }>): Env {
  const DB = {
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          return {
            async first() {
              return /FROM personas WHERE id/.test(sql) ? row : null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              capture.push({ sql, args });
              return { success: true };
            },
          };
        },
      };
    },
  };
  return { DB } as unknown as Env;
}

const cmd = (over: Partial<ParsedCommand>): ParsedCommand => ({ kind: 'actualizar', lang: 'es', raw: '', ...over });
const ctx = (role: ViewerRole) => ({ role, actor: 'tg:1', nowMs: 1000 });

describe('resolveUpdate authorization', () => {
  it('blocks the public tier', async () => {
    const r = await resolveUpdate(fakeEnv(PERSONA, []), cmd({ caseId: 'pc_x', updateField: 'estado', updateValue: 'localizado' }), ctx('public'));
    expect(r).toEqual({ kind: 'update_forbidden', reason: 'not_operator' });
  });
  it('blocks non-admins from aprobar/rechazar', async () => {
    const r = await resolveUpdate(fakeEnv(PERSONA, []), cmd({ caseId: 'pc_x', updateField: 'aprobar' }), ctx('authorized'));
    expect(r).toEqual({ kind: 'update_forbidden', reason: 'not_executive' });
  });
});

describe('resolveUpdate validation', () => {
  it('rejects a missing id', async () => {
    const r = await resolveUpdate(fakeEnv(PERSONA, []), cmd({ updateField: 'estado', updateValue: 'x' }), ctx('admin'));
    expect(r).toMatchObject({ kind: 'update_bad_input', reason: 'missing_id' });
  });
  it('rejects a missing value', async () => {
    const r = await resolveUpdate(fakeEnv(PERSONA, []), cmd({ caseId: 'pc_x', updateField: 'estado' }), ctx('admin'));
    expect(r).toMatchObject({ kind: 'update_bad_input', reason: 'missing_value' });
  });
  it('rejects an invalid estado', async () => {
    const r = await resolveUpdate(fakeEnv(PERSONA, []), cmd({ caseId: 'pc_x', updateField: 'estado', updateValue: 'xyz' }), ctx('admin'));
    expect(r).toMatchObject({ kind: 'update_bad_input', reason: 'bad_estado' });
  });
  it('returns not_found when the case is missing', async () => {
    const r = await resolveUpdate(fakeEnv(null, []), cmd({ caseId: 'pc_zzz', updateField: 'contacto', updateValue: '0412' }), ctx('admin'));
    expect(r.kind).toBe('update_not_found');
  });
});

describe('resolveUpdate writes', () => {
  it('updates estado (operator tier)', async () => {
    const cap: Array<{ sql: string; args: any[] }> = [];
    const r = await resolveUpdate(fakeEnv(PERSONA, cap), cmd({ caseId: 'pc_x', updateField: 'estado', updateValue: 'localizado' }), ctx('authorized'));
    expect(r.kind).toBe('update_ok');
    expect(cap.some((q) => /UPDATE personas SET estado/.test(q.sql) && q.args.includes('localizado'))).toBe(true);
    // Reply summary is humanized (DB keeps the raw token).
    expect(r.kind === 'update_ok' && r.summary).toBe('estado → Localizado(a)');
  });
  it('adds a note as a verified case_intel row', async () => {
    const cap: Array<{ sql: string; args: any[] }> = [];
    const r = await resolveUpdate(fakeEnv(PERSONA, cap), cmd({ caseId: 'pc_x', updateField: 'nota', updateValue: 'Visto en Catia' }), ctx('authorized'));
    expect(r.kind).toBe('update_ok');
    const ins = cap.find((q) => /INSERT INTO case_intel/.test(q.sql));
    expect(ins).toBeTruthy();
    expect(ins!.args).toContain('fam-pc_x');
    expect(ins!.args).toContain('verified');
  });
  it('approves a draft (admin tier)', async () => {
    const cap: Array<{ sql: string; args: any[] }> = [];
    const r = await resolveUpdate(fakeEnv(PERSONA, cap), cmd({ caseId: 'pc_x', updateField: 'aprobar' }), ctx('admin'));
    expect(r.kind).toBe('update_ok');
    expect(cap.some((q) => /moderation='approved'/.test(q.sql))).toBe(true);
  });
});

describe('buildUpdateResponse', () => {
  it('renders the ok + forbidden messages', () => {
    expect(buildUpdateResponse({ kind: 'update_ok', field: 'estado', caseId: 'FAM-x', name: 'Ana', summary: 'estado → localizado' }, { lang: 'es', role: 'admin', canSeeSensitive: true })).toContain('actualizado');
    expect(buildUpdateResponse({ kind: 'update_forbidden', reason: 'not_executive' }, { lang: 'es', role: 'authorized', canSeeSensitive: true })).toContain('ejecutivo');
  });
});
