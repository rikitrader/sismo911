import { describe, it, expect } from 'vitest';
import { deriveSkills, cleanSkills, normalizeRow, statsFromRows, SKILL_KEYS } from '../src/lib/volunteer-skills';

describe('volunteer skill classifier', () => {
  it('derives tecnologia from an IT/digitization offer', () => {
    expect(deriveSkills('Soy Informático puedo dar soporte, actualizando datos, digitalización')).toContain('tecnologia');
  });
  it('derives medico from a health offer', () => {
    expect(deriveSkills('Soy médico, puedo atender heridos en el hospital')).toContain('medico');
  });
  it('derives transporte when a vehicle is offered', () => {
    expect(deriveSkills('Tengo camión, puedo trasladar víveres')).toContain('transporte');
  });
  it('is accent-insensitive', () => {
    expect(deriveSkills('rescate de escombros')).toContain('rescate');
    expect(deriveSkills('RESCATE DE ESCOMBROS')).toContain('rescate');
  });
  it('falls back to general when nothing matches', () => {
    expect(deriveSkills('hola disponible cuando sea')).toEqual(['general']);
  });
  it('cleanSkills keeps only valid keys, in canonical order', () => {
    expect(cleanSkills(['transporte', 'bogus', 'medico'])).toEqual(['medico', 'transporte']);
    expect(cleanSkills('medico,logistica')).toEqual(['medico', 'logistica']);
  });
});

describe('normalizeRow + statsFromRows', () => {
  const rows = [
    normalizeRow({ source: 'rav', id: 'a', full_name: 'A', notes: 'soy enfermera' }),
    normalizeRow({ source: 'rav', id: 'b', full_name: 'B', notes: 'tengo camion para transporte' }),
    normalizeRow({ source: 'registered', id: 'vol_1', full_name: 'C', skills: ['rescate', 'logistica'] }),
  ];
  it('attaches derived tags to RAV rows and keeps explicit registered skills', () => {
    expect(rows[0].skills).toContain('medico');
    expect(rows[1].skills).toContain('transporte');
    expect(rows[2].skills).toEqual(['rescate', 'logistica']);
  });
  it('computes exact group totals over the full set', () => {
    const s = statsFromRows(rows);
    expect(s.total).toBe(3);
    expect(s.groups.medico).toBe(1);   // enfermera
    expect(s.groups.rescate).toBe(1);  // registered rescate
    expect(s.groups.logistica).toBe(2); // camion(transporte) + registered logistica
    expect(s.counts.transporte).toBe(1);
  });
});

describe('taxonomy guard', () => {
  it('SKILL_KEYS has no duplicates and ends with general', () => {
    expect(new Set(SKILL_KEYS).size).toBe(SKILL_KEYS.length);
    expect(SKILL_KEYS[SKILL_KEYS.length - 1]).toBe('general');
  });

  it('client display map (voluntarios-skills.js) keys match SKILL_KEYS exactly', () => {
    const fs = require('fs');
    const js = fs.readFileSync(new URL('../public/voluntarios-skills.js', import.meta.url), 'utf8');
    // Extract the SK object literal keys.
    const block = js.slice(js.indexOf('var SK = {') + 9, js.indexOf('};', js.indexOf('var SK = {')));
    const keys = [...block.matchAll(/^\s*([a-z_]+):\s*\[/gm)].map((m) => m[1]);
    expect(keys).toEqual([...SKILL_KEYS]);
  });
});
