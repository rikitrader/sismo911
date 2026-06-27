import { describe, it, expect } from 'vitest';
import { emergencia } from '../src/routes/emergencia';

// In-memory D1 stub for emergency_profiles + emergency_photos + the operator
// session lookup. Keyed by regex on the SQL the route actually runs.
function makeDB(profiles: any[], opts: { operator?: boolean } = {}) {
  const exec = (sql: string, args: any[], kind: 'first' | 'all' | 'run') => {
    // operator session lookup (auth.getUserFromRequest)
    if (/FROM sessions s JOIN users u/.test(sql)) {
      return opts.operator
        ? { id: 'u1', email: 'op@sismo911.com', name: 'Op', role: 'operator', expires_ms: Date.now() + 1e7 }
        : null;
    }
    if (/INSERT INTO audit/.test(sql)) return { success: true };
    if (kind === 'run') return { success: true, meta: { changes: 1 } };
    // photos for serialize()
    if (/FROM emergency_photos/.test(sql)) return { results: [] };
    // single-profile lookup (by slug or id)
    if (/FROM emergency_profiles WHERE slug = \? OR id = \?/.test(sql)) {
      return profiles.find((p) => p.slug === args[0] || p.id === args[1]) ?? null;
    }
    if (/FROM emergency_profiles WHERE id = \?/.test(sql)) return profiles.find((p) => p.id === args[0]) ?? null;
    // list
    if (/FROM emergency_profiles/.test(sql)) {
      const pub = /status IN \('active','resolved'\)/.test(sql);
      const rows = pub ? profiles.filter((p) => p.status === 'active' || p.status === 'resolved') : profiles.filter((p) => p.status !== 'archived');
      return kind === 'all' ? { results: rows } : rows[0] ?? null;
    }
    return kind === 'all' ? { results: [] } : null;
  };
  const stmt = (sql: string, args: any[] = []): any => ({
    bind: (...a: any[]) => stmt(sql, a),
    first: async () => exec(sql, args, 'first'),
    all: async () => exec(sql, args, 'all'),
    run: async () => exec(sql, args, 'run'),
  });
  return { prepare: (sql: string) => stmt(sql), batch: async () => [] } as any;
}

const PROFILES = [
  { id: 'emg_1', slug: 'ana-1', name: 'Ana', age: 30, location: 'Caracas', headline: 'Necesita cirugía', bio: 'Historia', need_type: 'medico', goal_amount: 1000, raised_amount: 250, currency: 'USD', video_url: null, hero_url: null, contact: '0412-secret', cta_url: null, cta_label: null, status: 'active', featured: 1, priority: 5, rotation_secs: 8, views: 10, shares: 2, updated_ms: 1 },
  { id: 'emg_2', slug: 'leo-2', name: 'Leo', age: null, location: 'Mérida', headline: null, bio: null, need_type: 'rescate', goal_amount: null, raised_amount: 0, currency: 'USD', video_url: null, hero_url: null, contact: null, cta_url: null, cta_label: null, status: 'paused', featured: 0, priority: 0, rotation_secs: 8, views: 0, shares: 0, updated_ms: 2 },
];

const env = (operator = false) => ({ DB: makeDB(JSON.parse(JSON.stringify(PROFILES)), { operator }), ALLOWED_ORIGINS: '' } as any);
const opHeaders = { Authorization: 'Bearer tok' };

describe('emergencia route', () => {
  it('public list hides paused profiles and strips the private contact field', async () => {
    const r = await emergencia.request('/', {}, env());
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.operator).toBe(false);
    expect(j.profiles.map((p: any) => p.slug)).toEqual(['ana-1']); // paused 'leo-2' excluded
    expect(j.profiles[0].contact).toBeNull();                      // operator-only field redacted
    expect(j.profiles[0].headline).toBe('Necesita cirugía');
  });

  it('public detail of a paused profile is 404', async () => {
    const r = await emergencia.request('/leo-2', {}, env());
    expect(r.status).toBe(404);
  });

  it('public detail of an active profile resolves by slug', async () => {
    const r = await emergencia.request('/ana-1', {}, env());
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.profile.name).toBe('Ana');
    expect(j.profile.contact).toBeNull();
  });

  it('rejects profile creation without an operator session (401)', async () => {
    const r = await emergencia.request('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'X' }) }, env(false));
    expect(r.status).toBe(401);
  });

  it('rejects edits without an operator session (401)', async () => {
    const r = await emergencia.request('/emg_1', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'X' }) }, env(false));
    expect(r.status).toBe(401);
  });

  it('allows an operator to create a profile (201) and validates the name', async () => {
    const ok = await emergencia.request('/', { method: 'POST', headers: { 'Content-Type': 'application/json', ...opHeaders }, body: JSON.stringify({ name: 'María', need_type: 'medico' }) }, env(true));
    expect(ok.status).toBe(201);
    const j = await ok.json();
    expect(j.slug).toMatch(/^maria-/);

    const empty = await emergencia.request('/', { method: 'POST', headers: { 'Content-Type': 'application/json', ...opHeaders }, body: JSON.stringify({ name: '' }) }, env(true));
    expect(empty.status).toBe(400);
  });

  it('operator admin listing requires a session', async () => {
    expect((await emergencia.request('/admin', {}, env(false))).status).toBe(401);
    expect((await emergencia.request('/admin', { headers: opHeaders }, env(true))).status).toBe(200);
  });
});
