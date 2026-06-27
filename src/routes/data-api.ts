import { Hono } from 'hono';
import type { Env } from '../types';
import {
  authenticateApiClient,
  genApiKey,
  genSecret,
  genClientId,
  sha256Hex,
  DEFAULT_SCOPES,
  publicClient,
  type ApiClient,
  type Scope,
} from '../lib/apikey';
import {
  clampPage,
  queryEarthquakes,
  getEarthquake,
  latestSeismic,
  seismicStats,
  queryShelters,
  queryBlog,
  queryMissingPersons,
} from '../lib/datasets';
import { requestIp, subjectLimit, normEmail } from '../lib/security';

// Per-email registration limit (tunable) — on top of the per-IP feed limit,
// bounds enumeration/spam of the API-client approval queue.
const REGISTER_MAX_PER_EMAIL = 3;
const REGISTER_WINDOW_SEC = 3600; // 1h

// ===========================================================================
// SISMO911 Data API — /api/v1  (FULLY GATED)
//
//   • Open only: GET / (discovery docs), POST /register (self-service →
//     api_key + secret ONCE, status "pending" until an operator approves it in
//     /admin), GET /me (own status, lenient).
//   • Everything else requires an APPROVED key + secret + scope:
//     /earthquakes, /earthquakes/:id, /latest, /stats AND /data/* — all via
//     gate() → authenticateApiClient (X-API-Key+X-API-Secret or
//     Authorization: Bearer <key>:<secret>), per-client rate-limited + logged.
//   • The MCP server (POST /mcp) is gated the same way (see routes/mcp.ts).
// ===========================================================================

export const dataApi = new Hono<{ Bindings: Env }>();

const VERSION = '1.0.0';
const num = (v: string | undefined) => (v == null || v === '' ? undefined : Number(v));

// ---- light per-IP rate limit for the OPEN feed (KV) -----------------------
async function ipLimit(env: Env, ip: string, max = 60): Promise<boolean> {
  const k = `pubrl:${ip}:${Math.floor(Date.now() / 60_000)}`;
  try {
    const n = Number((await env.CACHE.get(k)) ?? 0) + 1;
    await env.CACHE.put(k, String(n), { expirationTtl: 120 });
    return n <= max;
  } catch {
    return true; // KV hiccup → fail open
  }
}
dataApi.use('*', async (c, next) => {
  // Only throttle the open feed; keyed /data/* has its own per-client limiter.
  const p = new URL(c.req.url).pathname;
  if (p.startsWith('/api/v1/data') || p.endsWith('/register') || p.endsWith('/me')) return next();
  if (!(await ipLimit(c.env, requestIp(c)))) {
    return c.json({ error: 'rate_limited', hint: 'Máx 60 req/min. Regístrate para una clave con límite mayor.' }, 429);
  }
  return next();
});

// ---- discovery -------------------------------------------------------------
dataApi.get('/', (c) =>
  c.json({
    service: 'sismo911',
    version: VERSION,
    docs: 'https://sismo911.com/developers',
    mcp: 'https://sismo911.com/mcp',
    register: {
      'POST /api/v1/register': 'Solicita una clave (name, email, org, purpose) → key+secret (queda pendiente de aprobación)',
      'GET /api/v1/me': 'Estado de tu clave (envía X-API-Key + X-API-Secret)',
    },
    gated: {
      auth: 'X-API-Key + X-API-Secret  ó  Authorization: Bearer <key>:<secret>  (todos requieren clave APROBADA)',
      'GET /api/v1/earthquakes': 'scope read:earthquakes — sismos (filtros: minMag, from, to, q, page, pageSize)',
      'GET /api/v1/earthquakes/:id': 'scope read:earthquakes — un sismo por id',
      'GET /api/v1/latest': 'scope read:earthquakes — sismos recientes + amenaza actual',
      'GET /api/v1/stats': 'scope read:stats — estadísticas sísmicas',
      'GET /api/v1/data/earthquakes': 'scope read:earthquakes — export paginado',
      'GET /api/v1/data/shelters': 'scope read:shelters — albergues aprobados',
      'GET /api/v1/data/blog': 'scope read:blog — noticias publicadas',
      'GET /api/v1/data/stats': 'scope read:stats — estadísticas',
      'GET /api/v1/data/missing-persons': 'scope read:missing-persons (otorgado por operador)',
    },
    mcp_note: 'El servidor MCP (POST /mcp) también requiere clave aprobada (Authorization: Bearer <key>:<secret>) para tools/list y tools/call.',
  })
);

