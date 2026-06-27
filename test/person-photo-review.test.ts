import { describe, expect, it } from 'vitest';
import { persons } from '../src/routes/persons';

function makeDB() {
  const groups = [{ photo_phash: 'hash-a', n: 2, missing: 1, found: 1 }];
  const rows = [
    { id: 'p_found', nombre: 'Persona Hallada', edad: 31, ubicacion: 'Caracas', estado: 'localizado', foto_r2: 'personas/p_found.jpg', photo_caption: 'rostro visible', updated_at: 2 },
    { id: 'p_missing', nombre: 'Persona Buscada', edad: 31, ubicacion: 'Caracas', estado: 'sin-contacto', foto_r2: 'personas/p_missing.jpg', photo_caption: 'rostro visible', updated_at: 1 },
  ];
  const stmt = (sql: string, args: any[] = []) => ({
    bind: (...next: any[]) => stmt(sql, next),
    first: async () => {
      if (/FROM sessions s JOIN users u/.test(sql) && args[0] === 'op-token') {
        return { id: 'u1', email: 'op@sismo911.test', name: 'Operador', role: 'operator', rank: null, unit: null, phone: null, wallet_address: null, expires_ms: Date.now() + 60_000 };
      }
      return null;
    },
    all: async () => {
      if (/GROUP BY photo_phash/.test(sql)) return { results: groups };
      if (/WHERE moderation='approved' AND photo_phash = \?/.test(sql)) return { results: rows };
      return { results: [] };
    },
    run: async () => ({ meta: { changes: 1 } }),
  });
  return { prepare: (sql: string) => stmt(sql) } as any;
}

describe('missing/found photo review candidates', () => {
  it('requires an operator session', async () => {
    const res = await persons.request('/photo-review/candidates', {}, { DB: makeDB() } as any);
    expect(res.status).toBe(401);
  });

  it('surfaces non-biometric same-photo missing/found review candidates', async () => {
    const res = await persons.request('/photo-review/candidates', { headers: { authorization: 'Bearer op-token' } }, { DB: makeDB() } as any);
    expect(res.status).toBe(200);
    const j = await res.json() as any;
    expect(j.biometric).toBe(false);
    expect(j.candidates).toHaveLength(1);
    expect(j.candidates[0]).toMatchObject({ review_type: 'same_photo_missing_found', missing: 1, found: 1, biometric: false });
    expect(j.candidates[0].cases.map((c: any) => c.status).sort()).toEqual(['found_safe', 'missing']);
  });
});
