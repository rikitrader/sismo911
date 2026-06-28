import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Guards the dispatch panel wiring on the admin live map (the operator loop:
// assign a unit to a case → advance → clear). The endpoints themselves are
// covered by test/flota-dispatch.int.test.ts.
const html = readFileSync('public/admin-flota-live.html', 'utf8');

describe('admin live map — dispatch panel', () => {
  it('has the create-dispatch form controls', () => {
    expect(html).toContain('id="dispUnit"');
    expect(html).toContain('id="dispCase"');
    expect(html).toContain('id="dispBtn"');
    expect(html).toContain('id="dispList"');
  });
  it('wires create / list-open / advance-clear against the real endpoints', () => {
    expect(html).toContain("admin/flota/units/'+encodeURIComponent(unit)+'/dispatch"); // POST create
    expect(html).toContain('admin/flota/dispatches?open=1');                            // GET open list
    expect(html).toContain("admin/flota/dispatches/'+encodeURIComponent(id)");          // PATCH advance/clear
    expect(html).toContain("method:'POST'");
    expect(html).toContain("method:'PATCH'");
  });
  it('reloads the map snapshot after a dispatch change (so markers recolor)', () => {
    // createDispatch + patchDispatch both call loadSnapshot()
    expect(html).toMatch(/await loadDispatch\(\); await loadSnapshot\(\);/);
  });
});