// ===================== SEISMIC FEED (gated: approved key + scope) ============
// Previously open; now require an approved key (same gate() as /data/*).
dataApi.get('/earthquakes', async (c) => {
  const { res } = await gate(c, 'read:earthquakes', '/api/v1/earthquakes');
  if (res) return res;
  const pg = clampPage(c.req.query('page'), c.req.query('pageSize'));
  const out = await queryEarthquakes(
    c.env,
    { minMag: num(c.req.query('minMag')), from: c.req.query('from'), to: c.req.query('to'), q: c.req.query('q') },
    pg
  );
  return c.json({ source: 'sismo911', ...out });
});

dataApi.get('/earthquakes/:id', async (c) => {
  const { res } = await gate(c, 'read:earthquakes', '/api/v1/earthquakes/:id');
  if (res) return res;
  const ev = await getEarthquake(c.env, c.req.param('id'));
  if (!ev) return c.json({ error: 'not_found' }, 404);
  return c.json({ earthquake: ev });
});

dataApi.get('/latest', async (c) => {
  const { res } = await gate(c, 'read:earthquakes', '/api/v1/latest');
  if (res) return res;
  const limit = Number(c.req.query('limit') ?? 20);
  return c.json({ source: 'sismo911', ...(await latestSeismic(c.env, limit)) });
});

dataApi.get('/stats', async (c) => {
  const { res } = await gate(c, 'read:stats', '/api/v1/stats');
  if (res) return res;
  return c.json({ source: 'sismo911', ...(await seismicStats(c.env)) });
});

// ===================== REGISTRATION =========================================
// Public, self-service. Returns key+secret ONE TIME; the secret is then only
// recoverable by re-registering. Client stays "pending" until operator approval.
dataApi.post('/register', async (c) => {
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    body = Object.fromEntries(new URL(c.req.url).searchParams);
  }
  const name = String(body.name ?? '').trim();
  const email = String(body.email ?? '').trim().toLowerCase();
  const org = String(body.org ?? '').trim();
  const purpose = String(body.purpose ?? '').trim();

  if (name.length < 2) return c.json({ error: 'name_required' }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: 'email_invalid' }, 400);
  if (purpose.length < 10) return c.json({ error: 'purpose_required', hint: 'Describe para qué usarás los datos (mín. 10 caracteres).' }, 400);

  // Per-email rate limit — generic 429 (does NOT reveal whether the email exists),
  // bounds enumeration/spam beyond the per-IP feed limit.
  if (await subjectLimit(c.env, 'apiv1_register_email', normEmail(email), REGISTER_MAX_PER_EMAIL, REGISTER_WINDOW_SEC)) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  // Soft anti-abuse: one pending request per email at a time.
  const dupe = await c.env.DB.prepare(`SELECT id FROM api_clients WHERE email = ? AND status = 'pending'`).bind(email).first();
  if (dupe) return c.json({ error: 'already_pending', hint: 'Ya tienes una solicitud en revisión para este correo.' }, 409);

  const id = genClientId();
  const apiKey = genApiKey();
  const secret = genSecret();
  const secretHash = await sha256Hex(secret);
  await c.env.DB.prepare(
    `INSERT INTO api_clients (id, name, email, org, purpose, api_key, secret_hash, status, scopes, rate_limit, created_ms)
     VALUES (?,?,?,?,?,?,?, 'pending', ?, 120, ?)`
  ).bind(id, name, email, org, purpose, apiKey, secretHash, DEFAULT_SCOPES, Date.now()).run();

  return c.json(
    {
      ok: true,
      status: 'pending',
      message: 'Solicitud recibida. Guarda tu secret AHORA — no se vuelve a mostrar. Un operador la revisará.',
      client_id: id,
      api_key: apiKey,
      api_secret: secret,
      scopes: DEFAULT_SCOPES.split(','),
      usage: {
        header: 'X-API-Key: <api_key>  +  X-API-Secret: <api_secret>',
        bearer: `Authorization: Bearer ${apiKey}:<api_secret>`,
        check_status: 'GET /api/v1/me',
        data: 'GET /api/v1/data/earthquakes (tras aprobación)',
      },
    },
    201
  );
});

