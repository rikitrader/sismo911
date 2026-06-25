import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { events } from './routes/events';
import { persons } from './routes/persons';
import { contacts } from './routes/contacts';
import { getCookie } from 'hono/cookie';
import { ingestUsgs } from './ingest/usgs-cron';
import { adapterStatus } from './adapters/social';
import { verifyAccessJwt } from './lib/access';

const app = new Hono<{ Bindings: Env }>();
app.use('/api/*', cors());

// --- Cloudflare Access gate (defense-in-depth) ---
// Protects the admin console + all write endpoints. Edge Access is the primary
// lock; this re-verifies the JWT inside the Worker. No-op until ACCESS_* are set.
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const isAdmin = path.startsWith('/admin');
  const isWrite =
    WRITE_METHODS.has(c.req.method) &&
    (path.startsWith('/api/persons') || path.startsWith('/api/contacts'));
  if (!isAdmin && !isWrite) return next();

  const { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud } = c.env;
  if (!team || !aud) {
    console.warn('[access] not configured (ACCESS_TEAM_DOMAIN/ACCESS_AUD unset) — allowing', path);
    return next();
  }
  const token = c.req.header('Cf-Access-Jwt-Assertion') || getCookie(c, 'CF_Authorization');
  if (!token) return c.json({ error: 'unauthorized', hint: 'Cloudflare Access login required' }, 401);
  const id = await verifyAccessJwt(token, team, aud).catch(() => null);
  if (!id) return c.json({ error: 'forbidden' }, 403);
  c.header('X-Access-Email', id.email ?? 'unknown');
  return next();
});

// Liveness / readiness for smoke tests + uptime checks.
app.get('/api/health', (c) => c.json({ ok: true, service: 'sismo911', ts: Date.now() }));
app.get('/api/ready', async (c) => {
  try {
    await c.env.DB.prepare('SELECT 1').first();
    return c.json({ ready: true });
  } catch (e: any) {
    return c.json({ ready: false, error: String(e?.message ?? e) }, 503);
  }
});

// Ingestion status: last USGS poll + which social adapters are configured.
app.get('/api/status', async (c) => {
  const log = await c.env.DB.prepare('SELECT * FROM ingest_log').all().catch(() => ({ results: [] }));
  return c.json({
    ingest: log.results ?? [],
    social_adapters: adapterStatus(c.env as unknown as Record<string, unknown>),
  });
});

app.route('/api/events', events);
app.route('/api/persons', persons);
app.route('/api/contacts', contacts);

// Anything not under /api and not a static asset → let ASSETS serve (404s handled by CF).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  // Cron trigger (every minute) → keep the USGS mirror fresh.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      ingestUsgs(env).catch((e) => console.error('[cron] ingest failed:', e?.message ?? e))
    );
  },
};
