import { describe, it, expect } from 'vitest';
import {
  mmiToHaz, vulnFactor, band, scoreCurated, scoreOsm, PRIOR_BLEND, damageRatio, computeCost,
  type Sector, type Curated, type Osm,
} from '../src/lib/building-score';

// Building damage-scoring engine invariants (CROSS-CHECK GATE): scores bounded
// [0,100], reported-collapse rows score DIRECT (observed, not modeled), modeled
// scores blend physics with the satellite prior, and the confianza→tier mapping
// stays aligned with /api/casualties.

const coast: Sector = {
  parish: 'Caraballeda', city: 'La Guaira', state: 'La Guaira', lat: 10.612, lon: -66.855,
  soil: 1.45, mmi: 8.7, soilNote: 'aluvial', prior: 0.55,
};
const firm: Sector = {
  parish: 'Baruta', city: 'Caracas', state: 'Miranda', lat: 10.43, lon: -66.87,
  soil: 1.15, mmi: 7.0, soilNote: 'roca', prior: 0.12,
};

describe('hazard + vulnerability primitives', () => {
  it('mmiToHaz is monotonic and bounded', () => {
    expect(mmiToHaz(8)).toBeCloseTo(0.6);
    expect(mmiToHaz(9)).toBeCloseTo(0.85);
    expect(mmiToHaz(8.5)).toBeGreaterThan(mmiToHaz(8));
    expect(mmiToHaz(8.5)).toBeLessThan(mmiToHaz(9));
  });
  it('vulnFactor clamps to [0.6,1.7] and Misión Vivienda raises risk', () => {
    expect(vulnFactor({ mision: 1, soft_story: 1, pre_code: 1, midrise: 1 })).toBeLessThanOrEqual(1.7);
    expect(vulnFactor({ lowrise: 1 })).toBeGreaterThanOrEqual(0.6);
    expect(vulnFactor({ mision: 1 })).toBeGreaterThan(vulnFactor({}));
  });
  it('band thresholds', () => {
    expect(band(95)).toBe('CRITICO'); expect(band(70)).toBe('ALTO');
    expect(band(50)).toBe('MODERADO'); expect(band(30)).toBe('BAJO'); expect(band(5)).toBe('MINIMO');
  });
});

describe('scoreCurated', () => {
  const reported: Curated = {
    name: 'Edificio OPP 25', use: 'RESIDENCIAL', sector: 'Tanaguarena', status: 'COLAPSO_TOTAL',
    cas: 'rescate 106h', conf: 'HIGH', notes: '', src: 'El Nacional', vuln: { midrise: 1, soft_story: 1 },
  };
  const unknown: Curated = {
    name: 'Residencias X', use: 'RESIDENCIAL', sector: 'Tanaguarena', status: 'DESCONOCIDO',
    cas: '', conf: 'MEDIUM', notes: '', src: 'OSM', vuln: { midrise: 1 },
  };

  it('reported collapse → DIRECT, observed score, bounded', () => {
    const r = scoreCurated(reported, coast);
    expect(r.dq.startsWith('DIRECT')).toBe(true);
    expect(r.score).toBe(98);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.tier).toBe(1); expect(r.confNum).toBeCloseTo(0.85); // HIGH → T1
  });

  it('unknown status → MODELED, blends physics with prior, in [0,100]', () => {
    const r = scoreCurated(unknown, coast);
    expect(r.dq.startsWith('MODELED')).toBe(true);
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(100);
    expect(r.tier).toBe(2); // MEDIUM → T2
  });

  it('same building scores higher on soft coastal soil than firm rock', () => {
    const a = scoreCurated(unknown, coast).score;
    const b = scoreCurated({ ...unknown, sector: 'Baruta' }, firm).score;
    expect(a).toBeGreaterThan(b);
  });

  it('prior blend actually moves the modeled score', () => {
    const hiPrior = scoreCurated(unknown, { ...coast, prior: 0.9 }).score;
    const loPrior = scoreCurated(unknown, { ...coast, prior: 0.0 }).score;
    expect(hiPrior).toBeGreaterThan(loPrior);
    expect(PRIOR_BLEND).toBeGreaterThan(0);
  });
});

