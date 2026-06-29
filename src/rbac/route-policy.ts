/**
 * Route → permission policy.
 *
 * This REPLACES the old inline `ADMIN_WRITE_PREFIXES` + the hardcoded
 * `role==='operator'||role==='admin'` decision in index.ts with a single,
 * centralized, pure mapping from (path, method) → required capability.
 *
 * Phase 2 R1: each surface maps to a FINE-GRAINED permission (flota:read,
 * persons:moderate, admin:maintenance, …) instead of the coarse ops:console.
 * Backward-compatibility contract (verified by test/route-policy.test.ts): every
 * mapped permission is held by the legacy operator role (and super_admin), and by
 * no other existing role — so no current user gains or loses access, while new
 * granular roles can be scoped to exactly one surface.
 */

export const LEGACY_OPS_PERM = 'ops:console';

// Prefixes whose WRITE methods require operational access (moved out of index.ts).
export const ADMIN_WRITE_PREFIXES = [
  '/api/contacts', '/api/resources', '/api/acopio', '/api/danos-estructurales',
  '/api/admin', '/api/aid-orgs', '/api/emergencia', '/api/flota', '/api/suministros',
  '/api/refugios', '/api/casualties',
];

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export type GateDecision =
  | { kind: 'open' }                       // no auth required
  | { kind: 'login' }                      // any authenticated user
  | { kind: 'perm'; perm: string }         // requires this permission
  | { kind: 'page'; perm?: string }        // HTML page (login redirect on fail); perm defaults to ops:console
  | { kind: 'deny' };                      // M1 default-deny: an /api route neither gated nor on the public allow-list → fail closed (403)

// M1 default-deny — explicit allow-list of the PUBLIC /api surface. ANY /api/*
// path that is neither gated (the matrix below) nor matched here fails closed.
//
// IMPORTANT: most of these are NOT "wide open" — they are token-gated or
// route-level-authenticated INSIDE their handlers (e.g. /api/rbac uses
// requirePermission per route; /api/blog/run uses BLOG_INGEST_TOKEN; webhooks use
// shared secrets; /api/telemedicina uses booking/doctor tokens). The global gate
// merely lets the request REACH that route-level auth. A brand-new feature prefix
// is intentionally absent here, so it fails closed (the exact C3/flota bug class).
// Completeness is enforced by test/api-route-coverage.test.ts against the real
// Hono route table — a new prefix cannot merge/deploy unclassified.
const PUBLIC_API_PREFIXES: readonly string[] = [
  '/api/health', '/api/ready', '/api/status', '/api/verified-info', '/api/stats', '/api/csp-report',
  '/api/events', '/api/heatmap', '/api/dashboard', '/api/geo', '/api/layers', '/api/sitrep',
  '/api/acopio', '/api/agencias', '/api/aid-orgs', '/api/alerts', '/api/auth',
  '/api/blog', '/api/botiquin', '/api/campaigns', '/api/campaigns-mine', '/api/chat', '/api/checkins',
  '/api/comms', '/api/contacts', '/api/damage', '/api/danos-estructurales',
  '/api/donations', '/api/e', '/api/emergencia', '/api/facilities', '/api/familia',
  '/api/funding', '/api/humanitarian', '/api/mascotas', '/api/monitor',
  '/api/persons', '/api/push', '/api/rav', '/api/rbac', '/api/refugios', '/api/casualties', '/api/reports',
  '/api/resources', '/api/sat', '/api/shelters', '/api/sos', '/api/suministros', '/api/triage',
  '/api/telemedicina', '/api/v1', '/api/voluntarios', '/api/x402', '/api/admin',
  // Profile Command Center — every endpoint self-authenticates via
  // getUserFromRequest and is scoped to the caller's own user id (like /api/x402).
  '/api/profile',
  // Transactional-email preview/test — the public GET /preview index is harmless
  // metadata; the render + send routes self-gate on the NOTIFY_TOKEN secret
  // inside the handler (like /api/blog/run). Global gate just lets them reach it.
  '/api/notify',
];

/** True if `path` is on the public /api allow-list (prefix match on a path segment). */
export function isPublicApi(path: string): boolean {
  return PUBLIC_API_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
}

