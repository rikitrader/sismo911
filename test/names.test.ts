import { describe, it, expect } from 'vitest';
import { titleCaseName } from '../src/lib/names';

describe('titleCaseName — ingested display names → Title Case', () => {
  it('ALL-CAPS → Title Case', () => {
    expect(titleCaseName('ABELLO MATILDE')).toBe('Abello Matilde');
    expect(titleCaseName('ACOSTA AZUALDE ISAEL ALEJANDRO')).toBe('Acosta Azualde Isael Alejandro');
  });
  it('keeps Spanish particles lowercase mid-name, but not leading', () => {
    expect(titleCaseName('MARIA DE LA CRUZ')).toBe('Maria de la Cruz');
    expect(titleCaseName('JOSE DEL VALLE')).toBe('Jose del Valle');
    expect(titleCaseName('DE LEON JOSE')).toBe('De Leon Jose'); // leading particle capitalized
  });
  it('handles hyphenated names and accents', () => {
    expect(titleCaseName('JEAN-PAUL')).toBe('Jean-Paul');
    expect(titleCaseName('ÁNGEL MARÍA')).toBe('Ángel María');
  });
  it('normalizes whitespace and tolerates empty', () => {
    expect(titleCaseName('  PEDRO   PEREZ ')).toBe('Pedro Perez');
    expect(titleCaseName('')).toBe('');
    expect(titleCaseName(null)).toBe('');
    expect(titleCaseName(undefined)).toBe('');
  });
});
