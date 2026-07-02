import { describe, it, expect } from 'vitest';
import { parseCommand } from '../src/telegram/commands';
import { resolveEvaluar } from '../src/telegram/evaluar';
import { verifyEventSignature, type EvalEventRow } from '../src/lib/building-eval';
import { makeDb, makeEnv, type D1Mock } from './helpers/d1';

// ── Parser ────────────────────────────────────────────────────────────────────

describe('/evaluar — parser', () => {
  it('parses building + level + status + note', () => {
    const c = parseCommand('/evaluar "Bahía del mar" n1 en_curso Inspección exterior iniciada');
    expect(c.kind).toBe('evaluar');
    expect(c.evalQuery).toBe('Bahía del mar');
    expect(c.evalLevel).toBe(1);
    expect(c.evalStatus).toBe('en_curso');
    expect(c.evalNote).toBe('Inspección exterior iniciada');
  });
  it('accepts unquoted multi-word building, "nivel 2", and status aliases', () => {
    const c = parseCommand('/evaluar Residencias Costamar nivel 2 completada Marcado verde');
    expect(c.evalQuery).toBe('Residencias Costamar');
    expect(c.evalLevel).toBe(2);
    expect(c.evalStatus).toBe('completada');
    const d = parseCommand('/evaluar Tanaguarena n3 iniciada');
    expect(d.evalLevel).toBe(3);
    expect(d.evalStatus).toBe('en_curso');
    const e = parseCommand('/evaluar Tanaguarena n1 en curso revisión');
    expect(e.evalStatus).toBe('en_curso');
    expect(e.evalNote).toBe('revisión');
  });
  it('note-only (no status) parses; missing level leaves evalLevel undefined', () => {
    const c = parseCommand('/evaluar Costamar n2 Grieta diagonal en machón');
    expect(c.evalStatus).toBeUndefined();
    expect(c.evalNote).toBe('Grieta diagonal en machón');
    const d = parseCommand('/evaluar Costamar grieta');
    expect(d.kind).toBe('evaluar');
    expect(d.evalLevel).toBeUndefined();
  });
  it('bare word "evaluar" without slash is a search, never a write', () => {
    const c = parseCommand('evaluar los daños de mi casa');
    expect(c.kind).toBe('buscar');
  });
});

// ── Resolver (real SQLite) ────────────────────────────────────────────────────

async function setup() {
  const db: D1Mock = makeDb(['migrations/0093_building_eval.sql', 'migrations/0094_building_eval_v2.sql']);
  db.raw.exec(`CREATE TABLE tv_buildings (id TEXT PRIMARY KEY, name TEXT, tv_updated_at TEXT)`);
  db.raw.exec(`INSERT INTO tv_buildings (id, name, tv_updated_at) VALUES
    ('b1', 'Bahía del mar', '2026-07-01'), ('b2', 'Residencias Costamar', '2026-07-01'), ('b3', 'Costamar II', '2026-07-01')`);
  return { db, env: makeEnv(db) as any };
}
const CTX = { role: 'operator' as any, actor: 'tg:777', actorName: 'Ing. Field' };

describe('/evaluar — resolver', () => {
  it('public sender is refused', async () => {
    const { env } = await setup();
    const r = await resolveEvaluar(env, parseCommand('/evaluar "Bahía del mar" n1 en_curso'), { ...CTX, role: 'public' as any });
    expect(r.kind).toBe('eval_forbidden');
  });
  it('logs a signed, user-stamped event that verifies', async () => {
    const { db, env } = await setup();
    const r = await resolveEvaluar(env, parseCommand('/evaluar "Bahía del mar" n1 en_curso Inspección iniciada'), CTX);
    expect(r.kind).toBe('eval_ok');
    const row = db.raw.prepare(`SELECT * FROM building_eval_events`).get() as unknown as EvalEventRow;
    expect(row.user_id).toBe('tg:777');
    expect(row.user_name).toBe('Ing. Field');
    expect(row.event_kind).toBe('cambio_estado');
    expect(await verifyEventSignature(row)).toBe(true);
  });
  it('enforces the level-order rule from chat too', async () => {
    const { env } = await setup();
    const r = await resolveEvaluar(env, parseCommand('/evaluar "Bahía del mar" n2 en_curso'), CTX);
    expect(r.kind).toBe('eval_order');
  });
  it('ambiguous name → candidate list; unknown → not_found', async () => {
    const { env } = await setup();
    const a = await resolveEvaluar(env, parseCommand('/evaluar Costamar n1 nota de prueba'), CTX);
    expect(a.kind).toBe('eval_ambiguous');
    const b = await resolveEvaluar(env, parseCommand('/evaluar "Residencias Costamar" n1 nota de prueba'), CTX);
    expect(b.kind).toBe('eval_ok'); // exact match resolves despite two LIKE hits
    const c = await resolveEvaluar(env, parseCommand('/evaluar Zzz n1 nota'), CTX);
    expect(c.kind).toBe('eval_not_found');
  });
});
