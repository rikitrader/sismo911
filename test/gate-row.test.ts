import { describe, it, expect } from 'vitest';
import { gateRow } from '../src/security/ingestion-gate';
import { z, nameField, textField, boundedInt } from '../src/security/validators';

// Mirror of the schema the rav/familia crons will use per mapped persona row.
const PersonaRow = z.object({
  nombre: nameField(200),
  edad: boundedInt(0, 130).nullish(),
  ubicacion: textField(300).optional(),
  descripcion: textField(4000).optional(),
});

const cfg = {
  schema: PersonaRow,
  allowedFields: ['nombre', 'edad', 'ubicacion', 'descripcion'] as const,
  nameFields: ['nombre'] as const,
  textFields: ['ubicacion', 'descripcion'] as const,
};

describe('gateRow — legitimate disaster rows PASS', () => {
  it('a cédula-bearing name passes', () => {
    const r = gateRow({ nombre: 'Zoralda Martinez CI 6092167', ubicacion: 'Hospital Perez Carreño' }, cfg);
    expect(r.ok).toBe(true);
  });
  it('a description with an X source link passes', () => {
    const r = gateRow(
      { nombre: 'Ana Pérez', descripcion: 'Post en X https://x.com/abogadosvenezu1/status/2070144445811470426' },
      cfg,
    );
    expect(r.ok).toBe(true);
  });
  it('drops unknown scrape columns instead of rejecting', () => {
    const r = gateRow({ nombre: 'Carlos Torres', __source_internal: 'x', raw_blob: { a: 1 } }, cfg);
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as any).__source_internal).toBeUndefined();
  });
});

describe('gateRow — abuse rows REJECT', () => {
  it('rejects link-spam name', () => {
    const r = gateRow({ nombre: 'TRUSTEDF57 - infinityhotel.it' }, cfg);
    expect(r.ok).toBe(false);
  });
  it('rejects stored-XSS markup name', () => {
    const r = gateRow({ nombre: '"><svg/onload=("@jofpin");>' }, cfg);
    expect(r.ok).toBe(false);
  });
  it('rejects the SIMONE BURATTI flood phrase in description', () => {
    const r = gateRow({ nombre: 'Juan', descripcion: 'simone buratti gay' }, cfg);
    expect(r.ok).toBe(false);
  });
  it('rejects an empty/no-letter name via schema', () => {
    const r = gateRow({ nombre: '....' }, cfg);
    expect(r.ok).toBe(false);
  });
  it('does NOT penalize trusted cron rows for missing user-agent', () => {
    // A plain clean row should score 0 (the "cron" UA placeholder avoids the
    // missing-UA penalty that would otherwise fire on every ingested row).
    const r = gateRow({ nombre: 'María González', ubicacion: 'Catia la Mar' }, cfg);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.score).toBe(0);
  });
});
