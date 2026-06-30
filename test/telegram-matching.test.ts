// Matching + status-mapping + verification-gate tests for the Telegram bot.
import { describe, it, expect } from 'vitest';
import {
  getCaseById,
  searchPersonById,
  searchPersonByName,
  searchMissing,
  mapInternalStatusToPublicStatus,
  gatePublicStatus,
} from '../src/adapters/sismo911-api';
import { resolveQuery } from '../src/telegram/route';
import type { Env } from '../src/types';

// --- Minimal in-memory fake D1 that understands the adapter's queries.
// It mirrors the real SQL semantics: accent/case-insensitive substring matching
// and token-AND name search (every bound %token% must appear in the column).
function makeDB(data: Record<string, any[]>) {
  const tableOf = (sql: string) => /FROM\s+(\w+)/i.exec(sql)?.[1] ?? '';
  const fold = (s: any) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const digits = (s: any) => String(s ?? '').replace(/[.\-\sVEve]/g, '');
  // every bound `%tok%` must be a substring of (any of) the folded column values
  const matchAllTokens = (vals: any[], args: any[]) =>
    args.every((a) => vals.some((v) => fold(v).includes(fold(String(a).replace(/%/g, '')))));
  function run(sql: string, args: any[]): any[] {
    const t = tableOf(sql);
    // Detect predicates from the WHERE clause only — the SELECT column list also
    // mentions full_name/cedula/etc and would cause false matches.
    const where = sql.split(/\bWHERE\b/i)[1] ?? '';
    let rows = (data[t] ?? []).slice();
    if (t === 'persons') {
      if (/case_number = \? OR id = \?/.test(where)) rows = rows.filter((r) => r.case_number === args[0] || r.id === args[1] || r.id === args[0]);
      else if (/contact_phone/.test(where)) rows = rows.filter((r) => fold(String(r.contact_phone ?? '').replace(/[^0-9]/g, '')).includes(String(args[0]).replace(/%/g, '')));
      else if (/full_name/.test(where) && /LIKE/.test(where)) rows = rows.filter((r) => matchAllTokens([r.full_name], args));
      else if (/\bid = \?/.test(where)) rows = rows.filter((r) => r.id === args[0]);
    } else if (t === 'personas') {
      if (/nombre/.test(where) && /LIKE/.test(where)) rows = rows.filter((r) => matchAllTokens([r.nombre], args));
      else if (/\bid = \?/.test(where)) rows = rows.filter((r) => r.id === args[0]);
    } else if (t === 'hospital_patients') {
      if (/cedula/.test(where) && /= \?/.test(where)) rows = rows.filter((r) => digits(r.cedula) === digits(args[0]));
      else if (/telefono/.test(where)) rows = rows.filter((r) => fold(String(r.telefono ?? '').replace(/[^0-9]/g, '')).includes(String(args[0]).replace(/%/g, '')));
      else if (/name_variants/.test(where)) rows = rows.filter((r) => matchAllTokens([r.full_name, r.name_variants], args));
      else if (/\bid = \?/.test(where)) rows = rows.filter((r) => r.id === args[0]);
    } else if (t === 'case_identity') {
      rows = rows.filter((r) => digits(r.cedula) === digits(args[0]) && r.result === 'match');
    }
    return rows;
  }
  return {
    prepare(sql: string) {
      const stmt: any = {
        _args: [] as any[],
        bind(...a: any[]) { stmt._args = a; return stmt; },
        async first() { return run(sql, stmt._args)[0] ?? null; },
        async all() { return { results: run(sql, stmt._args) }; },
        async run() { return { success: true }; },
      };
      return stmt;
    },
  };
}

const NOW = Date.parse('2026-06-30T12:00:00Z');

function env(data: Record<string, any[]>): Env {
  return { DB: makeDB(data) } as unknown as Env;
}

describe('mapInternalStatusToPublicStatus', () => {
  it('maps each registry vocabulary correctly', () => {
    expect(mapInternalStatusToPublicStatus('persons', 'missing')).toBe('MISSING');
    expect(mapInternalStatusToPublicStatus('persons', 'found_deceased')).toBe('DEATH');
    expect(mapInternalStatusToPublicStatus('persons', 'found_safe')).toBe('LOCATED');
    expect(mapInternalStatusToPublicStatus('personas', 'sin-contacto')).toBe('MISSING');
    expect(mapInternalStatusToPublicStatus('personas', 'fallecido')).toBe('DEATH');
    expect(mapInternalStatusToPublicStatus('hospital', 'hospitalizado')).toBe('HOSPITALIZED');
    expect(mapInternalStatusToPublicStatus('hospital', 'alta')).toBe('ALIVE');
  });
  it('fails safe to UNKNOWN for anything unrecognized', () => {
    expect(mapInternalStatusToPublicStatus('persons', 'wat')).toBe('UNKNOWN');
    expect(mapInternalStatusToPublicStatus('hospital', '')).toBe('UNKNOWN');
  });
});

