import { Hono, type Context } from 'hono';
import type { Env } from '../types';
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
import { authenticateApiClient, type Scope } from '../lib/apikey';

// ===========================================================================
// SISMO911 MCP server — Streamable HTTP transport (stateless), JSON-RPC 2.0.
//
// One endpoint, POST /mcp, exposing SISMO911's datasets as MCP tools so any
// MCP-capable client (IDEs, agents) can read Venezuela's seismic data, shelters,
// news, stats and the approved missing-persons registry.
//
// GATED: `tools/list` and `tools/call` require an APPROVED API key+secret — the
// same credentials as /api/v1 (Authorization: Bearer <key>:<secret>, or
// X-API-Key + X-API-Secret headers). Each tool maps to a scope. `initialize`,
// `ping` and notifications stay open so a client can complete the handshake.
// Onboard at POST /api/v1/register → operator approval in /admin.
//
// Spec ref: modelcontextprotocol — Streamable HTTP. We respond with
// application/json (no SSE) and require no session id (stateless).
// ===========================================================================

export const mcp = new Hono<{ Bindings: Env }>();

// Each tool requires this scope on the caller's APPROVED key.
const TOOL_SCOPES: Record<string, Scope> = {
  list_earthquakes: 'read:earthquakes',
  get_earthquake: 'read:earthquakes',
  latest_earthquakes: 'read:earthquakes',
  seismic_stats: 'read:stats',
  list_shelters: 'read:shelters',
  list_news: 'read:blog',
  search_missing_persons: 'read:missing-persons',
};

const SERVER_INFO = { name: 'sismo911', title: 'SISMO911 — Datos sísmicos de Venezuela', version: '1.0.0' };
const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL = '2025-06-18';

type JsonRpcId = string | number | null;
interface JsonRpcReq {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: any;
}

const ok = (id: JsonRpcId, result: unknown) => ({ jsonrpc: '2.0', id, result });
const err = (id: JsonRpcId, code: number, message: string, data?: unknown) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});

// --- tool catalog -----------------------------------------------------------
const TOOLS = [
  {
    name: 'list_earthquakes',
    description:
      'Lista sismos registrados (acumulación del feed de USGS, filtrado a Venezuela). Filtros opcionales por magnitud mínima, rango de fechas y lugar.',
    inputSchema: {
      type: 'object',
      properties: {
        minMag: { type: 'number', description: 'Magnitud mínima (ej. 4.0)' },
        from: { type: 'string', description: 'Fecha desde, YYYY-MM-DD' },
        to: { type: 'string', description: 'Fecha hasta, YYYY-MM-DD' },
        q: { type: 'string', description: 'Texto en el nombre del lugar' },
        page: { type: 'number', description: 'Página (1+)' },
        pageSize: { type: 'number', description: 'Tamaño de página (1-100)' },
      },
    },
  },
  {
    name: 'get_earthquake',
    description: 'Obtiene un sismo por su id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'latest_earthquakes',
    description: 'Sismos más recientes junto con el nivel de amenaza actual calculado.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: '1-100 (def. 20)' } } },
  },
  {
    name: 'seismic_stats',
    description: 'Estadísticas sísmicas agregadas: total, magnitud máxima, conteos últimas 24h/7d/30d y amenaza actual.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_shelters',
    description: 'Albergues / refugios con estado reportado y aprobado (activo, lleno, cerrado).',
    inputSchema: {
      type: 'object',
      properties: { page: { type: 'number' }, pageSize: { type: 'number', description: '1-100' } },
    },
  },
  {
    name: 'list_news',
    description: 'Noticias / reportes de campo publicados (blog SISMO911) sobre el evento sísmico.',
    inputSchema: {
      type: 'object',
      properties: { page: { type: 'number' }, pageSize: { type: 'number', description: '1-100' } },
    },
  },
  {
    name: 'search_missing_persons',
    description:
      'Busca en el registro de personas desaparecidas (solo registros aprobados/públicos; sin datos de contacto). Útil para reunificación familiar.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Nombre o ubicación' },
        page: { type: 'number' },
        pageSize: { type: 'number', description: '1-100' },
      },
    },
  },
] as const;

