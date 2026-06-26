import { describe, it, expect } from 'vitest';
import {
  genApiKey, genSecret, sha256Hex, sanitizeScopes, hasScope, publicClient,
  extractCredential, DEFAULT_SCOPES, ALL_SCOPES,
} from '../src/lib/apikey';
import { dataApi } from '../src/routes/data-api';
import { mcp } from '../src/routes/mcp';

// --- sample seismic rows the dataset queries read ---
const EVENTS = [
  { id: 'ev1', mag: 7.5, place: 'Yumare, Venezuela', place_es: 'Yumare', time_ms: Date.now() - 3600_000, lat: 10.6, lon: -68.7, depth_km: 10, mmi: 7, alert: 'orange', tsunami: 0, felt: 120, url: 'https://x' },
  { id: 'ev2', mag: 4.2, place: 'Sucre, Venezuela', place_es: 'Sucre', time_ms: Date.now() - 7200_000, lat: 10.4, lon: -64.2, depth_km: 20, mmi: 4, alert: 'green', tsunami: 0, felt: 5, url: 'https://y' },
];

// --- stateful in-memory D1 stub for api_clients + dataset reads ---
function makeDB() {
  const clients: any[] = [];
  const exec = (sql: string, args: any[], kind: 'first' | 'all' | 'run') => {
    // ---- writes ----
    if (kind === 'run') {
      if (/INSERT INTO api_clients/.test(sql)) {
        const [id, name, email, org, purpose, api_key, secret_hash, scopes, created_ms] = args;
        clients.push({ id, name, email, org, purpose, api_key, secret_hash, scopes, status: 'pending', rate_limit: 120, request_count: 0, last_used_ms: null, created_ms });
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 1 } };
    }
    // ---- api_clients reads ----
    if (/FROM api_clients WHERE api_key = \?/.test(sql)) return clients.find((c) => c.api_key === args[0]) ?? null;
    if (/SELECT id FROM api_clients WHERE email = \? AND status = 'pending'/.test(sql)) {
      return clients.find((c) => c.email === args[0] && c.status === 'pending') ?? null;
    }
    // ---- dataset reads ----
    if (/COUNT\(\*\) AS n FROM events/.test(sql)) return { n: EVENTS.length };
    if (/FROM events WHERE id = \?/.test(sql)) return EVENTS.find((e) => e.id === args[0]) ?? null;
    if (/FROM events/.test(sql)) return kind === 'all' ? { results: EVENTS } : EVENTS[0];
    if (/SELECT COUNT.*total/.test(sql)) return { total: 2, max_mag: 7.5, last_24h: 2, last_7d: 2, m4plus_30d: 2 };
    if (/FROM shelter_status/.test(sql) && /COUNT/.test(sql)) return { n: 0 };
    if (/FROM blog_posts/.test(sql) && /COUNT/.test(sql)) return { n: 0 };
    if (/FROM personas/.test(sql) && /COUNT/.test(sql)) return { n: 0 };
    return kind === 'all' ? { results: [] } : null;
  };
  const stmt = (sql: string, args: any[] = []) => ({
    bind: (...a: any[]) => stmt(sql, a),
    first: async () => exec(sql, args, 'first'),
    all: async () => exec(sql, args, 'all'),
    run: async () => exec(sql, args, 'run'),
  });
  return { prepare: (sql: string) => stmt(sql), _clients: clients } as any;
}
const fakeKv = () => {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); } } as any;
};
const env = (db?: any) => ({ DB: db ?? makeDB(), CACHE: fakeKv() });

// ===========================================================================
describe('apikey: credential primitives', () => {
  it('keys + secrets have the expected shape', () => {
    expect(genApiKey()).toMatch(/^sk911_[a-f0-9]{32}$/);
    expect(genSecret().length).toBeGreaterThan(50);
    expect(genApiKey()).not.toBe(genApiKey());
  });
  it('sha256Hex is deterministic + 64 hex chars', async () => {
    const a = await sha256Hex('hello');
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(await sha256Hex('hello')).toBe(a);
  });
  it('sanitizeScopes drops unknown scopes + dedups, falls back to default', () => {
    expect(sanitizeScopes('read:earthquakes,bogus,read:earthquakes')).toBe('read:earthquakes');
    expect(sanitizeScopes('')).toBe(DEFAULT_SCOPES);
    expect(sanitizeScopes(['read:stats', 'read:missing-persons'])).toBe('read:stats,read:missing-persons');
  });
  it('hasScope + ALL_SCOPES include the sensitive grant', () => {
    expect(hasScope('read:earthquakes,read:stats', 'read:stats')).toBe(true);
    expect(hasScope('read:earthquakes', 'read:missing-persons')).toBe(false);
    expect(ALL_SCOPES).toContain('read:missing-persons');
  });
  it('publicClient never leaks the secret hash', () => {
    const pub = publicClient({ id: 'cli_1', name: 'n', email: 'e', org: '', purpose: '', api_key: 'sk911_x', status: 'approved', scopes: 'read:stats', rate_limit: 120, request_count: 0, last_used_ms: null, created_ms: 0 } as any);
    expect(JSON.stringify(pub)).not.toMatch(/secret/);
    expect(pub.scopes).toEqual(['read:stats']);
  });
  it('extractCredential parses header pair + Bearer key:secret', () => {
    const mk = (h: Record<string, string>) => ({ req: { header: (k: string) => h[k.toLowerCase()] } }) as any;
    expect(extractCredential(mk({ 'x-api-key': 'sk911_a', 'x-api-secret': 's' }))).toEqual({ key: 'sk911_a', secret: 's' });
    expect(extractCredential(mk({ authorization: 'Bearer sk911_a:sec:ret' }))).toEqual({ key: 'sk911_a', secret: 'sec:ret' });
    expect(extractCredential(mk({}))).toBeNull();
  });
});

