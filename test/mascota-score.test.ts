import { describe, it, expect } from 'vitest';
import { scoreMascota, type MascotaSignals } from '../src/lib/mascota-score';

// Fixed clock so every time-based rule is deterministic.
const NOW = 1_750_000_000_000;
const h = (n: number) => n * 3_600_000;
const d = (n: number) => n * 86_400_000;
const base = (over: Partial<MascotaSignals> = {}): MascotaSignals => ({ status: 'perdida', now: NOW, ...over });

describe('mascota-score: status overrides', () => {
  it('reunida → REUNIDA / baja, low score', () => {
    const s = scoreMascota(base({ status: 'reunida' }));
    expect(s.bucket).toBe('reunida');
    expect(s.priority).toBe('baja');
    expect(s.label).toBe('REUNIDA');
    expect(s.score).toBeLessThanOrEqual(10);
  });

  it('fallecida → CERRADO / baja', () => {
    const s = scoreMascota(base({ status: 'fallecida' }));
    expect(s.bucket).toBe('cerrado');
    expect(s.label).toBe('CERRADO');
  });
});

describe('mascota-score: active cases', () => {
  it('fresh lost pet (<72h, no lead yet) → SEGUIMIENTO / media', () => {
    const s = scoreMascota(base({ status: 'perdida', createdMs: NOW - h(5) }));
    expect(s.priority).toBe('media');
    expect(s.bucket).toBe('seguimiento');
    expect(s.reasons.join(' ')).toMatch(/72 h/);
  });

  it('a fresh lost pet WITH a recent lead escalates → ACTIVA / alta', () => {
    const s = scoreMascota(base({ status: 'perdida', createdMs: NOW - h(5), lastSightingMs: NOW - h(2) }));
    expect(s.priority).toBe('alta');
    expect(s.bucket).toBe('activa');
  });

  it('a recent sighting (avistada + activity <48h) is hot', () => {
    const s = scoreMascota(base({ status: 'avistada', createdMs: NOW - d(2), lastSightingMs: NOW - h(3) }));
    expect(s.score).toBeGreaterThanOrEqual(65);
    expect(s.priority).toBe('alta');
  });

  it('cold case (>30d, no movements) decays to EN PAUSA / baja', () => {
    const s = scoreMascota(base({ status: 'perdida', createdMs: NOW - d(45), movimientos: 0 }));
    expect(s.bucket).toBe('pausa');
    expect(s.priority).toBe('baja');
    expect(s.reasons.join(' ')).toMatch(/frío/i);
  });

  it('encontrada (found, seeking owner) is active but lower base than lost', () => {
    const found = scoreMascota(base({ status: 'encontrada', createdMs: NOW - d(10) }));
    const lost = scoreMascota(base({ status: 'perdida', createdMs: NOW - d(10) }));
    expect(found.score).toBeLessThan(lost.score);
  });

  it('score is always clamped 0–100', () => {
    const s = scoreMascota(base({ status: 'avistada', createdMs: NOW - h(1), lastSightingMs: NOW - h(1) }));
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.score).toBeLessThanOrEqual(100);
  });
});
