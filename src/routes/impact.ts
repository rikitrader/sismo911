import { Hono } from 'hono';
import type { Env } from '../types';

// ── Impact metrics — REAL, auditable, never demo/fabricated ──────────────────
//
// "Persona ayudada" CONTRACT:
//   A distinct person who reached a positive outcome FACILITATED BY SISMO911 —
//   ONLY outcomes the platform itself recorded, NEVER pre-existing/imported data.
//     • medical_consults     = completed telemedicine consultations
//                              (telemed_requests.status = 'completed')
//     • persons_located_safe = reported missing persons an operator confirmed
//                              LOCATED THROUGH SISMO911 — the platform's
//                              /api/familia/:id/localizar flow stamps
//                              estado='localizado' + a non-empty localizado_nota.
//   ANTI-FABRICATION (critical): the `personas` table is an IMPORT from an
//   external dataset (desaparecidos-vzla). Its historical aparecido /
//   hospitalizado / localizado-without-note statuses are NOT SISMO911 outcomes
//   and MUST NOT count — only a present localizado_nota proves the platform
//   recorded the location. Also excluded: planning estimates (refugios seed),
//   deceased, not-yet-contacted. No hardcoded/demo numbers — the value is purely
//   the sum of real platform records. total = medical + located; 0 → UI "—".
//
// Public, read-only, NO PII (counts only). Mounted at /api/impact.
export const impact = new Hono<{ Bindings: Env }>();

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
  // ONLY persons located through the platform's operator-confirmed flow, proven
  // by a non-empty localizado_nota. This deliberately EXCLUDES the imported
  // registry's historical statuses (which are not SISMO911 outcomes).
  const persons_located_safe = await count(
    c.env,
    `SELECT COUNT(*) AS n FROM personas
       WHERE estado = 'localizado' AND localizado_nota IS NOT NULL AND TRIM(localizado_nota) <> ''`,
  );
  const total = medical_consults + persons_located_safe;
  return c.json({
    ok: true,
    total, // REAL count from platform records; the UI renders "—" when total === 0
    breakdown: { medical_consults, persons_located_safe },
    definition:
      'Personas con un resultado facilitado por SISMO911: consultas de telemedicina ' +
      'completadas + personas reportadas que un operador confirmó como localizadas a ' +
      'través de la plataforma. Excluye datos importados/históricos y estimaciones de ' +
      'planificación (p. ej. capacidad de refugios). Solo registros reales de la plataforma.',
    as_of: Date.now(),
  });
});
