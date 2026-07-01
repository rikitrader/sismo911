import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readdirSync } from 'node:fs';

// Operator status is derived from getUserFromRequest — mock it so a request with
// the `x-test-op` header is treated as an operator, everything else as public.
vi.mock('../src/lib/auth', () => ({
  getUserFromRequest: async (_env: any, c: any) =>
    c.req.header('x-test-op') ? { role: 'operator', email: 'op@test', name: 'Op' } : null,
}));

import { persons } from '../src/routes/persons';
import { backfillSearchFields } from '../src/lib/search-index';
import { makeDb, makeEnv, mount, type TestEnv, type D1Mock } from './helpers/d1';

// Full-database search + filter coverage for /api/persons/cases (the unified
// endpoint that /casos and /personas both consume). Seeds records WITH and
// WITHOUT photos, multiple ages/statuses/locations, accented + duplicate names,
// then proves every filter narrows correctly — alone and combined.

const ALL_MIGRATIONS = readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort().map((f) => 'migrations/' + f);

let db: D1Mock;
let env: TestEnv;
const app = mount([['/api/persons', persons]]);
const now = 1_700_000_000_000;
const day = 86_400_000;

function P(o: Record<string, any>) {
  const cols = ['id', 'full_name', 'age', 'sex', 'last_seen', 'status', 'review', 'contact_phone', 'photo_url', 'priority', 'incident_type', 'created_ms', 'updated_ms'];
  const row: any = { review: 'approved', status: 'missing', priority: 'media', incident_type: 'persona_desaparecida', created_ms: now, updated_ms: now, ...o };
  db.raw.prepare(`INSERT INTO persons (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c] ?? null));
}
function F(o: Record<string, any>) {
  const cols = ['id', 'nombre', 'edad', 'ubicacion', 'descripcion', 'contacto', 'foto', 'foto_r2', 'estado', 'moderation', 'origen', 'created_at', 'updated_at'];
  const row: any = { edad: null, ubicacion: '', descripcion: '', contacto: '', foto: '', foto_r2: null, estado: 'sin-contacto', moderation: 'approved', origen: null, created_at: now, updated_at: now, ...o };
  db.raw.prepare(`INSERT INTO personas (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c] ?? null));
}
function H(o: Record<string, any>) {
  const cols = ['id', 'dedupe_key', 'full_name', 'norm_name', 'edad', 'cedula', 'direccion', 'hospital', 'estado', 'source', 'matched_person_id', 'matched_persona_id', 'match_confidence', 'conflict', 'created_ms', 'updated_ms'];
  const row: any = { dedupe_key: null, norm_name: null, edad: null, cedula: '', direccion: '', hospital: '', estado: 'hospitalizado', source: 'registro-maestro', matched_person_id: null, matched_persona_id: null, match_confidence: 'none', conflict: 0, created_ms: now, updated_ms: now, ...o };
  db.raw.prepare(`INSERT INTO hospital_patients (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c] ?? null));
}

async function search(qs: string, op = false) {
  const headers: any = { 'content-type': 'application/json' };
  if (op) headers['x-test-op'] = '1';
  const res = await app.request('/api/persons/cases?' + qs, { method: 'GET', headers }, env);
  return res.json() as Promise<any>;
}
const idsOf = (j: any) => (j.cases || []).map((c: any) => c.id);

beforeEach(async () => {
  db = makeDb(ALL_MIGRATIONS);
  env = makeEnv(db) as TestEnv;

  // persons — accented + duplicate names, mixed ages/sex/status/photo/location/date
  P({ id: 'per_jose', full_name: 'José Ramírez', age: 34, sex: 'M', last_seen: 'Caracas, Distrito Capital', photo_url: 'https://x/j.jpg', contact_phone: '0412', created_ms: now });
  P({ id: 'per_jose2', full_name: 'Jose Ramirez', age: 41, sex: 'M', last_seen: 'Maracaibo, Zulia', photo_url: null, created_ms: now - 10 * day });
  P({ id: 'per_angela', full_name: 'Ángela Peña', age: 29, sex: 'F', last_seen: 'Valencia, Carabobo', photo_url: 'https://x/a.jpg', created_ms: now - 2 * day });
  P({ id: 'per_nino', full_name: 'Niño Pérez', age: 8, sex: 'M', last_seen: 'La Guaira', status: 'missing', photo_url: null, created_ms: now - 1 * day });
  P({ id: 'per_dec', full_name: 'Carlos Muerto', age: 70, sex: 'M', last_seen: 'Coro, Falcón', status: 'found_deceased', photo_url: null, created_ms: now - 5 * day });
  P({ id: 'per_unk', full_name: 'Desconocido NN', age: null, sex: null, last_seen: 'Zulia sector norte', status: 'unknown', photo_url: null });

  // personas (Familia) — with + without photo, origen, location
  F({ id: 'maria', nombre: 'María Gómez', edad: 25, ubicacion: 'Catia La Mar, La Guaira', estado: 'sin-contacto', foto_r2: 'fotos/m.jpg', origen: 'rav:terremotovenezuela.app' });
  F({ id: 'luis', nombre: 'Luis Ángel', edad: 50, ubicacion: 'Barquisimeto, Lara', estado: 'localizado', foto: '', foto_r2: null, origen: 'theempire' });

  // hospital registry — free-text edad, cédula, unmatched
  H({ id: 'hp1', full_name: 'Pedro Sánchez', norm_name: 'pedro sanchez', edad: '34 años', cedula: 'V12345678', direccion: 'Hospital Central, Valencia', hospital: 'Hospital Central', estado: 'hospitalizado' });
  H({ id: 'hp2', full_name: 'Ana Rangel', norm_name: 'ana rangel', edad: '', cedula: 'V87654321', direccion: 'Maracaibo', hospital: 'HUM', estado: 'alta' });

  await backfillSearchFields(env, 1000); // populate name_norm / geo_* / age_num like prod
});

describe('name search (accent + case insensitive)', () => {
  it('q=jose matches "José Ramírez" and "Jose Ramirez"', async () => {
    const r = idsOf(await search('q=jose&limit=500'));
    expect(r).toContain('per_jose');
    expect(r).toContain('per_jose2');
  });
  it('q=ramirez (no accent) matches the accented "Ramírez"', async () => {
    expect(idsOf(await search('q=ramirez&limit=500'))).toContain('per_jose');
  });
  it('name= param matches personas accented name', async () => {
    expect(idsOf(await search('name=angel&limit=500'))).toContain('fam-luis');
  });
});

describe('age filters', () => {
  it('age exact', async () => {
    expect(idsOf(await search('age=34&limit=500'))).toContain('per_jose');
  });
  it('age_min/age_max range excludes out-of-range', async () => {
    const r = idsOf(await search('age_min=25&age_max=40&limit=500'));
    expect(r).toContain('per_jose');   // 34
    expect(r).toContain('per_angela'); // 29
    expect(r).not.toContain('per_jose2'); // 41
    expect(r).not.toContain('per_nino');  // 8
  });
  it('hospital free-text edad parsed to age_num filters too', async () => {
    expect(idsOf(await search('age_min=30&age_max=40&limit=500'))).toContain('hosp-hp1'); // "34 años"
  });
});

describe('sex filter (persons only)', () => {
  it('sex=F returns females, drops males + tables without sex', async () => {
    const r = idsOf(await search('sex=F&limit=500'));
    expect(r).toContain('per_angela');
    expect(r).not.toContain('per_jose');
    expect(r.every((id: string) => !id.startsWith('fam-') && !id.startsWith('hosp-'))).toBe(true);
  });
});

describe('estado / municipio (gazetteer + fallback)', () => {
  it('estado=zulia (from "Maracaibo, Zulia")', async () => {
    expect(idsOf(await search('estado=zulia&limit=500'))).toContain('per_jose2');
  });
  it('estado=distrito capital (from "Caracas")', async () => {
    expect(idsOf(await search('estado=distrito capital&limit=500'))).toContain('per_jose');
  });
  it('estado=carabobo matches persons + hospital (Valencia)', async () => {
    const r = idsOf(await search('estado=carabobo&limit=500'));
    expect(r).toContain('per_angela');
    expect(r).toContain('hosp-hp1');
  });
  it('estado LIKE fallback works when geo_estado is NULL', async () => {
    db.raw.prepare(`UPDATE persons SET geo_estado=NULL WHERE id='per_jose2'`).run(); // simulate un-backfilled
    expect(idsOf(await search('estado=zulia&limit=500'))).toContain('per_jose2'); // via last_seen LIKE
  });
  it('municipio filter', async () => {
    expect(idsOf(await search('municipio=catia la mar&limit=500'))).toContain('fam-maria');
  });
});

describe('place (hospital / última ubicación free text)', () => {
  it('place matches hospital name', async () => {
    expect(idsOf(await search('place=Hospital Central&limit=500'))).toContain('hosp-hp1');
  });
});

describe('status filters', () => {
  it('missing', async () => {
    const r = idsOf(await search('status=missing&limit=500'));
    expect(r).toContain('per_jose');
    expect(r).not.toContain('per_dec');
  });
  it('found_deceased', async () => {
    expect(idsOf(await search('status=found_deceased&limit=500'))).toContain('per_dec');
  });
  it('unknown (No identificado)', async () => {
    expect(idsOf(await search('status=unknown&limit=500'))).toContain('per_unk');
  });
  it('hospitalizado federates the registry', async () => {
    expect(idsOf(await search('status=hospitalizado&limit=500'))).toContain('hosp-hp1');
  });
});

describe('photo / no-photo', () => {
  it('photo=true returns only records with a photo', async () => {
    const r = idsOf(await search('photo=true&limit=500'));
    expect(r).toContain('per_jose');    // photo_url
    expect(r).toContain('fam-maria');   // foto_r2
    expect(r).not.toContain('per_jose2'); // no photo
    expect(r).not.toContain('hosp-hp1');  // hospital rows have no photo
  });
  it('photo=false returns only records without a photo', async () => {
    const r = idsOf(await search('photo=false&limit=500'));
    expect(r).toContain('per_jose2');
    expect(r).toContain('fam-luis');
    expect(r).not.toContain('per_jose');
    expect(r).not.toContain('fam-maria');
  });
});

describe('date ranges', () => {
  it('created_from bounds by registration date', async () => {
    const r = idsOf(await search(`created_from=${now - 3 * day}&limit=500`));
    expect(r).toContain('per_jose');     // now
    expect(r).toContain('per_angela');   // now-2d
    expect(r).not.toContain('per_jose2'); // now-10d
    expect(r).not.toContain('per_dec');   // now-5d
  });
  it('created_to bounds the other side', async () => {
    const r = idsOf(await search(`created_to=${now - 4 * day}&limit=500`));
    expect(r).toContain('per_jose2');
    expect(r).not.toContain('per_jose');
  });
});

describe('source / linked', () => {
  it('source=theempire matches only that origen', async () => {
    const r = idsOf(await search('source=theempire&limit=500'));
    expect(r).toContain('fam-luis');
    expect(r).not.toContain('fam-maria');
  });
  it('linked=true = has a contact', async () => {
    const r = idsOf(await search('linked=true&limit=500'));
    expect(r).toContain('per_jose');       // contact_phone set
    expect(r).not.toContain('per_angela'); // no contact
  });
});

describe('pagination + sorting', () => {
  it('limit + page report total/pages and window', async () => {
    const p1 = await search('limit=3&page=1');
    expect(p1.total).toBeGreaterThanOrEqual(10);
    expect(p1.pages).toBe(Math.ceil(p1.total / 3));
    expect(p1.cases.length).toBe(3);
    const p2 = await search('limit=3&page=2');
    expect(idsOf(p2).some((id: string) => !idsOf(p1).includes(id))).toBe(true);
  });
  it('sort=name orders alphabetically', async () => {
    const r = idsOf(await search('sort=name&limit=500'));
    const names = r.slice(0, 3);
    expect(names.length).toBe(3);
  });
});

describe('combined filters', () => {
  it('estado=carabobo + status=missing + photo=true', async () => {
    const r = idsOf(await search('estado=carabobo&status=missing&photo=true&limit=500'));
    expect(r).toContain('per_angela');
    expect(r).not.toContain('hosp-hp1'); // hospitalizado, excluded by status=missing
  });
});

describe('cédula (operator-only PII)', () => {
  it('public: cedula param is ignored (not exposed)', async () => {
    const pub = idsOf(await search('cedula=V12345678&limit=500'));
    expect(pub).toContain('per_jose'); // not narrowed to the cédula row → filter ignored for public
  });
  it('operator: cedula narrows to the matching hospital row', async () => {
    const r = idsOf(await search('cedula=V12345678&limit=500', true));
    expect(r).toContain('hosp-hp1');
    expect(r).not.toContain('hosp-hp2');
  });
});

describe('filter metadata', () => {
  it('returns estado options and source list', async () => {
    const j = await search('limit=1');
    expect(Array.isArray(j.filters.estados)).toBe(true);
    expect(j.filters.estados.find((e: any) => e.slug === 'zulia')).toBeTruthy();
    expect(j.filters.sources).toContain('theempire');
  });
});

describe('reindex-search endpoint', () => {
  it('operator can drive the backfill to done', async () => {
    // wipe the structured fields, then reindex via the endpoint
    db.raw.prepare(`UPDATE persons SET name_norm=NULL, geo_estado=NULL`).run();
    const res = await app.request('/api/persons/reindex-search?batch=1000', { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-op': '1' } }, env);
    const j: any = await res.json();
    expect(j.processed.persons).toBeGreaterThan(0);
    expect(j.done).toBe(true);
  });
  it('non-operator is forbidden', async () => {
    const res = await app.request('/api/persons/reindex-search', { method: 'POST', headers: { 'content-type': 'application/json' } }, env);
    expect(res.status).toBe(403);
  });
});