// ===========================================================================
describe('data API: public feed (open)', () => {
  it('GET /earthquakes returns paginated events', async () => {
    const r = await dataApi.request('/earthquakes', {}, env());
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.earthquakes.length).toBe(2);
    expect(j.total).toBe(2);
  });
  it('GET /latest includes a threat assessment', async () => {
    const r = await dataApi.request('/latest', {}, env());
    const j = await r.json();
    expect(j.threat).toBeTruthy();
    expect(j.events.length).toBe(2);
  });
  it('GET / discovery lists the three lanes', async () => {
    const j = await (await dataApi.request('/', {}, env())).json();
    expect(j.public).toBeTruthy();
    expect(j.gated).toBeTruthy();
    expect(j.mcp).toContain('/mcp');
  });
});

describe('data API: registration + gating', () => {
  it('POST /register validates input', async () => {
    const bad = await dataApi.request('/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', email: 'bad', purpose: 'short' }) }, env());
    expect(bad.status).toBe(400);
  });
  it('POST /register issues a pending key + secret once', async () => {
    const r = await dataApi.request('/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Investigador', email: 'a@b.com', org: 'UCV', purpose: 'Estudio de sismicidad nacional' }) }, env());
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.status).toBe('pending');
    expect(j.api_key).toMatch(/^sk911_/);
    expect(j.api_secret.length).toBeGreaterThan(20);
  });
  it('gated /data/earthquakes is 401 without credentials', async () => {
    const r = await dataApi.request('/data/earthquakes', {}, env());
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe('missing_credentials');
  });
  it('a pending key is rejected (403) until approved; an approved key pulls data', async () => {
    const db = makeDB();
    const e = env(db);
    // register
    const reg = await (await dataApi.request('/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Org', email: 'c@d.com', purpose: 'Panel ciudadano de sismos' }) }, e)).json();
    const headers = { 'x-api-key': reg.api_key, 'x-api-secret': reg.api_secret };
    // pending → 403
    const pend = await dataApi.request('/data/earthquakes', { headers }, e);
    expect(pend.status).toBe(403);
    expect((await pend.json()).error).toBe('pending_approval');
    // wrong secret → 401
    const wrong = await dataApi.request('/data/earthquakes', { headers: { 'x-api-key': reg.api_key, 'x-api-secret': 'nope' } }, e);
    expect(wrong.status).toBe(401);
    // approve out of band, then pull works
    db._clients[0].status = 'approved';
    const ok = await dataApi.request('/data/earthquakes', { headers }, e);
    expect(ok.status).toBe(200);
    expect((await ok.json()).earthquakes.length).toBe(2);
    // missing-persons scope not granted → 403
    const mp = await dataApi.request('/data/missing-persons', { headers }, e);
    expect(mp.status).toBe(403);
    expect((await mp.json()).error).toBe('insufficient_scope');
  });
});

// ===========================================================================
describe('MCP server (JSON-RPC over /mcp)', () => {
  const rpc = (body: any) => mcp.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env());

  it('initialize echoes a supported protocol + serverInfo', async () => {
    const j = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json();
    expect(j.result.serverInfo.name).toBe('sismo911');
    expect(j.result.protocolVersion).toBe('2025-06-18');
    expect(j.result.capabilities.tools).toBeTruthy();
  });
  it('tools/list returns the full read-only tool set', async () => {
    const j = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    const names = j.result.tools.map((t: any) => t.name);
    expect(names).toContain('list_earthquakes');
    expect(names).toContain('seismic_stats');
    expect(names).toContain('search_missing_persons');
    expect(j.result.tools.length).toBe(7);
  });
  it('tools/call list_earthquakes returns structured content', async () => {
    const j = await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_earthquakes', arguments: {} } })).json();
    expect(j.result.isError).toBe(false);
    expect(j.result.structuredContent.total).toBe(2);
    expect(j.result.content[0].type).toBe('text');
  });
  it('tools/call on an unknown tool is a tool error, not a protocol error', async () => {
    const j = await (await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } })).json();
    expect(j.result.isError).toBe(true);
  });
  it('unknown method → JSON-RPC -32601', async () => {
    const j = await (await rpc({ jsonrpc: '2.0', id: 5, method: 'does/not/exist' })).json();
    expect(j.error.code).toBe(-32601);
  });
  it('a notification (no id) is acknowledged with 202 and no body', async () => {
    const r = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(r.status).toBe(202);
  });
});
