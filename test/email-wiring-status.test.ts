import { describe, it, expect } from 'vitest';
import { CATALOG } from '../src/lib/email-samples';
import { WIRING_STATUS, wiringTally } from '../src/lib/email-wiring-status';

// Anti-hallucination meter for the transactional-email program. The registry
// must stay 1:1 with the 77-email CATALOG, and each entry must justify itself
// (wired → names a handler; deferred → gives a reason). "100% wired" = 0 deferred.
describe('email wiring status — 77-email coverage ledger', () => {
  it('registry is 1:1 with the catalog (no missing, no extra IDs)', () => {
    const catalogIds = new Set(CATALOG.map((s) => s.id));
    const statusIds = new Set(Object.keys(WIRING_STATUS));
    const missing = [...catalogIds].filter((id) => !statusIds.has(id));
    const extra = [...statusIds].filter((id) => !catalogIds.has(id));
    expect(missing, `catalog IDs missing from WIRING_STATUS:\n  ${missing.join('\n  ')}`).toEqual([]);
    expect(extra, `WIRING_STATUS IDs not in catalog:\n  ${extra.join('\n  ')}`).toEqual([]);
    expect(statusIds.size).toBe(77);
  });

  it('every entry justifies itself (wired→where, else→reason)', () => {
    for (const [id, e] of Object.entries(WIRING_STATUS)) {
      if (e.status === 'wired') expect((e as any).where, `${id} wired but no where`).toBeTruthy();
      else expect((e as any).reason, `${id} ${e.status} but no reason`).toBeTruthy();
    }
  });

  it('GOAL GATE — zero `deferred` (every email is wired, product_deferred, or n/a)', () => {
    const t = wiringTally();
    expect(t.total).toBe(77);
    expect(t.wired + t.deferred + t.productDeferred + t.notApplicable).toBe(77);
    // The email SYSTEM is complete when nothing remains in the buildable-now
    // `deferred` bucket. Any new/regressed deferred entry fails this gate.
    expect(t.deferred, 'emails still in the buildable `deferred` bucket — wire or reclassify them').toBe(0);
    // eslint-disable-next-line no-console
    console.log(`[email-wiring] WIRED ${t.wired}/77 · product_deferred ${t.productDeferred} · n/a ${t.notApplicable} · deferred ${t.deferred}`);
  });
});
