import { describe, it, expect } from 'vitest';
import { voluntarios } from '../src/routes/voluntarios';

// In-memory D1 stub: 2 registered volunteers + 3 RAV "se ofreció" reports.
const REG = [
  { id: 'vol_1', full_name: 'Ana Medina', city: 'Caracas', state: 'Distrito Capital', area: '', skills: '["medico"]', availability: 'inmediata', has_vehicle: 1, can_travel: 0, experience: 'paramédico', notes: '', contact_phone: '0412', email: null, created_ms: 5 },
  { id: 'vol_2', full_name: 'Beto Ruiz', city: 'Valencia', state: 'Carabobo', area: '', skills: '["logistica","transporte"]', availability: 'dias', has_vehicle: 0, can_travel: 1, experience: '', notes: '', contact_phone: '0414', email: null, created_ms: 4 },
];
const RAV = [
  { id: 'r-a', title: 'Soy informático', description: 'doy soporte y digitalización de datos', city: 'Panamá', state: 'Otro', area: null, lat: null, lng: null, contact: '+507 1', photo_url: 'http://p/a.png', created_at: '2026-06-27T03:00:00Z' },
  { id: 'r-b', title: 'Disponible', description: 'soy enfermera, atiendo heridos', city: 'Maracay', state: 'Aragua', area: null, lat: null, lng: null, contact: '0426', photo_url: null, created_at: '2026-06-27T02:00:00Z' },
  { id: 'r-c', title: 'Ayudo', description: 'tengo camión para trasladar víveres', city: 'Maracaibo', state: 'Zulia', area: null, lat: null, lng: null, contact: '0424', photo_url: null, created_at: '2026-06-27T01:00:00Z' },
];

function makeDB() {
  const exec = (sql: string, _a: any[], kind: 'first' | 'all' | 'run') => {
    if (/FROM volunteers/.test(sql)) return kind === 'all' ? { results: REG } : REG[0];
    if (/FROM rav_reports/.test(sql)) return kind === 'all' ? { results: RAV } : RAV[0];
    return kind === 'all' ? { results: [] } : null;
  };
  const stmt = (sql: string, args: any[] = []): any => ({
    bind: (...a: any[]) => stmt(sql, a),
    first: async () => exec(sql, args, 'first'),
    all: async () => exec(sql, args, 'all'),
    run: async () => exec(sql, args, 'run'),
  });
  return { prepare: (sql: string) => stmt(sql) } as any;
}

const ENV = { DB: makeDB() } as any;
const call = (path: string) => voluntarios.request(path, {}, ENV);

describe('GET /directory', () => {
  it('returns exact full-dataset stats independent of pagination', async () => {
    const res = await call('/directory?limit=2');
    expect(res.status).toBe(200);
    const d = await res.json() as any;
    expect(d.stats.total).toBe(5);                 // 2 registered + 3 RAV
    expect(d.stats.groups.medico).toBe(2);         // Ana(medico) + enfermera(derived)
    expect(d.stats.groups.logistica).toBe(2);      // Beto(logistica/transporte) + camión(transporte)
    expect(d.filteredTotal).toBe(5);
    expect(d.items.length).toBe(2);                // page size honored
    expect(d.nextOffset).toBe(2);                  // more pages exist
  });

  it('paginates with offset and ends with nextOffset null', async () => {
    const res = await call('/directory?limit=2&offset=4');
    const d = await res.json() as any;
    expect(d.items.length).toBe(1);
    expect(d.nextOffset).toBe(null);
  });

  it('derives tags for RAV rows server-side', async () => {
    const res = await call('/directory?limit=50');
    const d = await res.json() as any;
    const it = d.items.find((x: any) => x.id === 'r-a');
    expect(it.skills).toContain('tecnologia');     // "informático … digitalización"
  });

  it('filters by skill server-side (count matches stats)', async () => {
    const res = await call('/directory?skill=transporte&limit=50');
    const d = await res.json() as any;
    expect(d.filteredTotal).toBe(2);               // Beto + camión
    expect(d.items.every((x: any) => x.skills.includes('transporte'))).toBe(true);
  });

  it('filters by free-text query', async () => {
    const res = await call('/directory?q=enfermera&limit=50');
    const d = await res.json() as any;
    expect(d.filteredTotal).toBe(1);
    expect(d.items[0].id).toBe('r-b');
  });
});
