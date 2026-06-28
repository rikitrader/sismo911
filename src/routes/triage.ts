import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { burstLimit, validLatLon } from '../lib/security';
import { sanitizeHtml } from '../lib/sanitize';

// AI TRIAGE / INTAKE (/api/triage). Reads a free-text citizen message, classifies
// it with Workers AI into one of three existing modules — DESAPARECIDOS (personas),
// MASCOTAS (rav_reports) or DAÑOS (map_reports) — extracts the fields, and inserts
// a record as PENDING so it flows through each module's existing review queue + map.
// Public + burst-limited; never auto-approves; never fabricates fields.
export const triage = new Hono<{ Bindings: Env }>();

const TRIAGE_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const SYS = `Eres un clasificador de reportes de emergencia sísmica en Venezuela.
Lee el mensaje del ciudadano y decide a cuál módulo pertenece y extrae los datos.
Responde ÚNICAMENTE un objeto JSON válido (sin texto adicional, sin markdown):
{
 "category": "desaparecido" | "mascota" | "dano" | "ninguno",
 "confidence": 0.0-1.0,
 "fields": {
   "nombre": "",            // persona o mascota
   "edad": null,             // entero o null (solo persona)
   "tipo": "",              // mascota: perro|gato|otro | daño: edificio_danado|edificio_colapsado|personas_atrapadas|fuga_gas|necesidad_medica|otro
   "estado": "",            // mascota: perdido|encontrado
   "severidad": "",         // daño: critica|alta|media|baja
   "personas_atrapadas": null, // entero o null (daño)
   "ubicacion": "",         // zona/parroquia/municipio/dirección aproximada
   "descripcion": "",       // resumen breve
   "contacto": ""           // teléfono/correo si aparece
 }
}
Reglas: "desaparecido" = se busca a una PERSONA. "mascota" = se busca/encontró un ANIMAL.
"dano" = daño material, edificio, fuga, personas atrapadas, necesidad médica.
Si no es ninguno, category="ninguno". NO inventes datos: deja "" o null lo que no esté en el mensaje.`;

const s = (v: unknown, max = 500): string => (v == null ? '' : sanitizeHtml(String(v)).slice(0, max));
const intOrNull = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 100000 ? Math.floor(n) : null;
};

// daño tipo → map_reports.category enum; severidad → severity
const DANO_CAT: Record<string, string> = {
  edificio_danado: 'damaged_building', edificio_colapsado: 'collapsed_building',
  personas_atrapadas: 'trapped_people', fuga_gas: 'gas_leak', necesidad_medica: 'medical_need', otro: 'other',
};
const SEVERIDAD: Record<string, string> = { critica: 'rojo', alta: 'naranja', media: 'amarillo', baja: 'amarillo' };

function parseJson(text: string): any {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

// Workers AI JSON mode schema — forces a structured, parseable response.
const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: ['desaparecido', 'mascota', 'dano', 'ninguno'] },
    confidence: { type: 'number' },
    fields: {
      type: 'object',
      properties: {
        nombre: { type: 'string' }, edad: { type: ['integer', 'null'] },
        tipo: { type: 'string' }, estado: { type: 'string' }, severidad: { type: 'string' },
        personas_atrapadas: { type: ['integer', 'null'] },
        ubicacion: { type: 'string' }, descripcion: { type: 'string' }, contacto: { type: 'string' },
      },
    },
  },
  required: ['category'],
};

// Deterministic fallback so obvious reports file even if the model wavers.
function kwCat(text: string): string {
  const t = text.toLowerCase();
  if (/(edificio|colaps|derrumb|agriet|grieta|fuga de gas|atrapad|escombro|se cay[oó]|da[ñn]o)/.test(t)) return 'dano';
  if (/(perro|perra|gato|gata|mascota|cachorr|labrador|michi|felino|loro|ave)\b/.test(t)) return 'mascota';
  if (/(busco a|desaparec|no aparece|se busca a|perdi[oó]? a mi (herman|hij|madre|padre|espos|t[ií]o|abuel|primo|sobrin|familiar)|mi (herman|hij|madre|padre|espos))/.test(t)) return 'desaparecido';
  return 'ninguno';
}

