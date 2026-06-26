import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { events } from './routes/events';
import { persons } from './routes/persons';
import { contacts } from './routes/contacts';
import { alerts } from './routes/alerts';
import { facilities } from './routes/facilities';
import { shelters } from './routes/shelters';
import { ops } from './routes/ops';
import { misc } from './routes/misc';
import { damage } from './routes/damage';
import { satellite } from './routes/satellite';
import { auth } from './routes/auth';
import { familia } from './routes/familia';
import { damageMap } from './routes/damage-map';
import { reports } from './routes/reports';
import { chat } from './routes/chat';
import { acopio } from './routes/acopio';
import { admin } from './routes/admin';
import { funding } from './routes/funding';
import { plan } from './routes/plan';
import { desaparecidos } from './routes/desaparecidos';
import { blog } from './routes/blog';
import { dedupePersonas } from './lib/dedupe';
import { cleanPersonas } from './lib/clean';
import { monitor } from './routes/monitor';
import { aidOrgs } from './routes/aid_orgs';
import { donations } from './routes/donations';
import { botiquin } from './routes/botiquin';
import { agencias } from './routes/agencias';
import { ingestSocialMonitor } from './ingest/social-monitor';
import { syncMonitorSheet, syncSosSheet } from './lib/sheets-sync';
import { ingestUsgs } from './ingest/usgs-cron';
import { ingestKobo } from './ingest/kobo-cron';
import { announceQuakes } from './ingest/quake-announce';
import { ingestSosDamage } from './ingest/sos-damage';
import { ingestFamilia, mirrorFamiliaPhotos } from './ingest/familia-cron';
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
const ADMIN_WRITE_PREFIXES = ['/api/contacts', '/api/resources', '/api/acopio', '/api/danos-estructurales', '/api/admin', '/api/aid-orgs'];
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const method = c.req.method;
  const isAdminPage = path.startsWith('/admin');
  // Citizen submission of a centro de acopio stays public (moderation queue);
  // everything else under /api/acopio (status overrides, submission review) is operator-only.
  const isAcopioReport = method === 'POST' && path === '/api/acopio/report';
  const isAdminWrite = !isAcopioReport && WRITE_METHODS.has(method) && ADMIN_WRITE_PREFIXES.some((p) => path.startsWith(p));
  const isUnsafe = WRITE_METHODS.has(method);
  const originHdr = c.req.header('origin') || c.req.header('referer')?.split('/').slice(0, 3).join('/');
  // For state-changing methods a missing Origin/Referer is treated as NOT same-site (defense-in-depth vs CSRF).
  const isSameSite = originHdr ? isAllowedOrigin(c.env, originHdr) : !WRITE_METHODS.has(c.req.method);
  // Report moderation (approve/reject/delete + review queue) is operator-only.
  // Citizen submission (POST /api/reports), reactions, comments and reads stay public.
  const isReportModeration =
    (path.startsWith('/api/reports') && (method === 'PATCH' || method === 'DELETE')) ||
    path === '/api/reports/queue';
  // Missing-persons moderation: review queues + approve/reject are operator-only.
  // Public POST (report) stays open; status updates are operator-only. The
  // case-docket approve/reject + pending queue are included here.
  const isPersonModeration =
    path === '/api/persons/queue' ||
    path === '/api/persons/docket/queue' ||
    (path.startsWith('/api/persons/') && method === 'PATCH') ||
    path.endsWith('/approve') || path.endsWith('/reject') || path.endsWith('/localizar');
  // Case docket: the GET index (/api/persons/cases) + per-person docket are
  // PUBLIC reads (redacted server-side for non-operators). Submitting an update
  // requires LOGIN (any role) — citizen updates land 'pending' for operator
  // approval (handled in the route). Approve/reject + queue are operator-only
  // via isPersonModeration above.
  const isDocketSubmit = method === 'POST' && /^\/api\/persons\/[^/]+\/docket$/.test(path);
  // Court-docket internal surface (evidence, tasks, messages, victims, case meta,
  // audit) is operator/admin-only for ALL methods — this is the confidential
  // expediente, not public data.
  const isCaseAdmin = /^\/api\/persons\/[^/]+\/(attachments|tasks|messages|victims|case|audit)(\/|$)/.test(path);
  const isSosTriage =
    path === '/api/sos' && method === 'GET' ||
    (path.startsWith('/api/sos/') && method === 'PATCH');
  const isDamageReview = path === '/api/damage' && method === 'GET' || path.startsWith('/api/damage/photo/');
  const isManualRefresh = path === '/api/events/refresh';
  // Shelter-status moderation queue is operator-only; /:id/approve is covered by
  // the generic endsWith('/approve') rule above. Public GET + crowd POST stay open.
  const isShelterModeration = path === '/api/shelters/queue';
  // Satellite GIS: GET config/google/maxar/damage are public reads; analyze +
  // verification writes are operator-only.
  const isSatWrite = WRITE_METHODS.has(method) && path.startsWith('/api/sat/');
  // Acopio submission review queue (GET) is operator-only; approve/reject (PATCH)
  // is already covered by the /api/acopio admin-write rule above.
  const isAcopioReview = method === 'GET' && path === '/api/acopio/submissions';
  if (!isAdminPage && !isAdminWrite && !isReportModeration && !isPersonModeration && !isDocketSubmit && !isCaseAdmin && !isSosTriage && !isDamageReview && !isManualRefresh && !isShelterModeration && !isSatWrite && !isAcopioReview) return next();

  const user = await getUserFromRequest(c.env, c).catch(() => null);
  // Docket submission only needs a logged-in user (any role); everything else
  // here is operator/admin-only.
  const authorized = isDocketSubmit ? !!user : (user && (user.role === 'operator' || user.role === 'admin'));
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
  }, 200, { 'Cache-Control': 'no-store' });
});

