import { describe, it, expect } from 'vitest';
import {
  isMinor, isResolved, isPublicSuppressed, coarsenLocation, scrubMinorText, MINOR_MAX_AGE,
  PERSONAS_MINOR_SQL, PERSONAS_PUBLIC_SUPPRESS_SQL, personsPublicSuppressSql,
} from '../src/lib/minor-protect';

describe('minor-protect: isMinor (mirrors case-score detection)', () => {
  it('age ≤ 17 is a minor', () => {
    expect(isMinor(0)).toBe(true);
    expect(isMinor(8)).toBe(true);
    expect(isMinor(17)).toBe(true);
    expect(isMinor(MINOR_MAX_AGE)).toBe(true);
  });
  it('age ≥ 18 is not a minor', () => {
    expect(isMinor(18)).toBe(false);
    expect(isMinor(40)).toBe(false);
    expect(isMinor(80)).toBe(false);
  });
  it('falls back to the menor incident type when age is unknown', () => {
    expect(isMinor(null, 'menor')).toBe(true);
    expect(isMinor(undefined, 'menor')).toBe(true);
    expect(isMinor(null, 'persona_desaparecida')).toBe(false);
    expect(isMinor(null, null)).toBe(false);
  });
  it('a known adult age overrides a stale menor incident type', () => {
    expect(isMinor(40, 'menor')).toBe(false);
  });
  it('ignores non-finite / negative ages (treats as unknown)', () => {
    expect(isMinor(NaN)).toBe(false);
    expect(isMinor(-3)).toBe(false);
  });
});

describe('minor-protect: isResolved', () => {
  it('found / hospitalized / deceased statuses resolve (persons vocabulary)', () => {
    for (const status of ['found_safe', 'aparecido', 'hospitalizado', 'found_deceased']) {
      expect(isResolved({ status })).toBe(true);
    }
  });
  it('estado vocabulary resolves too', () => {
    for (const estado of ['localizado', 'aparecido', 'hospitalizado', 'fallecido']) {
      expect(isResolved({ estado })).toBe(true);
    }
  });
  it('missing / unknown / sin-contacto do not resolve', () => {
    expect(isResolved({ status: 'missing' })).toBe(false);
    expect(isResolved({ status: 'unknown' })).toBe(false);
    expect(isResolved({ estado: 'sin-contacto' })).toBe(false);
    expect(isResolved({})).toBe(false);
  });
});

describe('minor-protect: isPublicSuppressed', () => {
  it('a still-missing minor stays PUBLIC (the alert must work)', () => {
    expect(isPublicSuppressed({ age: 8, status: 'missing' })).toBe(false);
    expect(isPublicSuppressed({ age: 8, estado: 'sin-contacto' })).toBe(false);
  });
  it('a RESOLVED minor is auto-suppressed', () => {
    expect(isPublicSuppressed({ age: 8, status: 'found_safe' })).toBe(true);
    expect(isPublicSuppressed({ age: 15, estado: 'localizado' })).toBe(true);
    expect(isPublicSuppressed({ age: null, incidentType: 'menor', estado: 'fallecido' })).toBe(true);
  });
  it('a resolved ADULT is NOT suppressed (families still see the resolution)', () => {
    expect(isPublicSuppressed({ age: 40, status: 'found_safe' })).toBe(false);
    expect(isPublicSuppressed({ age: 40, estado: 'localizado' })).toBe(false);
  });
  it('an operator-protected case is suppressed regardless of age/status', () => {
    expect(isPublicSuppressed({ age: 40, status: 'missing', protected: 1 })).toBe(true);
    expect(isPublicSuppressed({ age: 8, status: 'missing', protected: true })).toBe(true);
  });
  it('protected=0 / falsy does not suppress on its own', () => {
    expect(isPublicSuppressed({ age: 30, status: 'missing', protected: 0 })).toBe(false);
  });
});

describe('minor-protect: coarsenLocation', () => {
  it('keeps the coarsest (last) comma segment', () => {
    expect(coarsenLocation('Av. Sucre, Catia, Caracas')).toBe('Caracas');
    expect(coarsenLocation('Calle 5, Sector La Paz, La Guaira')).toBe('La Guaira');
  });
  it('strips house/road numbers from a single-segment value', () => {
    expect(coarsenLocation('Caracas 1010')).toBe('Caracas');
    expect(coarsenLocation('Av Bolivar #5')).toBe('Av Bolivar');
  });
  it('leaves a bare locality intact', () => {
    expect(coarsenLocation('Caracas')).toBe('Caracas');
    expect(coarsenLocation('La Guaira')).toBe('La Guaira');
  });
  it('preserves null / empty (unknown stays unknown)', () => {
    expect(coarsenLocation(null)).toBeNull();
    expect(coarsenLocation(undefined)).toBeNull();
    expect(coarsenLocation('')).toBe('');
  });
  it('never returns an empty string for a present-but-numeric value', () => {
    expect(coarsenLocation('1010')).toBe('Venezuela');
  });
});

describe('minor-protect: scrubMinorText (conservative address scrub)', () => {
  it('redacts a # house number but keeps the surrounding prose', () => {
    expect(scrubMinorText('Vestía camisa azul, vive en Av. Sucre #5'))
      .toBe('Vestía camisa azul, vive en Av. Sucre [reservado]');
  });
  it('redacts Nº / No. house numbers', () => {
    expect(scrubMinorText('Casa Nº 12')).toContain('[reservado]');
    expect(scrubMinorText('local No. 7')).toContain('[reservado]');
    expect(scrubMinorText('Nº 12')).not.toContain('12');
  });
  it('redacts unit keyword + number (apto/piso/torre)', () => {
    expect(scrubMinorText('apto 3B, torre 4')).toBe('[reservado], [reservado]');
    expect(scrubMinorText('piso 2')).toBe('[reservado]');
  });
  it('leaves a pure physical description untouched', () => {
    const d = 'Niña de cabello negro, 1.20 m, vestía franela roja';
    expect(scrubMinorText(d)).toBe(d);
  });
  it('does not redact bare prose containing "no" without a number', () => {
    expect(scrubMinorText('no fue visto desde el lunes')).toBe('no fue visto desde el lunes');
  });
  it('preserves null / empty', () => {
    expect(scrubMinorText(null)).toBeNull();
    expect(scrubMinorText(undefined)).toBeNull();
    expect(scrubMinorText('')).toBe('');
  });
});

describe('minor-protect: SQL fragments stay in lockstep with the predicates', () => {
  it('PERSONAS_MINOR_SQL matches the age bound', () => {
    expect(PERSONAS_MINOR_SQL).toContain(`BETWEEN 0 AND ${MINOR_MAX_AGE}`);
  });
  it('personas suppression covers protected + resolved-minor', () => {
    expect(PERSONAS_PUBLIC_SUPPRESS_SQL).toContain('protected = 1');
    expect(PERSONAS_PUBLIC_SUPPRESS_SQL).toContain("estado IN ('localizado','aparecido','hospitalizado','fallecido')");
  });
  it('persons suppression qualifies by the requested alias', () => {
    const sql = personsPublicSuppressSql('p');
    expect(sql).toContain('p.protected = 1');
    expect(sql).toContain("p.incident_type = 'menor'");
    expect(sql).toContain("p.status IN ('found_safe','aparecido','hospitalizado','found_deceased')");
    expect(personsPublicSuppressSql('persons')).toContain('persons.protected = 1');
  });
});