// --- tool dispatch ----------------------------------------------------------
async function callTool(env: Env, name: string, args: any): Promise<{ data: unknown; summary: string }> {
  const a = args ?? {};
  switch (name) {
    case 'list_earthquakes': {
      const out = await queryEarthquakes(
        env,
        { minMag: a.minMag, from: a.from, to: a.to, q: a.q },
        clampPage(a.page, a.pageSize)
      );
      return { data: out, summary: `${out.total} sismos (página ${out.page}/${out.totalPages}).` };
    }
    case 'get_earthquake': {
      if (!a.id) throw new Error('Falta el parámetro "id".');
      const ev = await getEarthquake(env, String(a.id));
      if (!ev) throw new Error(`No se encontró el sismo "${a.id}".`);
      return { data: { earthquake: ev }, summary: `Sismo ${a.id}.` };
    }
    case 'latest_earthquakes': {
      const out = await latestSeismic(env, Number(a.limit ?? 20));
      return { data: out, summary: `${out.events.length} sismos recientes; amenaza: ${out.threat?.level ?? 'n/d'}.` };
    }
    case 'seismic_stats': {
      const out = await seismicStats(env);
      return { data: out, summary: `Total ${out.total_events}; últimas 24h: ${out.last_24h}; mag máx: ${out.max_magnitude ?? 'n/d'}.` };
    }
    case 'list_shelters': {
      const out = await queryShelters(env, clampPage(a.page, a.pageSize));
      return { data: out, summary: `${out.total} albergues aprobados.` };
    }
    case 'list_news': {
      const out = await queryBlog(env, clampPage(a.page, a.pageSize));
      return { data: out, summary: `${out.total} noticias publicadas.` };
    }
    case 'search_missing_persons': {
      const out = await queryMissingPersons(env, clampPage(a.page, a.pageSize), a.q);
      return { data: out, summary: `${out.total} personas (registros aprobados).` };
    }
    default:
      throw new Error(`Herramienta desconocida: ${name}`);
  }
}

// Auth gate for the data-bearing MCP methods. Returns null on success, or a
// JSON-RPC error object (code -32001) to short-circuit. `scope` undefined →
// only an APPROVED key is required (used by tools/list).
async function mcpAuth(
  c: Context<{ Bindings: Env }>,
  id: JsonRpcId,
  endpoint: string,
  scope?: Scope
): Promise<object | null> {
  const r = await authenticateApiClient(c, scope ? { scope, endpoint } : { endpoint });
  if (r.ok) return null;
  return err(id, -32001, `unauthorized: ${r.error}`, {
    hint: r.hint ?? 'Regístrate en POST /api/v1/register y espera la aprobación de un operador, luego envía Authorization: Bearer <key>:<secret>.',
    status: r.status,
  });
}

// --- JSON-RPC message handler ----------------------------------------------
// Returns the response object, or null for notifications (no id → 202, no body).
async function handleMessage(c: Context<{ Bindings: Env }>, msg: JsonRpcReq): Promise<object | null> {
  const id = msg?.id ?? null;
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return err(id, -32600, 'Invalid Request');
  }
  // Notifications (no id) — e.g. notifications/initialized. Acknowledge silently.
  if (msg.id === undefined) {
    return null;
  }

  switch (msg.method) {
    case 'initialize': {
      const reqVer = msg.params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(reqVer) ? reqVer : DEFAULT_PROTOCOL;
      return ok(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'Datos sísmicos y de emergencia de Venezuela (SISMO911). Herramientas de solo lectura (requieren clave aprobada): sismos, albergues, noticias, estadísticas y personas desaparecidas (aprobadas). Regístrate en /api/v1/register.',
      });
    }
    case 'ping':
      return ok(id, {});
    case 'tools/list': {
      const denied = await mcpAuth(c, id, 'mcp:tools/list');
      if (denied) return denied;
      return ok(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const name = msg.params?.name;
      if (!name) return err(id, -32602, 'Invalid params: falta "name"');
      const denied = await mcpAuth(c, id, `mcp:${name}`, TOOL_SCOPES[name]);
      if (denied) return denied;
      try {
        const { data, summary } = await callTool(c.env, name, msg.params?.arguments);
        return ok(id, {
          content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
          structuredContent: data as Record<string, unknown>,
          isError: false,
        });
      } catch (e: any) {
        // Tool execution error → reported inside result (isError), per MCP spec.
        return ok(id, { content: [{ type: 'text', text: String(e?.message ?? e) }], isError: true });
      }
    }
    case 'resources/list':
      return ok(id, { resources: [] });
    case 'prompts/list':
      return ok(id, { prompts: [] });
    default:
      return err(id, -32601, `Method not found: ${msg.method}`);
  }
}

// POST /mcp — single JSON-RPC message or a batch array.
mcp.post('/', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json(err(null, -32700, 'Parse error'), 400);
  }

  if (Array.isArray(body)) {
    const out: object[] = [];
    for (const m of body) {
      const r = await handleMessage(c, m);
      if (r) out.push(r);
    }
    return out.length ? c.json(out) : new Response(null, { status: 202 });
  }

  const r = await handleMessage(c, body);
  if (!r) return new Response(null, { status: 202 }); // notification → no body
  return c.json(r);
});

// GET/DELETE /mcp — stateless server offers no SSE stream and keeps no session.
mcp.get('/', (c) => c.json(err(null, -32601, 'SSE stream no soportado (servidor stateless). Usa POST.'), 405));
mcp.delete('/', (c) => c.body(null, 405));