describe('gatePublicStatus — never assert an unverified final status', () => {
  it('collapses everything to PENDING when not verified', () => {
    expect(gatePublicStatus('DEATH', 'PENDING_VERIFICATION')).toBe('PENDING_VERIFICATION');
    expect(gatePublicStatus('MISSING', 'PENDING_VERIFICATION')).toBe('PENDING_VERIFICATION');
  });
  it('passes through when VERIFIED or OFFICIAL', () => {
    expect(gatePublicStatus('DEATH', 'VERIFIED')).toBe('DEATH');
    expect(gatePublicStatus('HOSPITALIZED', 'OFFICIAL')).toBe('HOSPITALIZED');
  });
});

describe('getCaseById', () => {
  const data = {
    persons: [
      { id: 'per_1', full_name: 'Maria Perez', age: 34, status: 'found_deceased', review: 'approved', case_number: 'EXP-2026-0001', updated_ms: NOW },
      { id: 'per_2', full_name: 'Pedro Pendiente', age: 40, status: 'found_deceased', review: 'pending', case_number: 'EXP-2026-0002', updated_ms: NOW },
    ],
    personas: [{ id: '555', nombre: 'Ana Familia', edad: 22, estado: 'hospitalizado', moderation: 'approved', updated_at: NOW }],
    hospital_patients: [{ id: 'hp_9', full_name: 'Jose Garcia', edad: '50', estado: 'hospitalizado', conflict: 0, updated_ms: NOW }],
  };
  it('finds a native case by EXP case_number and maps a verified status', async () => {
    const r = await getCaseById(env(data), 'EXP-2026-0001');
    expect(r?.caseId).toBe('EXP-2026-0001');
    expect(r?.publicStatus).toBe('DEATH');
    expect(r?.verification).toBe('VERIFIED');
  });
  it('an UNVERIFIED case never asserts the final status', async () => {
    const r = await getCaseById(env(data), 'EXP-2026-0002');
    expect(r?.verification).toBe('PENDING_VERIFICATION');
    expect(r?.publicStatus).toBe('PENDING_VERIFICATION');
  });
  it('resolves FAM- ids to the Familia registry', async () => {
    const r = await getCaseById(env(data), 'FAM-555');
    expect(r?.registry).toBe('personas');
    expect(r?.publicStatus).toBe('HOSPITALIZED');
  });
  it('resolves HOSP- ids to the hospital registry', async () => {
    const r = await getCaseById(env(data), 'HOSP-hp_9');
    expect(r?.registry).toBe('hospital');
    expect(r?.publicStatus).toBe('HOSPITALIZED');
  });
  it('returns null when nothing matches', async () => {
    expect(await getCaseById(env(data), 'EXP-2026-9999')).toBeNull();
  });
});

describe('searchPersonById (cédula) — strong + OFFICIAL upgrade', () => {
  const data = {
    hospital_patients: [{ id: 'hp_1', full_name: 'Luis Hosp', cedula: '12345678', edad: '30', estado: 'hospitalizado', conflict: 0, updated_ms: NOW }],
    case_identity: [{ person_id: 'per_77', cedula: '12345678', result: 'match' }],
    persons: [{ id: 'per_77', full_name: 'Luis Identidad', age: 30, status: 'missing', review: 'approved', case_number: 'EXP-2026-0077', updated_ms: NOW }],
  };
  it('matches the hospital row and the identity-confirmed case', async () => {
    const recs = await searchPersonById(env(data), 'V-12.345.678');
    const off = recs.find((r) => r.registry === 'persons');
    expect(recs.some((r) => r.registry === 'hospital')).toBe(true);
    expect(off?.verification).toBe('OFFICIAL');
    expect(off?.matchStrength).toBe('national_id');
  });
  it('ignores too-short cédulas', async () => {
    expect((await searchPersonById(env(data), '12')).length).toBe(0);
  });
});