describe('scoreOsm', () => {
  const o: Osm = {
    name: 'Edificio Nobel', type: 'apartments', addr: '1ª Transversal de Los Palos Grandes',
    sector: 'Los Palos Grandes', lat: 10.498, lon: -66.843,
  };
  it('no DPM → MODELED+LOW_DATA, tier 3, bounded, keeps address', () => {
    const r = scoreOsm(o, { ...coast, parish: 'Chacao', prior: 0.28 });
    expect(r.dq).toContain('MODELED');
    expect(r.tier).toBe(3);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.addr).toBe('1ª Transversal de Los Palos Grandes');
    expect(r.status).toBe('DESCONOCIDO');
    expect(r.dpmProb).toBeUndefined();
  });

  it('observed NASA DPM → OBSERVED-DPM, tier 2, raises score above modeled, bounded', () => {
    const sec = { ...coast, parish: 'Chacao', prior: 0.28 };
    const modeled = scoreOsm(o, sec).score;
    const obs = scoreOsm(o, sec, 0.99);
    expect(obs.dq).toBe('OBSERVED-DPM');
    expect(obs.tier).toBe(2);
    expect(obs.confNum).toBeCloseTo(0.85);
    expect(obs.dpmProb).toBe(0.99);
    expect(obs.status).toBe('DPM_DANADO');
    expect(obs.score).toBeGreaterThan(modeled); // observation lifts hazard
    expect(obs.score).toBeLessThanOrEqual(100);
    expect(obs.source).toContain('NASA');
  });

  it('DPM below the MMI hazard never lowers the score (max of the two)', () => {
    const sec = { ...coast, parish: 'Chacao', prior: 0.28 };
    const modeled = scoreOsm(o, sec).score;
    expect(scoreOsm(o, sec, 0.01).score).toBeGreaterThanOrEqual(modeled);
  });
});

describe('cost model (replacement + repair)', () => {
  it('damageRatio follows HAZUS: collapse=1.0, extensive=0.5, moderate band=0.1', () => {
    expect(damageRatio('COLAPSO_TOTAL', 'CRITICO')).toBe(1.0);
    expect(damageRatio('CONDENADO', 'ALTO')).toBe(0.5);
    expect(damageRatio('', 'MODERADO')).toBe(0.1);
    expect(damageRatio('DPM_DANADO', 'CRITICO')).toBe(0.4);
  });

  it('computeCost ties out: floor×unit = replacement; repair = replacement×ratio', () => {
    const c = computeCost('RESIDENCIAL', 'La Guaira', 'COLAPSO_TOTAL', 'CRITICO',
      { area: 500, levels: 8, area_src: 'OSM', lev_src: 'OSM' })!;
    expect(c.floorM2).toBe(4000);          // 500 × 8
    expect(c.unitUsdM2).toBe(700);         // La Guaira base, RESIDENCIAL ×1.0
    expect(c.replacementUsd).toBe(2_800_000); // 4000 × 700
    expect(c.repairUsd).toBe(2_800_000);   // ratio 1.0 for collapse
    expect(c.costConf).toBe('HIGH');       // area + levels both real
  });

  it('use multiplier + state cost apply; estimated inputs → lower costConf', () => {
    const hosp = computeCost('SALUD', 'Distrito Capital', '', 'MODERADO',
      { area: 1000, levels: 4, area_src: 'EST', lev_src: 'OSM' })!;
    expect(hosp.unitUsdM2).toBe(1500);     // 1000 × 1.5 (SALUD)
    expect(hosp.repairUsd).toBe(Math.round(1000 * 4 * 1500 * 0.1));
    expect(hosp.costConf).toBe('MEDIUM');  // one real, one estimated
  });

  it('infrastructure has no per-m² cost', () => {
    expect(computeCost('INFRAESTRUCTURA', 'La Guaira', 'COLAPSO_TOTAL', 'CRITICO', { area: 10, levels: 1, area_src: 'NA', lev_src: 'NA' })).toBeUndefined();
  });

  it('scoreOsm attaches a bounded cost with repair ≤ replacement', () => {
    const r = scoreOsm({
      name: 'X', type: 'apartments', addr: 'a', sector: 'Los Corales', lat: 10.61, lon: -66.85,
      use: 'RESIDENCIAL', area: 600, levels: 10, area_src: 'OSM', lev_src: 'OSM',
    }, { ...coast, prior: 0.55 }, 0.99);
    expect(r.cost).toBeDefined();
    expect(r.cost!.repairUsd).toBeLessThanOrEqual(r.cost!.replacementUsd);
    expect(r.cost!.replacementUsd).toBeGreaterThan(0);
  });
});