/**
 * Decide what a request needs. Pure (path, method) — no env, no side effects.
 * Mirrors the exact matrix that lived in index.ts so behavior is preserved.
 */
export function evaluateGate(path: string, method: string): GateDecision {
  const isAdminPage = path.startsWith('/admin');

  // Public exceptions inside otherwise-gated prefixes.
  const isAcopioReport = method === 'POST' && path === '/api/acopio/report';
  const isEmergenciaShare = method === 'POST' && /^\/api\/emergencia\/[^/]+\/share$/.test(path);

  const isAdminWrite = !isAcopioReport && !isEmergenciaShare &&
    WRITE_METHODS.has(method) && ADMIN_WRITE_PREFIXES.some((p) => path.startsWith(p));

  const isReportModeration =
    (path.startsWith('/api/reports') && (method === 'PATCH' || method === 'DELETE')) ||
    path === '/api/reports/queue';

  const isPersonModeration =
    path === '/api/persons/queue' ||
    path === '/api/persons/docket/queue' ||
    (path.startsWith('/api/persons/') && method === 'PATCH') ||
    path.endsWith('/approve') || path.endsWith('/reject') || path.endsWith('/localizar');

  const isDocketSubmit = method === 'POST' && /^\/api\/persons\/[^/]+\/docket$/.test(path);

  // Per-case operator surfaces (evidence, tasks, investigation leads, identity
  // verification, …). NOTE: POST /api/persons/:id/tip is deliberately NOT here —
  // it is the PUBLIC citizen-tip endpoint (rate-limited in its handler).
  const isCaseAdmin = /^\/api\/persons\/[^/]+\/(attachments|tasks|messages|victims|case|audit|evidence|intel|identity)(\/|$)/.test(path);

  const isSosTriage =
    (path === '/api/sos' && method === 'GET') ||
    (path.startsWith('/api/sos/') && method === 'PATCH');

  const isDamageReview = (path === '/api/damage' && method === 'GET') || path.startsWith('/api/damage/photo/');
  const isManualRefresh = path === '/api/events/refresh';
  const isShelterModeration = path === '/api/shelters/queue';
  const isSatWrite = WRITE_METHODS.has(method) && path.startsWith('/api/sat/') && path !== '/api/sat/pytorch-results';
  const isAcopioReview = method === 'GET' && path === '/api/acopio/submissions';
  const isFlotaApi = path.startsWith('/api/flota');
  const isFlotaAdminApi = path.startsWith('/api/admin/flota');
  // SUMINISTROS division is gated end-to-end (staff-only, not publicly open): the
  // SPA page AND its read APIs require suministros:read, not just writes.
  const isSuministrosPage = path === '/suministros' || path.startsWith('/suministros/');
  const isSuministrosRead = method === 'GET' && path.startsWith('/api/suministros/');

  const gated = isAdminPage || isAdminWrite || isReportModeration || isPersonModeration ||
    isDocketSubmit || isCaseAdmin || isSosTriage || isDamageReview || isManualRefresh ||
    isShelterModeration || isSatWrite || isAcopioReview || isFlotaApi || isFlotaAdminApi ||
    isSuministrosPage || isSuministrosRead;

  if (!gated) {
    // M1 default-deny: an un-gated /api route must be on the public allow-list,
    // else it fails closed (403). Non-/api paths (static pages, public HTML) are
    // unaffected and stay open.
    if (path.startsWith('/api') && !isPublicApi(path)) return { kind: 'deny' };
    return { kind: 'open' };
  }
  if (isAdminPage) return { kind: 'page' };          // gated, but HTML → login redirect on fail
  if (isSuministrosPage) return { kind: 'page', perm: 'suministros:read' }; // SPA shell → login redirect
  if (isSuministrosRead) return { kind: 'perm', perm: 'suministros:read' }; // read APIs
  if (isDocketSubmit) return { kind: 'login' };       // any logged-in user (citizen updates land 'pending')

  // Phase 2 R1: map each surface to its FINE-GRAINED permission (replaces the coarse
  // ops:console). Order matters — most specific prefix first. Every perm here is held
  // by the legacy operator role (and super_admin), so access is preserved 1:1; new
  // granular roles can now be granted exactly one surface.
  let perm: string;
  if (isFlotaAdminApi) perm = 'flota:track';
  // SECURITY (audit H1): flota GET is flota:read, but unsafe methods (dispatch/delete a
  // unit, create/edit a mission) require the WRITE capability flota:dispatch — which
  // read_only/auditor roles do NOT hold. Previously ALL flota mapped to flota:read,
  // letting a read-only auditor mutate and dispatch the live emergency fleet.
  else if (isFlotaApi) perm = WRITE_METHODS.has(method) ? 'flota:dispatch' : 'flota:read';
  else if (isCaseAdmin || isPersonModeration) perm = 'persons:moderate';
  else if (isReportModeration) perm = 'reports:moderate';
  else if (isSosTriage) perm = 'sos:triage';
  else if (isDamageReview) perm = 'damage:moderate';
  else if (isManualRefresh) perm = 'events:refresh';
  else if (isShelterModeration) perm = 'shelters:manage';
  else if (isSatWrite) perm = 'sat:analyze';
  else if (isAcopioReview) perm = 'acopio:manage';
  // SUMINISTROS per-area least-privilege (kept from main): each inventory write
  // requires its function-area permission (warehouse/dispatch/inventory/purchasing),
  // finer than the coarse suministros:manage.
  else if (isAdminWrite && path.startsWith('/api/suministros/')) perm = suministrosAreaPerm(path);
  else perm = adminWritePermFor(path);  // other isAdminWrite → per-prefix permission
  return { kind: 'perm', perm };
}

