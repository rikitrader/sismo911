// Redaction tests — the last line of defense against leaking PII to a chat.
import { describe, it, expect } from 'vitest';
import { toPublicView } from '../src/telegram/redaction';
import { redactSensitiveFields } from '../src/adapters/sismo911-api';
import type { CaseRecord } from '../src/telegram/types';

function record(over: Partial<CaseRecord> = {}): CaseRecord {
  return {
    registry: 'hospital',
    internalId: 'hp_1',
    caseId: 'HOSP-hp_1',
    fullName: 'Jose Garcia',
    age: 50,
    isMinor: false,
    protectedFlag: false,
    internalStatus: 'hospitalizado',
    publicStatus: 'HOSPITALIZED',
    verification: 'VERIFIED',
    generalLocation: 'Av. Libertador, Edif 5, Caracas, Distrito Capital',
    lastVerifiedMs: Date.parse('2026-06-30T14:20:00Z'),
    matchStrength: 'name',
    sensitive: {
      cedula: '12345678',
      phone: '+584141234567',
      address: 'Av. Libertador, Edif 5',
      hospital: 'Hospital Vargas',
      medicalNotes: 'fractura expuesta',
      familyContact: 'tia Maria 04140000000',
    },
    ...over,
  };
}

describe('toPublicView — public viewer', () => {
  const view = toPublicView(record(), 'public', false);
  it('exposes only the allowed public fields', () => {
    expect(view.caseId).toBe('HOSP-hp_1');
    expect(view.status).toBe('HOSPITALIZED');
    expect(view.verification).toBe('VERIFIED');
    expect(view.privileged).toBeUndefined();
  });
  it('coarsens the location to locality (drops street/building detail)', () => {
    expect(view.generalLocation).toBe('Distrito Capital');
    expect(view.generalLocation).not.toMatch(/Libertador|Edif/i);
  });
  it('serialized view never contains any sensitive value', () => {
    const blob = JSON.stringify(view);
    // The facility name is deliberately public-tier for OFFICIAL hospital-registry
    // rows only — sismo911.com/hospitales already publishes patient+hospital.
    for (const leak of ['12345678', '584141234567', 'Edif 5', 'fractura', 'tia Maria']) {
      expect(blob).not.toContain(leak);
    }
  });
  it('facility is public for the hospital registry only', () => {
    expect(view.facility).toBe('Hospital Vargas');
    const persona = toPublicView(
      record({ registry: 'personas', caseId: 'FAM-p1' }),
      'public',
      false,
    );
    expect(persona.facility).toBeNull(); // hospital stays operator-only elsewhere
    expect(JSON.stringify(persona)).not.toContain('Vargas');
  });
});

describe('toPublicView — profile link', () => {
  it('hospital/native cases link to /casos#caso=<caseId>', () => {
    const v = toPublicView(record({ registry: 'hospital', caseId: 'HOSP-hp_1' }), 'public', false);
    expect(v.profileUrl).toBe('https://sismo911.com/casos#caso=HOSP-hp_1');
  });
  it('Familia (personas) cases link to /familia?persona=<id>', () => {
    const v = toPublicView(record({ registry: 'personas', internalId: '555', caseId: 'FAM-555' }), 'public', false);
    expect(v.profileUrl).toBe('https://sismo911.com/familia?persona=555');
  });
  it('honors a custom base url', () => {
    const v = toPublicView(record(), 'public', false, 'https://sismo911.com/');
    expect(v.profileUrl).toBe('https://sismo911.com/casos#caso=HOSP-hp_1');
  });
});

describe('toPublicView — privileged viewer (DM admin)', () => {
  const view = toPublicView(record(), 'admin', true);
  it('includes the restricted detail block', () => {
    expect(view.privileged?.fullName).toBe('Jose Garcia');
    expect(view.privileged?.cedula).toBe('12345678');
    expect(view.privileged?.hospital).toBe('Hospital Vargas');
  });
});

describe('redactSensitiveFields', () => {
  it('empties the sensitive bag for a public viewer', () => {
    const r = redactSensitiveFields(record(), false);
    expect(r.sensitive).toEqual({});
  });
  it('keeps the sensitive bag for an authorized viewer', () => {
    const r = redactSensitiveFields(record(), true);
    expect(r.sensitive.cedula).toBe('12345678');
  });
});
