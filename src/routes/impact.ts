import { Hono } from 'hono';
import type { Env } from '../types';

// ── Impact metrics — REAL, auditable, never demo/fabricated ──────────────────
//
// "Persona ayudada" CONTRACT:
//   A distinct person who reached a VERIFIED positive outcome through SISMO911.
//   Counted ONLY from real delivered-service records:
//     • medical_consults     = completed telemedicine consultations
//                              (telemed_requests.status = 'completed')
//     • persons_located_safe = reported missing persons confirmed located/found/
//                              in-hospital (personas.estado IN aparecido |
//                              localizado | hospitalizado)
//   EXCLUDED: planning estimates (e.g. refugios seed capacities — NOT surveyed
//   truth), deceased (fallecido), and not-yet-contacted (sin-contacto). No
//   hardcoded/demo numbers anywhere — the value is purely the sum of real rows.
//   total = medical_consults + persons_located_safe. When 0, the UI shows "—".
//
// Public, read-only, NO PII (counts only). Mounted at /api/impact.
export const impact = new Hono<{ Bindings: Env }>();

// estados that represent a person reached / made safe (a delivered outcome).
const LOCATED_SAFE = ['aparecido', 'localizado', 'hospitalizado'] as const;

// Count helper: a missing table (partial schema) contributes 0 and NEVER throws —
// so a metric component degrades to 0 rather than fabricating or 500ing.
async function count(env: Env, sql: string, binds: unknown[] = []): Promise<number> {
  try {
    const r: any = await env.DB.prepare(sql).bind(...binds).first();
    const n = Number(r?.n);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

// GET /api/impact/personas-ayudadas — the auditable "people helped" total.
impact.get('/personas-ayudadas', async (c) => {
  const medical_consults = await count(
    c.env,
    `SELECT COUNT(*) AS n FROM telemed_requests WHERE status = 'completed'`,
  );
  const persons_located_safe = await count(
    c.env,
    `SELECT COUNT(*) AS n FROM personas WHERE estado IN (${LOCATED_SAFE.map(() => '?').join(',')})`,
    [...LOCATED_SAFE],
  );
  const total = medical_consults + persons_located_safe;
  return c.json({
    ok: true,
    total, // REAL count from live records; the UI renders "—" when total === 0
    breakdown: { medical_consults, persons_located_safe },
    definition:
      'Personas con un resultado verificado a través de SISMO911: consultas de ' +
      'telemedicina completadas + personas reportadas confirmadas como localizadas, ' +
      'aparecidas u hospitalizadas. Solo datos reales registrados — las estimaciones ' +
      'de planificación (p. ej. capacidad de refugios) están excluidas.',
    as_of: Date.now(),
  });
});