triage.post('/', async (c) => {
  const burst = await burstLimit(c.env, c, 'triage', 20, 60);
  if (burst) return burst;

  const body = await c.req.json().catch(() => null);
  const message = s(body?.message, 2000);
  if (!message || message.length < 4) return c.json({ error: 'mensaje_requerido' }, 400);
  const contactoIn = s(body?.contacto, 160);
  const lat = body?.lat == null ? null : Number(body.lat);
  const lon = body?.lon == null ? null : Number(body.lon);
  const geo = validLatLon(lat, lon) ? { lat, lon } : { lat: null, lon: null };

  // 1) classify + extract with Workers AI
  if (!c.env.AI) return c.json({ error: 'ia_no_disponible' }, 503);
  let parsed: any = null;
  try {
    const out: any = await c.env.AI.run(TRIAGE_MODEL, {
      messages: [{ role: 'system', content: SYS }, { role: 'user', content: message }],
      response_format: { type: 'json_schema', json_schema: TRIAGE_SCHEMA },
    } as any);
    const r = out?.response ?? out?.result?.response;
    parsed = r && typeof r === 'object' ? r : parseJson(String(r ?? ''));
  } catch {
    parsed = null; // fall back to the keyword classifier below
  }

  const f = (parsed && parsed.fields) || {};
  let category = String(parsed?.category ?? '').toLowerCase();
  if (!['desaparecido', 'mascota', 'dano'].includes(category)) category = kwCat(message);
  const now = Date.now();
  const descripcion = s(f.descripcion, 1000) || message;
  const ubicacion = s(f.ubicacion, 200);
  const contacto = contactoIn || s(f.contacto, 160);

  // 2) route the insert (always PENDING → existing moderation/review)
  if (category === 'desaparecido') {
    const id = uid('pc');
    const nombre = s(f.nombre, 140) || 'Persona sin identificar';
    await c.env.DB.prepare(
      `INSERT INTO personas (id, nombre, edad, ubicacion, descripcion, contacto, foto_r2, estado, moderation, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?, 'sin-contacto', 'pending', ?, ?)`,
    ).bind(id, nombre, intOrNull(f.edad), ubicacion, descripcion, contacto, '', now, now).run();
    return c.json({ ok: true, category: 'desaparecido', module: 'Desaparecidos', id, status: 'pending',
      fields: { nombre, edad: intOrNull(f.edad), ubicacion, contacto },
      message: `Registré un reporte de persona desaparecida (${nombre}). Aparecerá en /personas tras la revisión de un operador.` }, 201);
  }

  if (category === 'mascota') {
    const id = uid('sismo');
    const tipo = s(f.tipo, 40) || 'mascota';
    const estado = s(f.estado, 40) || 'perdido';
    const nombre = s(f.nombre, 80);
    const title = `${tipo}${nombre ? ' ' + nombre : ''} ${estado}`.trim().slice(0, 160);
    const nowIso = new Date(now).toISOString();
    await c.env.DB.prepare(
      `INSERT INTO rav_reports (id, kind, category, title, description, city, state, area, lat, lng, contact, status, photo_url, photo_r2, meta, tags, origen, created_at, synced_at, pulled_at, case_status, moderation, reports_count)
       VALUES (?, 'mascota', ?, ?, ?, '', '', ?, ?, ?, ?, 'activo', '', '', '{}', '["sismo911","triage"]', 'sismo911', ?, ?, ?, ?, 'pending', 0)`,
    ).bind(id, estado, title, descripcion, ubicacion, geo.lat, geo.lon, contacto, nowIso, nowIso, nowIso, estado).run();
    return c.json({ ok: true, category: 'mascota', module: 'Mascotas', id, status: 'pending',
      fields: { tipo, estado, nombre, ubicacion, contacto },
      message: `Registré un reporte de mascota (${title}). Aparecerá en /mascotas tras la revisión.` }, 201);
  }

  if (category === 'dano') {
    const id = uid('rep');
    const tipo = s(f.tipo, 40);
    const mapCat = DANO_CAT[tipo] ?? 'other';
    const severity = SEVERIDAD[s(f.severidad, 20)] ?? null;
    const title = (descripcion.split(/[.\n]/)[0] || 'Reporte de daño').slice(0, 120);
    await c.env.DB.prepare(
      `INSERT INTO map_reports (id, category, severity, status, verification, title, description, lat, lon, estado, municipio, parroquia, building_type, people_trapped, source, reporter, created_ms, updated_ms)
       VALUES (?, ?, ?, 'pending', 'unverified', ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'citizen', ?, ?, ?)`,
    ).bind(id, mapCat, severity, title, descripcion, geo.lat, geo.lon, ubicacion, null, null, intOrNull(f.personas_atrapadas), contacto || null, now, now).run();
    return c.json({ ok: true, category: 'dano', module: 'Daños', id, status: 'pending',
      fields: { tipo: mapCat, severity, ubicacion, personas_atrapadas: intOrNull(f.personas_atrapadas) },
      message: `Registré un reporte de daño (${mapCat}). Aparecerá en el mapa de reportes tras la revisión.` }, 201);
  }

  // 3) not a report
  return c.json({ ok: true, category: 'ninguno',
    message: 'No parece un reporte de persona, mascota o daño. Si quieres reportar algo, descríbelo (qué pasó, dónde y a quién/qué afecta).' });
});