/** Fine-grained permission for a write under one of the ADMIN_WRITE_PREFIXES. */
function adminWritePermFor(path: string): string {
  if (path.startsWith('/api/admin/flota')) return 'flota:track';
  if (path.startsWith('/api/admin')) return 'admin:maintenance';
  if (path.startsWith('/api/contacts')) return 'contacts:manage';
  if (path.startsWith('/api/resources')) return 'resources:manage';
  if (path.startsWith('/api/acopio')) return 'acopio:manage';
  if (path.startsWith('/api/danos-estructurales')) return 'damage:moderate';
  if (path.startsWith('/api/aid-orgs')) return 'aid_orgs:manage';
  if (path.startsWith('/api/refugios')) return 'refugios:manage';
  // Casualty ledger manual entry → admin:maintenance (held by operator + super_admin),
  // so no new permission/role mapping is introduced (route-policy backward-compat test).
  if (path.startsWith('/api/casualties')) return 'admin:maintenance';
  if (path.startsWith('/api/emergencia')) return 'emergencia:manage';
  if (path.startsWith('/api/suministros')) return 'suministros:manage';
  if (path.startsWith('/api/flota')) return 'flota:read';
  return 'admin:maintenance'; // safe default (operator + super_admin hold it)
}

/** Map a /api/suministros write path to the area permission it requires. */
function suministrosAreaPerm(path: string): string {
  const p = path;
  if (p.startsWith('/api/suministros/movimientos/recepcion') ||
      p.startsWith('/api/suministros/movimientos/traslado') ||
      p.startsWith('/api/suministros/requisiciones')) return 'suministros:warehouse';
  if (p.startsWith('/api/suministros/movimientos/despacho') ||
      p.startsWith('/api/suministros/picklists') ||
      p.startsWith('/api/suministros/envios') ||
      p.startsWith('/api/suministros/metodos-envio')) return 'suministros:dispatch';
  if (p.startsWith('/api/suministros/movimientos/ajuste') ||
      p.startsWith('/api/suministros/movimientos/conteo') ||
      p.startsWith('/api/suministros/conteos')) return 'suministros:inventory';
  if (p.startsWith('/api/suministros/proveedores') ||
      p.startsWith('/api/suministros/ordenes') ||
      p.startsWith('/api/suministros/donaciones') ||
      p.startsWith('/api/suministros/facturas') ||
      p.startsWith('/api/suministros/cuentas')) return 'suministros:purchasing';
  // Catalog/config (ubicaciones, categorías, productos) + anything else → manage.
  return 'suministros:manage';
}

export { WRITE_METHODS };
