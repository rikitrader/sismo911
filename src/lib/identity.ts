/**
 * Identity verification against Venezuelan institutions for the case file.
 *
 * Honest by design: a Cloudflare Worker can't drive a browser, and the only
 * institution we can actually reach is CNE (padrón electoral) — and only via an
 * EXTERNAL resolver service (real Chrome) that we call over HTTPS. RIF (SENIAT)
 * is geo-blocked to Venezuela + CAPTCHA; SAIME/IVSS expose no public API. So
 * each source reports its true live status, and we never fake a lookup.
 *
 * All of this is OPERATOR-ONLY: the cédula and any returned record never reach
 * the public — the public sees only a derived "identity verified" badge.
 */
import type { Env } from '../types';

export type IdentitySource = 'cne' | 'rif' | 'saime' | 'ivss' | 'manual';
export type VerifyResult = 'match' | 'no_match' | 'partial' | 'unavailable' | 'pending';

export interface SourceStatus {
  key: IdentitySource;
  label: string;
  available: boolean;
  reason: string;
}

export interface VerifyOutcome {
  result: VerifyResult;
  matched_name?: string | null;
  detail?: Record<string, unknown> | null;
  reason?: string;
}

/** Live, honest status of every supported source (mirrors the /api/status pattern). */
export function identitySources(env: Env): SourceStatus[] {
  const cneOk = Boolean(env.CNE_RESOLVER_URL);
  return [
    { key: 'cne', label: 'CNE — Padrón Electoral', available: cneOk,
      reason: cneOk ? 'EN VIVO — resolución cédula→nombre+centro vía servicio externo' : 'Requiere CNE_RESOLVER_URL (servicio Chrome externo)' },
    { key: 'rif', label: 'SENIAT — RIF', available: false,
      reason: 'Geobloqueado a Venezuela + CAPTCHA; requiere proxy residente en VE' },
    { key: 'saime', label: 'SAIME — Identificación/Migración', available: false,
      reason: 'Sin API pública; requiere convenio institucional' },
    { key: 'ivss', label: 'IVSS — Seguro Social', available: false,
      reason: 'Sin API pública; requiere convenio institucional' },
  ];
}

/** Normalize a Venezuelan cédula to bare digits (drops V-/E- prefix, dots, dashes). */
export function normalizeCedula(raw: string): string {
  return String(raw || '').replace(/[^0-9]/g, '');
}

/** Loose name-equality for cross-matching an institutional name against the case name. */
export function namesRoughlyMatch(a: string, b: string): boolean {
  const norm = (s: string) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const wa = new Set(norm(a).split(' ').filter(Boolean));
  const wb = new Set(norm(b).split(' ').filter(Boolean));
  if (!wa.size || !wb.size) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared >= 2 || shared === Math.min(wa.size, wb.size);
}

/**
 * Verify a cédula against one institution. Only CNE is wired to a real (external)
 * resolver; everything else returns 'unavailable' with the reason. Never throws.
 * `expectedName` (the case's full_name) lets us classify match/partial.
 */
export async function verifyCedula(
  env: Env, source: IdentitySource, cedula: string, expectedName?: string | null,
): Promise<VerifyOutcome> {
  const ced = normalizeCedula(cedula);
  if (!ced) return { result: 'unavailable', reason: 'cedula_invalida' };

  if (source === 'cne') {
    if (!env.CNE_RESOLVER_URL) return { result: 'unavailable', reason: 'resolver_no_configurado' };
    try {
      const r = await fetch(env.CNE_RESOLVER_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(env.CNE_RESOLVER_TOKEN ? { authorization: `Bearer ${env.CNE_RESOLVER_TOKEN}` } : {}),
        },
        body: JSON.stringify({ cedula: ced }),
      });
      if (!r.ok) return { result: 'unavailable', reason: `resolver_http_${r.status}` };
      const data: any = await r.json().catch(() => null);
      const name = data?.nombre || data?.name || null;
      if (!name) return { result: 'no_match', reason: 'no_encontrado' };
      const detail = { estado: data?.estado ?? null, municipio: data?.municipio ?? null, centro: data?.centro ?? null };
      const matched = expectedName ? (namesRoughlyMatch(expectedName, name) ? 'match' : 'partial') : 'match';
      return { result: matched, matched_name: name, detail };
    } catch (e: any) {
      return { result: 'unavailable', reason: 'resolver_error' };
    }
  }

  // rif / saime / ivss — no reachable source from a Worker.
  const s = identitySources(env).find((x) => x.key === source);
  return { result: 'unavailable', reason: s?.reason || 'fuente_no_disponible' };
}