app.route('/api/events', events);
app.route('/api/persons', persons);
app.route('/api/contacts', contacts);
app.route('/api/auth', auth);
app.route('/api/familia', familia);
app.route('/api/danos-estructurales', damageMap);
app.route('/api/alerts', alerts);
app.route('/api/facilities', facilities);
app.route('/api/shelters', shelters);
app.route('/api/damage', damage);
app.route('/api/sat', satellite);    // satellite/GIS damage analysis (imagery proxy + Workers AI vision)
app.route('/api/reports', reports);  // citizen damage-report map + comments + reactions + moderation
app.route('/api/chat', chat);        // community channel
app.route('/api/acopio', acopio);    // /api/acopio/status — live status for acopio/hospitales/PC
app.route('/api/admin', admin);      // /api/admin/dedupe-personas — operator-triggered cleanup
app.route('/api/monitor', monitor);  // social/web disaster-signal monitor (GET public; refresh gated; apify webhook secret-gated)
app.route('/api/aid-orgs', aidOrgs); // curatable global disaster-relief directory (GET public; writes operator-gated)
app.route('/api', donations); // crowdfunding: /api/campaigns* + /api/donations* (anonymous donate; card→USDC via Crossmint)
app.route('/', botiquin);     // /botiquin index + /botiquin/:slug per-item pages + /api/botiquin
app.route('/', agencias);     // FEMA-VE: /agencias mapa + ESF-15 + /agencias/:slug + /api/agencias
app.route('/api', ops);    // /api/checkins, /api/resources, /api/sos
app.route('/api', misc);   // /api/heatmap, /api/comms, /api/push/*, /api/sitrep/*
app.route('/api/funding', funding); // live funder pipeline for the supply dashboard (reads 09_Funding sheet)
app.route('/plan', plan);  // invitation-only business-plan slide deck (own invite-code gate)

// Per-person social cards: a shared /familia?persona=<id> link rewrites the page's
// OG/Twitter meta to the person's photo + name, so the preview shows THEM (→ virality).
app.get('/familia', async (c) => {
  const assetRes = await c.env.ASSETS.fetch(new Request(new URL('/familia', c.req.url).toString(), c.req.raw));
  const base = new Response(assetRes.body, assetRes);
  setSecurityHeaders({ header: (k: string, v: string) => base.headers.set(k, v) } as any);
  base.headers.set('Cache-Control', 'no-cache, must-revalidate');
  const id = c.req.query('persona');
  if (!id) return base;
  const p = await c.env.DB.prepare(
    `SELECT id, nombre, edad, ubicacion, foto, foto_r2 FROM personas WHERE id = ? AND moderation='approved'`
  ).bind(id).first<any>().catch(() => null);
  if (!p) return base;
  const e = (s: string) => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
  const title = `🔴 Buscamos a ${p.nombre}${p.edad ? `, ${p.edad} años` : ''} — SISMO911`;
  const desc = `Última ubicación: ${p.ubicacion || 'Venezuela'}. Ayúdanos a difundir y reunir a esta familia. #SISMO911`;
  const img = (p.foto_r2 || p.foto) ? `https://sismo911.com/api/familia/photo/${p.id}` : 'https://sismo911.com/og/og-default.png';
  const url = `https://sismo911.com/familia?persona=${p.id}`;
  const set = (v: string) => ({ element(el: any) { el.setAttribute('content', v); } });
  return new HTMLRewriter()
    .on('title', { element(el) { el.setInnerContent(title); } })
    .on('meta[property="og:title"]', set(title))
    .on('meta[property="og:description"]', set(desc))
    .on('meta[property="og:url"]', set(url))
    .on('meta[property="og:image"]', set(img))
    .on('head', { element(el) { el.append(
      `<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${e(title)}"><meta name="twitter:description" content="${e(desc)}"><meta name="twitter:image" content="${img}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">`,
      { html: true }); } })
    .transform(base);
});

