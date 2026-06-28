/**
 * Route → permission policy.
 *
 * This REPLACES the old inline `ADMIN_WRITE_PREFIXES` + the hardcoded
 * `role==='operator'||role==='admin'` decision in index.ts with a single,
 * centralized, pure mapping from (path, method) → required capability.
 *
 * Backward-compatibility contract (verified by test/route-policy.test.ts): the
 * surfaces gated here and the capability they require (`ops:console`, held by
 * exactly the legacy operator + super_admin roles) reproduce the previous gate
 * 1:1 — no existing user gains or loses access. Phase 1+ upgrades individual
 * surfaces to finer permissions (e.g. flota:dispatch) without touching index.ts.
 */

export const LEGACY_OPS_PERM = 'ops:console';

// Prefixes whose WRITE methods require operational access (moved out of index.ts).
export const ADMIN_WRITE_PREFIXES = [
  '/api/contacts', '/api/resources', '/api/acopio', '/api/danos-estructurales',
  '/api/admin', '/api/aid-orgs', '/api/emergencia', '/api/flota', '/api/suministros',
];

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export type GateDecision =
  | { kind: 'open' }                       // no auth required
  | { kind: 'login' }                      // any authenticated user
  | { kind: 'perm'; perm: string }         // requires this permission
  | { kind: 'page' };                      // admin HTML page (login redirect on fail)

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

  const isCaseAdmin = /^\/api\/persons\/[^/]+\/(attachments|tasks|messages|victims|case|audit)(\/|$)/.test(path);

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

  const gated = isAdminPage || isAdminWrite || isReportModeration || isPersonModeration ||
    isDocketSubmit || isCaseAdmin || isSosTriage || isDamageReview || isManualRefresh ||
    isShelterModeration || isSatWrite || isAcopioReview || isFlotaApi || isFlotaAdminApi;

  if (!gated) return { kind: 'open' };
  if (isAdminPage) return { kind: 'page' };          // gated, but HTML → login redirect on fail
  if (isDocketSubmit) return { kind: 'login' };       // any logged-in user (citizen updates land 'pending')

  // SUMINISTROS per-area least-privilege: each inventory write requires the
  // permission for its function area (warehouse/dispatch/inventory/purchasing),
  // not the coarse ops:console. Catalog/config writes (ubicaciones/categorías/
  // productos) require suministros:manage (managers/admins). Reads are open.
  if (isAdminWrite && path.startsWith('/api/suministros/')) {
    return { kind: 'perm', perm: suministrosAreaPerm(path) };
  }

  return { kind: 'perm', perm: LEGACY_OPS_PERM };
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