describe('searchPersonByName + DOB corroboration', () => {
  const data = {
    persons: [{ id: 'per_a', full_name: 'Carlos Ramirez', age: 46, status: 'missing', review: 'approved', case_number: 'EXP-2026-0100', updated_ms: NOW }],
    personas: [{ id: '900', nombre: 'Carlos Ramirez', edad: 46, estado: 'sin-contacto', moderation: 'approved', updated_at: NOW }],
  };
  it('returns multiple possible records for a full-name-only search', async () => {
    const recs = await searchPersonByName(env(data), { name: 'Carlos Ramirez' }, NOW);
    expect(recs.length).toBe(2);
    expect(recs.every((r) => r.matchStrength === 'name')).toBe(true);
  });
  it('upgrades to name_dob when a DOB-derived age corroborates', async () => {
    const recs = await searchPersonByName(env(data), { name: 'Carlos Ramirez', dob: '1980-01-01' }, NOW);
    expect(recs.some((r) => r.matchStrength === 'name_dob')).toBe(true);
  });
});

describe('name search is accent- AND case-insensitive, order-independent', () => {
  const data = {
    persons: [
      { id: 'per_mo', full_name: 'Moisés Alejandro Carpio', age: 30, status: 'missing', review: 'approved', case_number: 'EXP-2026-0300', updated_ms: NOW },
    ],
    personas: [] as any[],
  };
  it('matches "Moises" (no accent) against stored "Moisés"', async () => {
    expect((await searchPersonByName(env(data), { name: 'Moises Carpio' }, NOW)).length).toBe(1);
  });
  it('matches ALL CAPS', async () => {
    expect((await searchPersonByName(env(data), { name: 'MOISES CARPIO' }, NOW)).length).toBe(1);
  });
  it('matches tokens in any order', async () => {
    expect((await searchPersonByName(env(data), { name: 'carpio moises' }, NOW)).length).toBe(1);
  });
  it('matches the exact accented spelling too', async () => {
    expect((await searchPersonByName(env(data), { name: 'Moisés Carpio' }, NOW)).length).toBe(1);
  });
});

describe('searchMissing only returns still-missing cases', () => {
  const data = {
    persons: [
      { id: 'per_m', full_name: 'Ana Rodriguez', age: 20, status: 'missing', review: 'approved', case_number: 'EXP-2026-0200', updated_ms: NOW },
      { id: 'per_f', full_name: 'Ana Rodriguez', age: 21, status: 'found_safe', review: 'approved', case_number: 'EXP-2026-0201', updated_ms: NOW },
    ],
    personas: [],
  };
  it('drops resolved cases', async () => {
    const recs = await searchMissing(env(data), { name: 'Ana Rodriguez' });
    expect(recs.length).toBe(1);
    expect(recs[0].caseId).toBe('EXP-2026-0200');
  });
});

describe('resolveQuery end-to-end (no_match / multiple / single)', () => {
  const data = {
    persons: [
      { id: 'per_a', full_name: 'Carlos Ramirez', age: 46, status: 'missing', review: 'approved', case_number: 'EXP-2026-0100', updated_ms: NOW },
    ],
    personas: [{ id: '900', nombre: 'Carlos Ramirez', edad: 46, estado: 'sin-contacto', moderation: 'approved', updated_at: NOW }],
  };
  const ctx = { canSeeSensitive: false, role: 'public' as const, nowMs: NOW };
  it('no_match for an unknown case id', async () => {
    const r = await resolveQuery(env(data), { kind: 'caso', lang: 'es', caseId: 'EXP-2026-7777', raw: '' }, ctx);
    expect(r.kind).toBe('no_match');
  });
  it('multiple for a name that hits two registries', async () => {
    const r = await resolveQuery(env(data), { kind: 'buscar', lang: 'es', name: 'Carlos Ramirez', raw: '' }, ctx);
    expect(r.kind).toBe('multiple');
  });
  it('single match for an exact case id', async () => {
    const r = await resolveQuery(env(data), { kind: 'status', lang: 'es', caseId: 'EXP-2026-0100', raw: '' }, ctx);
    expect(r.kind).toBe('match');
  });
  it('phone search is refused for a non-privileged viewer', async () => {
    const r = await resolveQuery(env(data), { kind: 'buscar', lang: 'es', phone: '+584141234567', raw: '' }, ctx);
    expect(r).toEqual({ kind: 'need_more', reason: 'phone_requires_admin' });
  });
});
