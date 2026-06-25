import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { events } from './routes/events';
import { persons } from './routes/persons';
import { contacts } from './routes/contacts';
import { alerts } from './routes/alerts';
import { facilities } from './routes/facilities';
import { ops } from './routes/ops';
import { misc } from './routes/misc';
import { damage } from './routes/damage';
import { auth } from './routes/auth';
import { familia } from './routes/familia';
import { reports } from './routes/reports';
import { chat } from './routes/chat';
import { acopio } from './routes/acopio';
import { ingestUsgs } from './ingest/usgs-cron';
import { ingestKobo } from './ingest/kobo-cron';
import { announceQuakes } from './ingest/quake-announce';
import { adapterStatus } from './adapters/social';
import { getUserFromRequest } from './lib/auth';
import { allowedOrigins, isAllowedOrigin, setSecurityHeaders } from './lib/security';

const app = new Hono<{ Bindings: Env }>();
app.use('*', async (c, next) => {
  setSecurityHeaders(c);
  await next();
});
app.use('/api/*', cors({
  origin: (origin, c) => (isAllowedOrigin(c.env, origin) ? (origin || allowedOrigins(c.env)[0]) : null),
  allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['content-type', 'authorization', 'cf-access-jwt-assertion'],
  credentials: false,
  maxAge: 86400,
}));

// --- Role-based auth gate ---
// Admin console + curation/management writes require an authenticated operator
// or admin session. Citizen actions (SOS, check-ins, damage reports) stay open.
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const ADMIN_WRITE_PREFIXES = ['/api/contacts', '/api/resources', '/api/acopio'];
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const method = c.req.method;
  const isAdminPage = path.startsWith('/admin');
  const isAdminWrite = WRITE_METHODS.has(method) && ADMIN_WRITE_PREFIXES.some((p) => path.startsWith(p));
  const isUnsafe = WRITE_METHODS.has(method);
  const isSameSite = isAllowedOrigin(c.env, c.req.header('origin') || c.req.header('referer')?.split('/').slice(0, 3).join('/'));
  // Report moderation (approve/reject/delete + review queue) is operator-only.
  // Citizen submission (POST /api/reports), reactions, comments and reads stay public.
  const isReportModeration =
    (path.startsWith('/api/reports') && (method === 'PATCH' || method === 'DELETE')) ||
    path === '/api/reports/queue';
  // Missing-persons moderation: review queue + approve/reject are operator-only.
  // Public POST (report) stays open; status updates are operator-only.
  const isPersonModeration =
    path === '/api/persons/queue' ||
    (path.startsWith('/api/persons/') && method === 'PATCH') ||
    path.endsWith('/approve') || path.endsWith('/reject');
  const isSosTriage =
    path === '/api/sos' && method === 'GET' ||
    (path.startsWith('/api/sos/') && method === 'PATCH');
  const isDamageReview = path === '/api/damage' && method === 'GET' || path.startsWith('/api/damage/photo/');
  const isManualRefresh = path === '/api/events/refresh';
  if (!isAdminPage && !isAdminWrite && !isReportModeration && !isPersonModeration && !isSosTriage && !isDamageReview && !isManualRefresh) return next();

  const user = await getUserFromRequest(c.env, c).catch(() => null);
  const authorized = user && (user.role === 'operator' || user.role === 'admin');
  if (authorized && isUnsafe && !isSameSite) return c.json({ error: 'bad_origin' }, 403);
  if (authorized) { c.header('X-User-Role', user!.role); return next(); }

  // Unauthenticated/unauthorized: redirect HTML to login, JSON gets 401.
  if (isAdminPage) {
    const next_ = encodeURIComponent(path);
    return c.redirect(`/login?next=${next_}`, 302);
  }
  return c.json({ error: 'unauthorized', hint: 'Inicia sesión como operador o admin' }, 401);
});

