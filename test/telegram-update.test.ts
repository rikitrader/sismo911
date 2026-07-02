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
  it('accepts a multi-word NAME as the target (the reported bug)', () => {
    const c = parseCommand('/actualizar Sarah Ysea Caracciolo estado localizado fallecido');
    expect(c.kind).toBe('actualizar');
    expect(c.caseId).toBe('Sarah Ysea Caracciolo');
    expect(c.updateField).toBe('estado');
    expect(c.updateValue).toBe('localizado fallecido'); // ambiguity caught in resolveUpdate
  });
  it('name target works with every field', () => {
    const c = parseCommand('/actualizar Juan Pérez Gómez edad 34');
    expect(c.caseId).toBe('Juan Pérez Gómez');
    expect(c.updateField).toBe('edad');
    expect(c.updateValue).toBe('34');
  });
});

describe('parseCommand estado shortcuts', () => {
  it('/fallecido <nombre> → actualizar estado fallecido', () => {
    const c = parseCommand('/fallecido Sarah Ysea Caracciolo');
    expect(c.kind).toBe('actualizar');
    expect(c.updateField).toBe('estado');
    expect(c.updateValue).toBe('fallecido');
    expect(c.caseId).toBe('Sarah Ysea Caracciolo');
    expect(c.statusShortcut).toBe(true);
  });
  it('all five shortcuts map to their estado (feminine forms too)', () => {
    expect(parseCommand('/localizada Ana Díaz').updateValue).toBe('localizado');
    expect(parseCommand('/aparecido FAM-9').updateValue).toBe('aparecido');
    expect(parseCommand('/hospitalizado Ana Díaz').updateValue).toBe('hospitalizado');
    expect(parseCommand('/sincontacto Ana Díaz').updateValue).toBe('sin-contacto');
    expect(parseCommand('/sin-contacto Ana Díaz').updateValue).toBe('sin-contacto');
  });
  it('shortcuts are SLASH-ONLY (free text never writes)', () => {
    const c = parseCommand('fallecido Maria Perez');
    expect(c.kind).toBe('buscar'); // plain search, not a write
  });
  it('bare /hospitalizado (no args) keeps the legacy search alias', () => {
    expect(parseCommand('/hospitalizado').kind).toBe('hospitalizados');
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

/** fakeEnv whose personas NAME search returns the given rows (id lookups miss). */
function fakeEnvNameSearch(rows: any[], capture: Array<{ sql: string; args: any[] }>): Env {
  const DB = {
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          return {
            async first() {
              return null; // no id match — force the name-resolution path
            },
            async all() {
              return { results: /FROM personas WHERE/.test(sql) ? rows : [] };
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
  it('rejects TWO estados at once as ambiguous (the reported bug)', async () => {
    const r = await resolveUpdate(fakeEnv(PERSONA, []), cmd({ caseId: 'pc_x', updateField: 'estado', updateValue: 'localizado fallecido' }), ctx('authorized'));
    expect(r).toEqual({ kind: 'update_bad_input', reason: 'ambiguous_estado' });
    const txt = buildUpdateResponse(r, { lang: 'es', role: 'authorized', canSeeSensitive: true });
    expect(txt).toMatch(/SOLO UNO/);
  });
  it('accepts the two-word alias "sin contacto" as ONE estado', async () => {
    const cap: Array<{ sql: string; args: any[] }> = [];
    const r = await resolveUpdate(fakeEnv(PERSONA, cap), cmd({ caseId: 'pc_x', updateField: 'estado', updateValue: 'sin contacto' }), ctx('authorized'));
    expect(r.kind).toBe('update_ok');
    expect(cap.some((q) => q.args.includes('sin-contacto'))).toBe(true);
  });
  it('resolves a NAME target to the single matching persona', async () => {
    const cap: Array<{ sql: string; args: any[] }> = [];
    const r = await resolveUpdate(
      fakeEnvNameSearch([PERSONA], cap),
      cmd({ caseId: 'Juan Perez', updateField: 'estado', updateValue: 'fallecido' }),
      ctx('authorized'),
    );
    expect(r.kind).toBe('update_ok');
    expect(r.kind === 'update_ok' && r.caseId).toBe('FAM-pc_x');
    expect(cap.some((q) => /UPDATE personas SET estado/.test(q.sql) && q.args.includes('fallecido'))).toBe(true);
  });
  it('a NAME matching several personas returns the candidate list', async () => {
    const rows = [PERSONA, { ...PERSONA, id: 'pc_y', nombre: 'Juan Perez Gomez' }];
    const r = await resolveUpdate(
      fakeEnvNameSearch(rows, []),
      cmd({ caseId: 'Juan Perez', updateField: 'estado', updateValue: 'fallecido' }),
      ctx('authorized'),
    );
    expect(r.kind).toBe('update_ambiguous');
    if (r.kind === 'update_ambiguous') {
      expect(r.candidates.length).toBe(2);
      expect(r.candidates[0].caseId).toBe('FAM-pc_x');
    }
    const txt = buildUpdateResponse(r, { lang: 'es', role: 'authorized', canSeeSensitive: true });
    expect(txt).toContain('FAM-pc_y');
    expect(txt).toContain('<b>Juan Perez Gomez</b>');
  });
  it('an unknown NAME returns not_found with the name hint', async () => {
    const r = await resolveUpdate(fakeEnvNameSearch([], []), cmd({ caseId: 'Nadie Conocido', updateField: 'estado', updateValue: 'fallecido' }), ctx('authorized'));
    expect(r.kind).toBe('update_not_found');
    const txt = buildUpdateResponse(r, { lang: 'es', role: 'authorized', canSeeSensitive: true });
    expect(txt).toMatch(/nombre completo/);
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
