import { describe, it, expect } from 'vitest';
import { canTransition } from '../src/routes/flota-misiones';

// The dispatch lifecycle is the most logic-heavy part of FLOTA, so it gets the
// most explicit coverage. Linear order:
//   creada → despachada → en_ruta → en_sitio → completada
// 'cancelada' is reachable from any non-terminal state. 'despachada' is reached
// ONLY via POST /despachar (not via /estado), so canTransition rejects it.

describe('FLOTA mission state machine — valid single-step advances', () => {
  it('despachada → en_ruta', () => expect(canTransition('despachada', 'en_ruta')).toBe(true));
  it('en_ruta → en_sitio', () => expect(canTransition('en_ruta', 'en_sitio')).toBe(true));
  it('en_sitio → completada', () => expect(canTransition('en_sitio', 'completada')).toBe(true));
});

describe('FLOTA mission state machine — cancelación', () => {
  for (const from of ['creada', 'despachada', 'en_ruta', 'en_sitio']) {
    it(`${from} → cancelada is allowed`, () => expect(canTransition(from, 'cancelada')).toBe(true));
  }
});

describe('FLOTA mission state machine — invalid transitions are rejected', () => {
  it('cannot skip a step (despachada → en_sitio)', () => expect(canTransition('despachada', 'en_sitio')).toBe(false));
  it('cannot skip to completada (en_ruta → completada)', () => expect(canTransition('en_ruta', 'completada')).toBe(false));
  it('cannot move backwards (en_sitio → en_ruta)', () => expect(canTransition('en_sitio', 'en_ruta')).toBe(false));
  it('unknown target is rejected (en_ruta → bogus)', () => expect(canTransition('en_ruta', 'bogus')).toBe(false));
  // Note: canTransition('creada','despachada') is true (a valid ordered step),
  // but the POST /estado handler's allow-list excludes 'despachada' (400) so it
  // is only ever reachable via POST /despachar. That guard is at the route layer.
  it('creada → despachada is a valid ordered step at the helper level', () =>
    expect(canTransition('creada', 'despachada')).toBe(true));
});

describe('FLOTA mission state machine — terminal states are frozen', () => {
  for (const to of ['en_ruta', 'completada', 'cancelada', 'creada']) {
    it(`completada → ${to} is rejected`, () => expect(canTransition('completada', to)).toBe(false));
    it(`cancelada → ${to} is rejected`, () => expect(canTransition('cancelada', to)).toBe(false));
  }
});
