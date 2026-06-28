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
import { x402, wellKnownX402 } from './routes/x402';
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
import { adminRbac } from './routes/admin-rbac';
import { adminSessions } from './routes/admin-sessions';
import { adminOrg } from './routes/admin-org';
import { adminFlags } from './routes/admin-flags';
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
import { verifyUnitToken, unitTokenFromRequest } from './lib/flota-token';
import { flotaAdmin } from './routes/flota-admin';
export { FlotaTracking } from './realtime/flota-tracking';
export { FleetLive } from './realtime/fleet-live';
import { sumUbicaciones } from './routes/suministros-ubicaciones';
import { sumCategorias } from './routes/suministros-categorias';
import { sumProductos } from './routes/suministros-productos';
import { sumInventario } from './routes/suministros-inventario';
import { sumMovimientos } from './routes/suministros-movimientos';
import { sumRequisiciones } from './routes/suministros-requisiciones';
import { sumTablero } from './routes/suministros-tablero';
import { sumProveedores } from './routes/suministros-proveedores';
import { sumDonaciones } from './routes/suministros-donaciones';
import { sumOrdenes } from './routes/suministros-ordenes';
import { sumCuentas } from './routes/suministros-cuentas';
import { sumFacturas } from './routes/suministros-facturas';
import { sumPicklists } from './routes/suministros-picklists';
import { sumMetodosEnvio } from './routes/suministros-metodos-envio';
import { sumEnvios } from './routes/suministros-envios';
import { sumConteos } from './routes/suministros-conteos';
import { sumReportes } from './routes/suministros-reportes';
import { sumEtiquetas } from './routes/suministros-etiquetas';
import { runCronGroup } from './cron';
import { adapterStatus } from './adapters/social';
import { getUserFromRequest } from './lib/auth';
import { evaluateGate, LEGACY_OPS_PERM, WRITE_METHODS } from './rbac/route-policy';
import { authorize } from './rbac/middleware';
import { getEffectivePermissions } from './rbac/engine';
import { allowedOrigins, isAllowedOrigin, setSecurityHeaders, rateLimit } from './lib/security';
import { backfillBatch } from './lib/flota-ingest';
import { audit } from './lib/audit';

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

// --- Role-based auth gate (RBAC, server-side) ---
// The protected-surface matrix now lives in src/rbac/route-policy.ts (evaluateGate)
// and the decision is resolved through the permission engine (src/rbac/engine.ts):
// gated surfaces require `ops:console`, the capability held by exactly the legacy
// operator + super_admin roles — so access is identical to the old coarse gate,
// while new admin routes can demand finer permissions via requirePermission().
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const method = c.req.method;
  const decision = evaluateGate(path, method);
  if (decision.kind === 'open') return next();

  // Field-unit GPS ingest: a valid per-unit token authorizes ONLY
  // POST /api/flota/rastreo/posicion without an operator session (and bypasses
  // the browser same-site check, since field devices aren't browsers).
  if (method === 'POST' && path === '/api/flota/rastreo/posicion') {
    const unidad = await verifyUnitToken(c.env, unitTokenFromRequest(c.req.raw)).catch(() => null);
    if (unidad) return next();
  }

  const isUnsafe = WRITE_METHODS.has(method);
  const originHdr = c.req.header('origin') || c.req.header('referer')?.split('/').slice(0, 3).join('/');
  // For state-changing methods a missing Origin/Referer is treated as NOT same-site (defense-in-depth vs CSRF).
  const isSameSite = originHdr ? isAllowedOrigin(c.env, originHdr) : !isUnsafe;

  const user = await getUserFromRequest(c.env, c).catch(() => null);
  // Docket submission only needs a logged-in user (any role); admin HTML pages and
  // every other gated surface require `ops:console` (operator/admin equivalent).
  let authorized = false;
  if (decision.kind === 'login') authorized = !!user;
  else if (decision.kind === 'page') authorized = await authorize(c.env, user, LEGACY_OPS_PERM);
  else authorized = await authorize(c.env, user, decision.perm);

  if (authorized && isUnsafe && !isSameSite) return c.json({ error: 'bad_origin' }, 403);
  // Forced password rotation: a user flagged must_change_pw may read, but cannot
  // perform ANY gated write until they set a new password (POST /api/auth/change-password).
  if (authorized && isUnsafe && user?.must_change_pw && path !== '/api/auth/change-password') {
    return c.json({ error: 'must_change_password', hint: 'Cambia tu contraseña temporal en /cambiar-clave antes de registrar operaciones.' }, 403);
  }
  if (authorized) { if (user) c.header('X-User-Role', user.role); return next(); }

  // Unauthenticated/unauthorized: redirect HTML admin pages to login, JSON gets 401.
  if (decision.kind === 'page') {
    const next_ = encodeURIComponent(path);
    return c.redirect(`/login?next=${next_}`, 302);
  }
  return c.json({ error: 'unauthorized', hint: 'Inicia sesión como operador o admin' }, 401);
});