// Liveness / readiness for smoke tests + uptime checks.
app.get('/api/health', (c) => c.json({ ok: true, service: 'sismo911', ts: Date.now() }));
app.get('/api/ready', async (c) => {
  try {
    await c.env.DB.prepare('SELECT 1').first();
    return c.json({ ready: true });
  } catch (e: any) {
    console.error('[ready] database check failed:', e?.message ?? e);
    return c.json({ ready: false, error: 'dependency_unavailable' }, 503);
  }
});

// Ingestion status: last USGS poll, social adapters, and gated integrations.
app.get('/api/status', async (c) => {
  const log = await c.env.DB.prepare('SELECT * FROM ingest_log').all().catch(() => ({ results: [] }));
  const env = c.env as unknown as Record<string, unknown>;
  // Gated integrations — honest health: configured only when their credential/binding exists.
  const gated = [
    { key: 'shakealert', label: 'ShakeAlert (alerta temprana)', configured: false, reason: 'Licencia requerida; cobertura EE.UU. (no Venezuela)' },
    { key: 'damage_ai', label: 'Evaluación IA de daños', configured: Boolean(env.AI), reason: env.AI ? 'EN VIVO — Workers AI visión (llama-3.2-11b-vision)' : 'Requiere binding Workers AI o ANTHROPIC_API_KEY' },
    { key: 'sitrep_ai', label: 'Informes IA de situación', configured: Boolean(env.AI), reason: env.AI ? 'Workers AI activo' : 'Requiere binding Workers AI' },
    { key: 'power_outage', label: 'Cortes de energía', configured: false, reason: 'API de servicios eléctricos no pública en VE' },
    { key: 'traffic', label: 'Cierres viales / tráfico', configured: false, reason: 'Feeds 511 son EE.UU.; sin equivalente público en VE' },
    { key: 'gov_official', label: 'Datos oficiales (PC/FUNVISIS/Defensa)', configured: false, reason: 'Sin API pública — ingreso por consola / convenio' },
  ];
  return c.json({
    ingest: log.results ?? [],
    social_adapters: adapterStatus(env),
    gated,
  });
});

app.route('/api/events', events);
app.route('/api/persons', persons);
app.route('/api/contacts', contacts);
app.route('/api/auth', auth);
app.route('/api/familia', familia);
app.route('/api/alerts', alerts);
app.route('/api/facilities', facilities);
app.route('/api/damage', damage);
app.route('/api/reports', reports);  // citizen damage-report map + comments + reactions + moderation
app.route('/api/chat', chat);        // community channel
app.route('/api/acopio', acopio);    // /api/acopio/status — live status for acopio/hospitales/PC
app.route('/api', ops);    // /api/checkins, /api/resources, /api/sos
app.route('/api', misc);   // /api/heatmap, /api/comms, /api/push/*, /api/sitrep/*

// Anything not under /api and not a static asset → let ASSETS serve (404s handled by CF).
app.all('*', async (c) => {
  // Serve static assets, but re-apply the security headers — ASSETS.fetch returns
  // a fresh Response that drops the headers set by the global middleware, so CSP,
  // X-Frame-Options, etc. would otherwise be missing on the HTML pages.
  const assetRes = await c.env.ASSETS.fetch(c.req.raw);
  const res = new Response(assetRes.body, assetRes);
  setSecurityHeaders({ header: (k: string, v: string) => res.headers.set(k, v) } as any);
  return res;
});

export default {
  fetch: app.fetch,
  // Cron trigger (every minute) → keep the USGS mirror + KoboToolbox damage feed fresh.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      await Promise.allSettled([
        ingestUsgs(env).catch((e) => console.error('[cron] usgs ingest failed:', e?.message ?? e)),
        ingestKobo(env).catch((e) => console.error('[cron] kobo ingest failed:', e?.message ?? e)),
      ]);
      // After events are fresh, announce significant new quakes to the channel.
      await announceQuakes(env).catch((e) => console.error('[cron] quake announce failed:', e?.message ?? e));
    })());
  },
};
