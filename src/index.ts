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
import { voluntarios } from './routes/voluntarios';
import { telemedicina } from './routes/telemedicina';
import { telemedScheduling } from './routes/telemedicina-scheduling';
import { damageMap } from './routes/damage-map';
import { reports } from './routes/reports';
import { chat } from './routes/chat';
import { acopio } from './routes/acopio';
import { logistica } from './routes/logistica';
import { admin } from './routes/admin';
import { funding } from './routes/funding';
import { dashboard } from './routes/dashboard';
import { plan } from './routes/plan';
import { desaparecidos } from './routes/desaparecidos';
import { blog } from './routes/blog';
import { rav } from './routes/rav';
import { mascotas } from './routes/mascotas';
import { emergencia } from './routes/emergencia';
import { monitor } from './routes/monitor';
import { aidOrgs } from './routes/aid_orgs';
import { donations } from './routes/donations';
import { botiquin } from './routes/botiquin';
import { agencias } from './routes/agencias';
import { estados } from './routes/estados';
import { layers } from './routes/layers';
import { sitrep } from './routes/sitrep';
import { dataApi } from './routes/data-api';
import { mcp } from './routes/mcp';
import { flotaUnidades } from './routes/flota-unidades';
import { flotaPersonal } from './routes/flota-personal';
import { flotaFlotas } from './routes/flota-flotas';
import { flotaMisiones } from './routes/flota-misiones';
import { flotaRastreo } from './routes/flota-rastreo';
import { flotaTablero } from './routes/flota-tablero';
import { sumUbicaciones } from './routes/suministros-ubicaciones';
import { sumCategorias } from './routes/suministros-categorias';
import { sumProductos } from './routes/suministros-productos';
import { sumInventario } from './routes/suministros-inventario';
import { sumMovimientos } from './routes/suministros-movimientos';
import { sumRequisiciones } from './routes/suministros-requisiciones';
import { sumTablero } from './routes/suministros-tablero';
import { runCronGroup } from './cron';
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
  allowHeaders: ['content-type', 'authorization', 'cf-access-jwt-assertion', 'x-api-key', 'x-api-secret'],
  credentials: false,
  maxAge: 86400,
}));
// The MCP server + the developer data feed are meant to be consumed from
// anywhere (agents, third-party apps), so they get an open, read-only CORS
// policy distinct from the same-origin app API above.
app.use('/mcp', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: ['content-type', 'authorization', 'mcp-session-id', 'mcp-protocol-version', 'accept'],
  exposeHeaders: ['mcp-session-id'],
  maxAge: 86400,
}));