// --- Inventory mutation audit trail ---
// Record every SUCCESSFUL operator write under /api/suministros to the audit log
// (who + action + path + IP + when), so the division has a complete who-did-what
// trail for inventory mutations. Runs after the route; only logs 2xx/3xx (blocked
// 4xx writes are not "operations"). Audit failures never break the request.
app.use('*', async (c, next) => {
  await next();
  const method = c.req.method;
  if (!WRITE_METHODS.has(method)) return;
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/api/suministros') && c.res.status >= 200 && c.res.status < 400) {
    await audit(c, `suministros.${method.toLowerCase()}`, { path, status: c.res.status }).catch(() => {});
  }
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
app.route('/api/x402', x402);        // x402 payment receiving: per-user wallet accepts USDC over HTTP (verify+settle via facilitator)
// x402 service discovery (public). Agents/clients read this to learn the network + pay-URL template.
// Fix 1: when payments are not LIVE, 503 instead of advertising a protocol we can't settle.
app.get('/.well-known/x402.json', (c) => {
  const doc = wellKnownX402(c.env);
  return doc ? c.json(doc) : c.json({ error: 'payments_unavailable' }, 503);
});
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
app.route('/api/rbac', adminRbac);   // enterprise RBAC admin API (users/roles/permissions/audit/dashboard) — each route self-gates via requirePermission
app.route('/api/rbac', adminSessions); // Phase 2: TOTP MFA + session mgmt + emergency lock
app.route('/api/rbac', adminOrg);      // Phase 2: organization → department → team hierarchy
app.route('/api/rbac', adminFlags);    // Phase 2: feature flags scoped by org/role/user
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

// FLOTA LIVE GPS — Uber-style, emergency-safe phone tracking.
// Admin/operator surface (units, scoped tokens, live snapshot/WS) — gated all
// methods by isFlotaAdminApi.
app.route('/api/admin/flota', flotaAdmin);

// Phone PWA (public; the URL token is the credential, validated by the WS).
// The bare /flota/track is the installed-PWA start_url — the page resumes the
// unit token from localStorage there.
app.get('/flota/track/:token', (c) => c.env.ASSETS.fetch(new Request(new URL('/flota-track.html', c.req.url))));
app.get('/flota/track', (c) => c.env.ASSETS.fetch(new Request(new URL('/flota-track.html', c.req.url))));

// Offline GPS buffer flush: the phone uploads fixes it captured while the
// WebSocket was down. Unit-token auth (same as the WS); ingested in 'backfill'
// mode (24h window, no jump guard, source 'buffered', not broadcast).
app.post('/flota/track/backfill', async (c) => {
  const v = await verifyUnitToken(c.env, unitTokenFromRequest(c.req.raw)).catch(() => null);
  if (!v) return c.json({ error: 'invalid_token' }, 401);
  const unit = await c.env.DB.prepare(`SELECT status FROM flota_units WHERE id = ?`).bind(v.unitId)
    .first() as { status: string } | null;
  if (!unit || unit.status !== 'active') return c.json({ error: 'unit_inactive' }, 403);
  const limited = await rateLimit(c.env, c, 'flota_backfill:' + v.unitId, 20, 60); // 20 flushes / 60s / unit
  if (limited) return limited;
  const body = await c.req.json().catch(() => null);
  const fixes = Array.isArray(body?.fixes) ? body.fixes.slice(0, 200) : null; // cap 200 per flush
  if (!fixes) return c.json({ error: 'fixes[] requerido' }, 400);
  const res = await backfillBatch(c.env, v.unitId, fixes, Date.now());
  return c.json({ ok: true, ...res });
});

// Admin live map page (gated by isAdminPage → redirects unauth to /login).
app.get('/admin/flota/live', (c) => c.env.ASSETS.fetch(new Request(new URL('/admin-flota-live.html', c.req.url))));

// Face-vetting review queue (gated by isAdminPage → redirects unauth to /login).
app.get('/admin/dup-review', (c) => c.env.ASSETS.fetch(new Request(new URL('/admin-dup-review.html', c.req.url))));

// Admin x402 payments reconciliation page (gated by /admin prefix → ops:console).
app.get('/admin/x402', (c) => c.env.ASSETS.fetch(new Request(new URL('/admin-x402.html', c.req.url))));

// Unit GPS WebSocket: verify token + unit active, then hand to the FleetLive DO
// tagged as a unit. Public path (token-validated here); never log the token.
app.get('/ws/flota/unit', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') return c.json({ error: 'expected_websocket' }, 426);
  const v = await verifyUnitToken(c.env, unitTokenFromRequest(c.req.raw)).catch(() => null);
  if (!v) return c.json({ error: 'invalid_token' }, 401);
  const unit = await c.env.DB.prepare(`SELECT status FROM flota_units WHERE id = ?`).bind(v.unitId)
    .first() as { status: string } | null;
  if (!unit || unit.status !== 'active') return c.json({ error: 'unit_inactive' }, 403);
  const headers = new Headers(c.req.raw.headers);
  headers.set('x-flota-role', 'unit');
  headers.set('x-flota-unit-id', v.unitId);
  headers.set('x-flota-token-id', v.tokenId);
  const id = c.env.FLEET_LIVE.idFromName('global');
  return c.env.FLEET_LIVE.get(id).fetch(new Request(c.req.url, { method: 'GET', headers }));
});

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
app.route('/api/suministros/proveedores', sumProveedores);     // suppliers + product-supplier pricing/lead-time
app.route('/api/suministros/donaciones', sumDonaciones);       // donations intake → recepción into stock
app.route('/api/suministros/ordenes', sumOrdenes);             // purchase orders: crear→aprobar→recibir vs OC
app.route('/api/suministros/cuentas', sumCuentas);             // GL accounts / budget codes
app.route('/api/suministros/facturas', sumFacturas);           // supplier invoices (+ líneas, pagar)
app.route('/api/suministros/picklists', sumPicklists);         // pick sheets → despacho on completar
app.route('/api/suministros/metodos-envio', sumMetodosEnvio);  // shipment methods (carriers/modes)
app.route('/api/suministros/envios', sumEnvios);               // multi-step shipments: despachar→en_tránsito→recibir
app.route('/api/suministros/conteos', sumConteos);             // scheduled cycle counts → reconcile via ajuste
app.route('/api/suministros/reportes', sumReportes);           // reporting engine (valuación/rotación/caducidad/ledger/fill-rate)
app.route('/api/suministros/etiquetas', sumEtiquetas);         // barcode/label data for printing

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
// Phase 2 S1: gate the ADMINISTRATION console SHELL behind page auth (not only
// the /api/rbac APIs). /console + /console/ are run_worker_first so this route
// runs; an unauthenticated or non-admin visitor is redirected to /login instead
// of seeing the admin UI. The bundle (/console/app.js|css) stays asset-served and
// public — it carries no data (every datum is gated at /api/rbac/*). "Can enter"
// = holds any admin-read capability.
const CONSOLE_BASELINE = ['users:read','roles:read','permissions:read','audit:read','security:read','sessions:read','organizations:read','feature_flags:read','login_history:read'];
async function canEnterConsole(c: any): Promise<boolean> {
  const user = await getUserFromRequest(c.env, c).catch(() => null);
  if (!user) return false;
  if (user.role === 'admin') return true; // super_admin
  const perms = await getEffectivePermissions(c.env, user.id).catch(() => new Set<string>());
  return CONSOLE_BASELINE.some((p) => perms.has(p));
}
const serveConsole = async (c: any) => {
  if (!(await canEnterConsole(c))) return c.redirect('/login?next=/console/', 302);
  return serveAsset(c, '/console/index.html');
};
app.get('/console', serveConsole);
app.get('/console/', serveConsole);

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