// Public shareable "Se busca" articles (one per missing-person case) + their
// paginated index + sitemap. Dynamic from D1 → scales to the whole registry.
app.route('/', desaparecidos);
// Dynamic /blog ("Noticias") magazine from the blog_posts table — mounted AFTER
// desaparecidos so its specific /blog/desaparecidos routes win over /blog/:slug.
app.route('/', blog);

// Anything not under /api and not a static asset → let ASSETS serve (404s handled by CF).
app.all('*', async (c) => {
  // Serve static assets, but re-apply the security headers — ASSETS.fetch returns
  // a fresh Response that drops the headers set by the global middleware, so CSP,
  // X-Frame-Options, etc. would otherwise be missing on the HTML pages.
  const assetRes = await c.env.ASSETS.fetch(c.req.raw);
  const res = new Response(assetRes.body, assetRes);
  setSecurityHeaders({ header: (k: string, v: string) => res.headers.set(k, v) } as any);
  // Always revalidate HTML, the service worker, and the manifest so a deploy is
  // visible immediately instead of being masked by browser/edge caching. Hashed
  // assets (CSS/JS/images) keep their default long cache.
  const ct = res.headers.get('content-type') || '';
  const path = new URL(c.req.url).pathname;
  if (ct.includes('text/html') || path === '/sw.js' || path.endsWith('.webmanifest')) {
    res.headers.set('Cache-Control', 'no-cache, must-revalidate');
  }
  return res;
});

export default {
  fetch: app.fetch,
  // Cron trigger (hourly, "0 * * * *") → every ingest/sync job is parsed once per hour.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      // Keep the USGS mirror + KoboToolbox damage feed fresh, then announce new quakes.
      await Promise.allSettled([
        ingestUsgs(env).catch((e) => console.error('[cron] usgs ingest failed:', e?.message ?? e)),
        ingestKobo(env).catch((e) => console.error('[cron] kobo ingest failed:', e?.message ?? e)),
      ]);
      await announceQuakes(env).catch((e) => console.error('[cron] quake announce failed:', e?.message ?? e));
      // Sync structural-damage reports from sosvenezuela2026 (source of truth).
      await ingestSosDamage(env).catch((e: any) => console.error('[cron] sos-damage sync failed:', e?.message ?? e));
      // Re-ingest the missing-persons (Familia) registry from FAMILIA_SOURCE_URL (no-op if unset),
      // then CLEAN BEFORE LIVE — flag corrupted/fake rows (→moderation='rejected', hidden from public)
      // and remove exact-content + same-photo duplicates. Public reads only ever see clean, deduped rows.
      await ingestFamilia(env).catch((e: any) => console.error('[cron] familia sync failed:', e?.message ?? e));
      await cleanPersonas(env, { apply: true }).catch((e: any) => console.error('[cron] personas clean failed:', e?.message ?? e));
      await dedupePersonas(env, { mode: 'exact', apply: true, limit: 400 }).catch((e: any) => console.error('[cron] personas dedupe(exact) failed:', e?.message ?? e));
      await dedupePersonas(env, { mode: 'photo', apply: true, limit: 400 }).catch((e: any) => console.error('[cron] personas dedupe(photo) failed:', e?.message ?? e));
      // Mirror external missing-person photos into R2 (foto_r2) so they're self-hosted,
      // not hot-linked. Ported from the decommissioned desaparecidos-vzla-api worker.
      await mirrorFamiliaPhotos(env).catch((e: any) => console.error('[cron] familia photo mirror failed:', e?.message ?? e));
      // Social/web disaster-signal monitor → D1, then mirror into the Google Sheet.
      await ingestSocialMonitor(env).catch((e: any) => console.error('[cron] social monitor failed:', e?.message ?? e));
      await syncMonitorSheet(env).catch((e: any) => console.error('[cron] monitor sheet sync failed:', e?.message ?? e));
      // Safety net: re-mirror the SOS table (live posts/patches sync it immediately).
      await syncSosSheet(env).catch((e: any) => console.error('[cron] sos sheet sync failed:', e?.message ?? e));
    })());
  },
};