// --- Role-based auth gate ---
// Admin console + curation/management writes require an authenticated operator
// or admin session. Citizen actions (SOS, check-ins, damage reports) stay open.
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const ADMIN_WRITE_PREFIXES = ['/api/contacts', '/api/resources', '/api/acopio', '/api/danos-estructurales', '/api/admin', '/api/aid-orgs', '/api/emergencia', '/api/flota', '/api/suministros'];
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const method = c.req.method;
  const isAdminPage = path.startsWith('/admin');
  // Citizen submission of a centro de acopio stays public (moderation queue);
  // everything else under /api/acopio (status overrides, submission review) is operator-only.
  const isAcopioReport = method === 'POST' && path === '/api/acopio/report';
  // Public, rate-limited share-counter bump on an emergency profile stays open;
  // everything else under /api/emergencia (create/edit/upload/retire) is operator-only.
  const isEmergenciaShare = method === 'POST' && /^\/api\/emergencia\/[^/]+\/share$/.test(path);
  const isAdminWrite = !isAcopioReport && !isEmergenciaShare && WRITE_METHODS.has(method) && ADMIN_WRITE_PREFIXES.some((p) => path.startsWith(p));
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
  const isSatWrite = WRITE_METHODS.has(method) && path.startsWith('/api/sat/') && path !== '/api/sat/pytorch-results';
  // Acopio submission review queue (GET) is operator-only; approve/reject (PATCH)
  // is already covered by the /api/acopio admin-write rule above.
  const isAcopioReview = method === 'GET' && path === '/api/acopio/submissions';
  const isFlotaApi = path.startsWith('/api/flota'); // internal dispatch console — operator/admin only for ALL methods (reads expose responder GPS/PII)
  if (!isAdminPage && !isAdminWrite && !isReportModeration && !isPersonModeration && !isDocketSubmit && !isCaseAdmin && !isSosTriage && !isDamageReview && !isManualRefresh && !isShelterModeration && !isSatWrite && !isAcopioReview && !isFlotaApi) return next();

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
  // Cross-source de-dup health: how many rows are canonical vs. marked as a
  // duplicate of another source, plus any magnitude DIVERGENCES (USGS vs.
  // FUNVISIS disagreeing on the size of the same quake) — a data-quality signal.
  const dedup = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN dup_of IS NULL THEN 1 ELSE 0 END) AS canonical,
            SUM(CASE WHEN dup_of IS NOT NULL THEN 1 ELSE 0 END) AS duplicates
     FROM events`
  ).first<any>().catch(() => null);
  const divergences = await c.env.DB.prepare(
    `SELECT d.id AS drop_id, d.source AS drop_source, d.mag AS drop_mag,
            k.id AS keep_id, k.source AS keep_source, k.mag AS keep_mag,
            ROUND(ABS(d.mag - k.mag), 2) AS d_mag, d.time_ms
     FROM events d JOIN events k ON k.id = d.dup_of
     WHERE d.dup_of IS NOT NULL AND d.mag IS NOT NULL AND k.mag IS NOT NULL
       AND ABS(d.mag - k.mag) >= 1.0
     ORDER BY d.time_ms DESC LIMIT 20`
  ).all().catch(() => ({ results: [] }));
  // Self-monitoring tolerance check, refreshed hourly by the FUNVISIS cron
  // (replaces the old local launchd job). `borderline` non-empty => the tuned
  // dedup tolerances may be missing real duplicates; revisit dedupe-seismic.ts.
  const sanity = await c.env.CACHE.get('dedupe:sanity', 'json').catch(() => null);
  // Gated integrations — honest health: configured only when their credential/binding exists.
  const gated = [
    { key: 'shakealert', label: 'ShakeAlert (alerta temprana)', configured: false, reason: 'Licencia requerida; cobertura EE.UU. (no Venezuela)' },
    { key: 'damage_ai', label: 'Evaluación IA de daños', configured: Boolean(env.AI), reason: env.AI ? 'EN VIVO — Workers AI visión (llama-3.2-11b-vision)' : 'Requiere binding Workers AI o ANTHROPIC_API_KEY' },
    { key: 'sitrep_ai', label: 'Informes IA de situación', configured: Boolean(env.AI), reason: env.AI ? 'Workers AI activo' : 'Requiere binding Workers AI' },
    { key: 'power_outage', label: 'Cortes de energía', configured: false, reason: 'API de servicios eléctricos no pública en VE' },
    { key: 'traffic', label: 'Cierres viales / tráfico', configured: false, reason: 'Feeds 511 son EE.UU.; sin equivalente público en VE' },
    { key: 'funvisis', label: 'FUNVISIS (servicio sísmico nacional)', configured: true, reason: 'EN VIVO — feed público maravilla.json, ingerido cada hora junto a USGS' },
    { key: 'gov_official', label: 'Otros datos oficiales (PC/Defensa Civil)', configured: false, reason: 'Sin API pública — ingreso por consola / convenio' },
  ];
  return c.json({
    ingest: log.results ?? [],
    seismic_dedup: {
      total: Number(dedup?.total ?? 0),
      canonical: Number(dedup?.canonical ?? 0),
      duplicates: Number(dedup?.duplicates ?? 0),
      divergences: divergences.results ?? [],
      // Hourly self-monitoring: null until the first FUNVISIS cron after deploy.
      // `borderline` non-empty => tuned tolerances may be missing real dups.
      sanity: sanity ?? null,
    },
    social_adapters: adapterStatus(env),
    gated,
  }, 200, { 'Cache-Control': 'no-store' });
});

// Developer-facing data platform: open seismic feed + self-service registration
// + keyed/bulk pull from our DB (src/routes/data-api.ts). Mounted before the
// generic /api/events so /api/v1/* is matched first.
app.route('/api/v1', dataApi);
// MCP server (Streamable HTTP, JSON-RPC) — exposes our public datasets as tools.
app.route('/mcp', mcp);

app.route('/api/events', events);
app.route('/api/persons', persons);
app.route('/api/contacts', contacts);
app.route('/api/auth', auth);
app.route('/api/familia', familia);
app.route('/api/voluntarios', voluntarios);
app.route('/api/telemedicina', telemedicina); // doctors worldwide ↔ patient help-requests for VE (intake, claim, schedule, video, calendar/ics)
app.route('/api/telemedicina', telemedScheduling); // v2 self-service booking: catalog/slots/appointments + 7-state lifecycle + availability
app.route('/api/danos-estructurales', damageMap);
app.route('/api/alerts', alerts);
app.route('/api/facilities', facilities);
app.route('/api/shelters', shelters);
app.route('/api/damage', damage);
app.route('/api/sat', satellite);    // satellite/GIS damage analysis (imagery proxy + Workers AI vision)
app.route('/api/reports', reports);  // citizen damage-report map + comments + reactions + moderation
app.route('/api/chat', chat);        // community channel
app.route('/api/layers', layers);    // COP layers catalog + public GeoJSON layers
app.route('/api/sitrep', sitrep);    // public non-PII operational sitrep / ESF matrix
app.route('/api/acopio', acopio);    // /api/acopio/status — live status for acopio/hospitales/PC
app.route('/api/acopio', logistica); // /api/acopio/{inventory,needs,shipments,match,dashboard} — FEMA-style logistics (GET public, writes operator-gated)
app.route('/api/admin', admin);      // /api/admin/dedupe-personas — operator-triggered cleanup
app.route('/api/monitor', monitor);  // social/web disaster-signal monitor (GET public; refresh gated; apify webhook secret-gated)
app.route('/api/aid-orgs', aidOrgs); // curatable global disaster-relief directory (GET public; writes operator-gated)
app.route('/api/emergencia', emergencia); // SUPER BANNER emergency spotlight profiles (GET public; writes operator-gated; share bump public)
app.route('/api', donations); // crowdfunding: /api/campaigns* + /api/donations* (anonymous donate; card→USDC via Crossmint)
app.route('/', botiquin);     // /botiquin index + /botiquin/:slug per-item pages + /api/botiquin
app.route('/', agencias);     // FEMA-VE: /agencias mapa + ESF-15 + /agencias/:slug + /api/agencias
app.route('/', estados);      // /estados (índice nacional) + /estado/:slug (mapa por estado: GIS + sismos + daños)
app.get('/la-guaira', (c) => c.redirect('/estado/la-guaira', 301)); // antigua URL → plantilla generalizada
app.route('/api', ops);    // /api/checkins, /api/resources, /api/sos
app.route('/api', misc);   // /api/heatmap, /api/comms, /api/push/*, /api/sitrep/*
app.route('/api/funding', funding); // live funder pipeline for the supply dashboard (reads 09_Funding sheet)
app.route('/api/dashboard', dashboard); // /api/dashboard/geoseismic — aggregate of heatmap+stats+danos for /terremotos (4→2 fetches)
app.route('/plan', plan);  // invitation-only business-plan slide deck (own invite-code gate)

// FLOTA — emergency-response Fleet & Dispatch (FleetOps adapted to disaster response).
// GET public; writes operator-gated (see ADMIN_WRITE_PREFIXES '/api/flota').
app.route('/api/flota/unidades', flotaUnidades);   // response units (vehicles) CRUD
app.route('/api/flota/personal', flotaPersonal);   // responders/crew CRUD
app.route('/api/flota/flotas', flotaFlotas);       // fleets (groupings of units)
app.route('/api/flota/misiones', flotaMisiones);   // dispatch missions + lifecycle state machine + waypoints + activity
app.route('/api/flota/rastreo', flotaRastreo);     // live unit GPS ingest + map reads
app.route('/api/flota/tablero', flotaTablero);     // command dashboard aggregates (resumen + mapa)

// SUMINISTROS — Inventory & supply-chain management (OpenBoxes core, re-coded
// serverless). Served at suministros.sismo911.com + /suministros. GET public;
// writes operator-gated (see ADMIN_WRITE_PREFIXES '/api/suministros').
app.route('/api/suministros/ubicaciones', sumUbicaciones);     // stock-holding sites CRUD
app.route('/api/suministros/categorias', sumCategorias);       // product categories CRUD
app.route('/api/suministros/productos', sumProductos);         // product catalog (SKU master) CRUD
app.route('/api/suministros/inventario', sumInventario);       // read-only stock-on-hand views + item pickers
app.route('/api/suministros/movimientos', sumMovimientos);     // stock transactions: recepción/despacho/traslado/ajuste/conteo
app.route('/api/suministros/requisiciones', sumRequisiciones); // stock requests + FEFO fulfillment
app.route('/api/suministros/tablero', sumTablero);             // dashboard aggregates (resumen + alertas + recientes)

// Homepage = the DESAPARECIDOS registry. The root URL serves the /personas page
// (family-reunification is the app's front door post-quake); the old TERREMOTOS
// dashboard moves to /terremotos. ASSETS.fetch is independent of these Hono
// routes, so it still resolves the real static files (/personas → personas.html,
// / → index.html) regardless of what we mount here.
const serveAsset = async (c: any, assetPath: string) => {
  const assetRes = await c.env.ASSETS.fetch(new Request(new URL(assetPath, c.req.url).toString(), c.req.raw));
  const res = new Response(assetRes.body, assetRes);
  setSecurityHeaders({ header: (k: string, v: string) => res.headers.set(k, v) } as any);
  // Public command-page shells (homepage /personas, /dashboard, /geosismico, ...) are
  // identical for every visitor — their live data loads via the JSON APIs below. Let
  // browsers + the edge hold the shell briefly so repeat loads during a traffic spike
  // don't re-invoke the Worker; stale-while-revalidate keeps a new deploy visible ~60s.
  res.headers.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  return res;
};
export const PUBLIC_COMMAND_ASSETS: Record<string, string> = {
  '/dashboard': '/dashboard',
  '/geosismico': '/geosismico',
  '/humanitario': '/humanitario',
  '/layers': '/layers',
  '/logistica': '/logistica',
  '/operaciones': '/operaciones',
  '/red-ayuda': '/red-ayuda',
  '/satellite': '/satellite',
  // SUMINISTROS — inventory & supply-chain division (also bound to its own
  // subdomain below). The SPA shell lives at public/suministros.html.
  '/suministros': '/suministros',
};
for (const [routePath, assetPath] of Object.entries(PUBLIC_COMMAND_ASSETS)) {
  app.get(routePath, (c) => serveAsset(c, assetPath));
}
// Root is host-branched (see run_worker_first '/'): the SUMINISTROS subdomain
// serves the inventory SPA shell; every other host serves the DESAPARECIDOS
// registry (the app's post-quake front door).
app.get('/', (c) =>
  new URL(c.req.url).hostname === 'suministros.sismo911.com'
    ? serveAsset(c, '/suministros')
    : serveAsset(c, '/personas'));
app.get('/terremotos', (c) => serveAsset(c, '/'));

// Per-person social cards: a shared /familia?persona=<id> link rewrites the page's
// OG/Twitter meta to the person's photo + name, so the preview shows THEM (→ virality).
app.get('/familia', async (c) => {
  // Legacy "open a search case" deep-links (/familia?reportar=1&lugar=…&ref=…) now
  // re-flow to the unified /reportar form — the Familia/Check-in page has been
  // retired in favour of the DESAPARECIDOS (/personas) + Reportar flow.
  if (c.req.query('reportar')) return c.redirect('/reportar', 302);
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

// SUPER BANNER emergency profile — a shareable /emergencia/:slug page whose
// OG/Twitter meta is rewritten to THIS person's hero photo + headline, so the
// social preview shows them (→ virality). The page shell is emergencia-perfil.html;
// it reads the JSON from /api/emergencia/:slug client-side.
app.get('/emergencia/:slug', async (c) => {
  const assetRes = await c.env.ASSETS.fetch(new Request(new URL('/emergencia-perfil', c.req.url).toString(), c.req.raw));
  const base = new Response(assetRes.body, assetRes);
  setSecurityHeaders({ header: (k: string, v: string) => base.headers.set(k, v) } as any);
  base.headers.set('Cache-Control', 'no-cache, must-revalidate');
  const slug = c.req.param('slug');
  const p = await c.env.DB.prepare(
    `SELECT id, slug, name, age, location, headline, need_type, hero_url, status FROM emergency_profiles
     WHERE (slug = ? OR id = ?) AND status IN ('active','resolved') LIMIT 1`,
  ).bind(slug, slug).first<any>().catch(() => null);
  if (!p) return base;
  // Resolve a hero image URL for the card (external hero_url, else the hero photo row).
  let img = p.hero_url || '';
  if (!img) {
    const ph = await c.env.DB.prepare(
      `SELECT id, r2_key, url FROM emergency_photos WHERE profile_id = ? ORDER BY (kind='hero') DESC, sort ASC, created_ms ASC LIMIT 1`,
    ).bind(p.id).first<any>().catch(() => null);
    if (ph) img = ph.r2_key ? `https://sismo911.com/api/emergencia/photo/${ph.id}` : (ph.url || '');
  }
  if (!img) img = 'https://sismo911.com/og/og-default.png';
  else if (img.startsWith('/')) img = `https://sismo911.com${img}`;
  const e = (s: string) => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
  const title = `🆘 ${p.name}${p.age ? `, ${p.age} años` : ''} necesita ayuda urgente — SISMO911`;
  const desc = `${p.headline || `Emergencia en ${p.location || 'Venezuela'}`}. Ayúdanos a difundir y movilizar apoyo. #SISMO911`;
  const url = `https://sismo911.com/emergencia/${p.slug}`;
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
// redayudavenezuela.com (RAV): /api/rav/run (Bearer) + public /api/stats/official
// + /api/verified-info. The /informacion-verificada page is a static asset.
app.route('/', rav);
// Lost-pet case tracking: /api/mascotas/:id (detail+timeline), /:id/update,
// /report, /queue, /events/:eid/approve|reject. The /mascota detail page is static.
app.route('/', mascotas);

