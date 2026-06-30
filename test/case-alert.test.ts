import { describe, it, expect } from 'vitest';
import {
  buildSnapshot, hashCaseState, diffCase, statusLabelFor, caseStateSnapshot,
  type CaseSnapshot,
} from '../src/lib/case-alert';

const base = (over: Partial<Parameters<typeof buildSnapshot>[0]> = {}) =>
  buildSnapshot({ caseId: 'fam-abc', name: 'Juana Pérez', status: 'sin-contacto', location: 'La Guaira', notes: 'visto cerca del puerto', reportCount: 2, verifiedLeads: 1, latestLead: 'avistamiento', priority: 'alta', ...over });

describe('case-alert: status labels by source table', () => {
  it('fam- cases use the personas estado vocabulary (ES)', () => {
    expect(statusLabelFor('fam-1', 'aparecido')).toBe('Apareció / a salvo');
    expect(statusLabelFor('fam-1', 'fallecido')).toBe('Fallecido');
  });
  it('bare persons ids use the persons status vocabulary (ES)', () => {
    expect(statusLabelFor('p-1', 'found_safe')).toBe('Encontrado a salvo');
    expect(statusLabelFor('p-1', 'missing')).toBe('Desaparecido');
  });
  it('unknown tokens fall through to the raw value (never empty crash)', () => {
    expect(statusLabelFor('fam-1', 'weird-state')).toBe('weird-state');
    expect(statusLabelFor('fam-1', '')).toBe('Sin estado');
  });
});

describe('case-alert: hashing is deterministic + change-sensitive', () => {
  it('same watched fields → same hash', async () => {
    const a = await hashCaseState(base());
    const b = await hashCaseState(base());
    expect(a).toBe(b);
  });
  it('a status change flips the hash', async () => {
    const a = await hashCaseState(base({ status: 'sin-contacto' }));
    const b = await hashCaseState(base({ status: 'aparecido' }));
    expect(a).not.toBe(b);
  });
  it('name change does NOT affect the hash (name is not a watched alert field)', async () => {
    const a = await hashCaseState(base({ name: 'Juana Pérez' }));
    const b = await hashCaseState(base({ name: 'Juana P. Pérez' }));
    expect(a).toBe(b);
  });
});

describe('case-alert: diffCase produces human-readable changes', () => {
  it('first snapshot (prev null) yields no changes — baseline never alerts', () => {
    expect(diffCase(null, base())).toEqual([]);
  });
  it('detects an estado change with ES label + from/to', () => {
    const prev = base({ status: 'sin-contacto' });
    const next = base({ status: 'aparecido' });
    const ch = diffCase(prev, next);
    expect(ch).toHaveLength(1);
    expect(ch[0].label).toBe('Estado');
    expect(ch[0].from).toBe('Sin contacto');
    expect(ch[0].to).toBe('Apareció / a salvo');
  });
  it('detects a new verified lead (count + title)', () => {
    const prev = base({ verifiedLeads: 1, latestLead: 'avistamiento' });
    const next = base({ verifiedLeads: 2, latestLead: 'cámara de seguridad' });
    const fields = diffCase(prev, next).map((c) => c.field);
    expect(fields).toContain('verifiedLeads');
    expect(fields).toContain('latestLead');
  });
  it('identical snapshots → no changes', () => {
    expect(diffCase(base(), base())).toEqual([]);
  });
});

// --- IO layer: caseStateSnapshot resolves the right table by id prefix --------
// Minimal fake D1 that records which table was queried and returns canned rows.
function fakeEnv(rows: Record<string, any>, queriedTables: string[]) {
  const db = {
    prepare(sql: string) {
      const table = /FROM\s+(\w+)/i.exec(sql)?.[1] || '';
      return {
        bind() {
          return {
            async first() {
              if (sql.includes('case_intel')) { queriedTables.push('case_intel'); return rows.case_intel ?? { n: 0, latest: '' }; }
              if (sql.includes('case_meta')) { queriedTables.push('case_meta'); return rows.case_meta ?? { priority: '' }; }
              queriedTables.push(table);
              return rows[table] ?? null;
            },
          };
        },
      };
    },
  };
  return { DB: db } as any;
}

describe('case-alert: caseStateSnapshot table resolution', () => {
  it('fam- id reads the personas registry', async () => {
    const tables: string[] = [];
    const env = fakeEnv({ personas: { nombre: 'Ana', estado: 'localizado', ubicacion: 'Maiquetía', descripcion: 'n', reportes: 3 } }, tables);
    const snap = await caseStateSnapshot(env, 'fam-xyz') as CaseSnapshot;
    expect(tables).toContain('personas');
    expect(snap.statusLabel).toBe('Localizado');
    expect(snap.reportCount).toBe(3);
  });
  it('bare id reads the persons docket', async () => {
    const tables: string[] = [];
    const env = fakeEnv({ persons: { full_name: 'Bob', status: 'found_safe', last_seen: 'CCS', notes: 'x' } }, tables);
    const snap = await caseStateSnapshot(env, 'p-99') as CaseSnapshot;
    expect(tables).toContain('persons');
    expect(snap.statusLabel).toBe('Encontrado a salvo');
  });
  it('missing record → null (case removed)', async () => {
    const env = fakeEnv({ personas: null }, []);
    expect(await caseStateSnapshot(env, 'fam-gone')).toBeNull();
  });
});