// GET /api/v1/me — a client checks its own status / scopes with its credentials.
dataApi.get('/me', async (c) => {
  const r = await authenticateApiClientLenient(c);
  if (!r.ok) return c.json({ error: r.error, hint: r.hint }, r.status as any);
  return c.json({ client: publicClient(r.client) });
});

// ===================== GATED DATA PULL ======================================
async function gate(c: any, scope: Scope, endpoint: string) {
  const r = await authenticateApiClient(c, { scope, endpoint });
  if (!r.ok) {
    const headers: Record<string, string> = {};
    if (r.retry_after) headers['Retry-After'] = String(r.retry_after);
    return { res: c.json({ error: r.error, hint: r.hint }, r.status, headers) as Response, client: null as ApiClient | null };
  }
  return { res: null as Response | null, client: r.client };
}

dataApi.get('/data/earthquakes', async (c) => {
  const { res } = await gate(c, 'read:earthquakes', '/api/v1/data/earthquakes');
  if (res) return res;
  const pg = clampPage(c.req.query('page'), c.req.query('pageSize'), 200);
  const out = await queryEarthquakes(
    c.env,
    { minMag: num(c.req.query('minMag')), from: c.req.query('from'), to: c.req.query('to'), q: c.req.query('q') },
    pg
  );
  return c.json(out);
});

dataApi.get('/data/shelters', async (c) => {
  const { res } = await gate(c, 'read:shelters', '/api/v1/data/shelters');
  if (res) return res;
  return c.json(await queryShelters(c.env, clampPage(c.req.query('page'), c.req.query('pageSize'), 200)));
});

dataApi.get('/data/blog', async (c) => {
  const { res } = await gate(c, 'read:blog', '/api/v1/data/blog');
  if (res) return res;
  return c.json(await queryBlog(c.env, clampPage(c.req.query('page'), c.req.query('pageSize'), 200)));
});

dataApi.get('/data/stats', async (c) => {
  const { res } = await gate(c, 'read:stats', '/api/v1/data/stats');
  if (res) return res;
  return c.json(await seismicStats(c.env));
});

dataApi.get('/data/missing-persons', async (c) => {
  const { res } = await gate(c, 'read:missing-persons', '/api/v1/data/missing-persons');
  if (res) return res;
  return c.json(await queryMissingPersons(c.env, clampPage(c.req.query('page'), c.req.query('pageSize'), 200), c.req.query('q')));
});

// Like authenticateApiClient but does NOT enforce scope/approval — used by
// /me so a still-pending client can see that it's pending (auth on key+secret).
async function authenticateApiClientLenient(c: any) {
  // Reuse the full authenticator but tolerate the "pending_approval" verdict by
  // re-reading the row; simplest is a direct lookup that mirrors the secret check.
  const r = await authenticateApiClient(c, { endpoint: '/api/v1/me' });
  if (r.ok) return r;
  if (r.error === 'pending_approval') {
    const cred = (c.req.header('x-api-key') || (c.req.header('authorization') || '').replace(/^(?:Bearer|ApiKey)\s+/i, '').split(':')[0]) ?? '';
    const row = await c.env.DB.prepare(
      `SELECT id,name,email,org,purpose,api_key,status,scopes,rate_limit,request_count,last_used_ms,created_ms
       FROM api_clients WHERE api_key = ?`
    ).bind(cred.trim()).first().catch(() => null);
    if (row) return { ok: true as const, client: row as ApiClient };
  }
  return r;
}