async function fetchAsset(c: any, path: string) {
  const req = new Request(new URL(path, c.req.url).toString(), c.req.raw);
  return c.env.ASSETS.fetch(req);
}

// Anything not under /api and not a routed public command page → let ASSETS
// serve. We try the raw path first, then clean-url fallbacks (`/foo` → `/foo.html`)
// so the public HTML pages remain reachable even when the underlying asset file
// is named with the `.html` suffix.
app.all('*', async (c) => {
  const path = new URL(c.req.url).pathname;
  const candidates = path === '/' || path.endsWith('.html') || path.endsWith('.xml') || path.endsWith('.txt') || path.endsWith('.json') || path.endsWith('.webmanifest')
    ? [path]
    : [path, `${path}.html`, `${path}/index.html`];
  let assetRes: Response | null = null;
  for (const candidate of candidates) {
    const res = await fetchAsset(c, candidate);
    if (res.ok || res.status !== 404) { assetRes = res; break; }
    if (!assetRes) assetRes = res;
  }
  const res = new Response((assetRes || await fetchAsset(c, path)).body, assetRes || undefined);
  setSecurityHeaders({ header: (k: string, v: string) => res.headers.set(k, v) } as any);
  // Always revalidate HTML, the service worker, and the manifest so a deploy is
  // visible immediately instead of being masked by browser/edge caching. Hashed
  // assets (CSS/JS/images) keep their default long cache.
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/html') || path === '/sw.js' || path.endsWith('.webmanifest')) {
    res.headers.set('Cache-Control', 'no-cache, must-revalidate');
  }
  return res;
});

// Global handlers: guarantee security headers + a sanitized body on errors and
// unmatched routes. (notFound rarely fires given the app.all('*') asset fallback
// above, but both are wired for defense-in-depth.)
app.onError((err, c) => {
  console.error('[onError]', err);
  try { setSecurityHeaders(c); } catch {}
  return c.json({ error: 'internal' }, 500);
});
app.notFound((c) => {
  try { setSecurityHeaders(c); } catch {}
  return c.json({ error: 'not_found' }, 404);
});

export default {
  fetch: app.fetch,
  // Cron triggers are STAGGERED (:00/:15/:30/:45) so each fires its own Worker
  // invocation with a fresh subrequest budget. Routing + job groups live in
  // src/cron.ts (CRON_GROUPS). This is what keeps any single invocation from
  // exhausting the subrequest ceiling and starving the jobs at the tail.
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runCronGroup(event.cron, env));
  },
};
