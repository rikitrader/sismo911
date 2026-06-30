// src/lib/canonical-casualties.ts
//
// SINGLE SOURCE OF TRUTH for the headline earthquake casualty balance
// (fallecidos / heridos) shown across the WHOLE site and stored in D1.
//
// Product decision (2026-06-30): the canonical headline figures are the LATEST
// AI-extraction rows in casualty_reports (source_key='ai_extract') — the model
// reading the continuously-updated, news-aggregating event summary. Every
// single-number surface (the /casos "Balance Oficial" banner, the /terremotos
// dashboard, /informacion-verificada) reads THROUGH here, so two pages can never
// disagree. /victimas keeps its by-source min–max RANGE view (a deliberate
// multi-source breakdown, not a single headline).
//
// We surface value_min as the single number (the confirmed floor — matches how a
// single "cifra" is presented; the full min–max range stays on /victimas).

import type { Env } from '../types';

export const CANON_EVENT_ID = 've-eq-2026-06-24';

// Honest provenance label: AI-extracted from international-media aggregation,
// preliminary and still updating. Never claims to be a final government count.
export const CANON_SOURCE =
  'Cifra preliminar consolidada (extracción IA · fuentes internacionales) — en actualización';

export interface CanonCasualties {
  fallecidos: number | null;
  heridos: number | null;
  as_of: string | null;
  citation: string | null;
}

/** Latest AI-extract dead/injured (the canonical headline balance). */
export async function getCanonicalCasualties(env: Env): Promise<CanonCasualties> {
  const rows = (await env.DB.prepare(
    `SELECT cr.metric, cr.value_min, cr.as_of_ms, cr.citation_url
       FROM casualty_reports cr
      WHERE cr.source_key = 'ai_extract' AND cr.event_id = ? AND cr.metric IN ('dead','injured')
        AND cr.as_of_ms = (SELECT MAX(as_of_ms) FROM casualty_reports
                            WHERE source_key = 'ai_extract' AND event_id = cr.event_id AND metric = cr.metric)`,
  ).bind(CANON_EVENT_ID).all<any>().catch(() => ({ results: [] }))).results ?? [];
  const dead = rows.find((r) => r.metric === 'dead');
  const injured = rows.find((r) => r.metric === 'injured');
  const asOfMs = Math.max(Number(dead?.as_of_ms) || 0, Number(injured?.as_of_ms) || 0);
  return {
    fallecidos: dead ? Number(dead.value_min) : null,
    heridos: injured ? Number(injured.value_min) : null,
    as_of: asOfMs ? new Date(asOfMs).toISOString() : null,
    citation: (injured?.citation_url || dead?.citation_url) ?? null,
  };
}

/**
 * Overlay the canonical headline onto a stored official_stats row so every
 * endpoint returns the SAME fallecidos/heridos regardless of when the row was
 * last synced (zero display lag). refugiados/desaparecidos and the rest of the
 * row are left untouched. Returns the row unchanged when no AI figure exists yet.
 */
export function applyCanonical<T extends Record<string, any> | null>(
  row: T,
  canon: CanonCasualties,
): T {
  if (canon.fallecidos == null && canon.heridos == null) return row;
  const base: any = row ?? { id: 1, refugiados: null, desaparecidos: null };
  if (canon.fallecidos != null) base.fallecidos = canon.fallecidos;
  if (canon.heridos != null) base.heridos = canon.heridos;
  base.source = CANON_SOURCE;
  base.origen = 'ai_extract';
  if (canon.as_of) base.updated_at = canon.as_of;
  base.citation = canon.citation;
  return base as T;
}

/**
 * Persist the canonical headline into official_stats id=1 so the DB ROW itself
 * is standardized (not just the API responses). Called by the hourly casualty
 * cron right after fresh AI figures land. Preserves refugiados/desaparecidos.
 */
export async function syncOfficialStats(env: Env): Promise<boolean> {
  const canon = await getCanonicalCasualties(env);
  if (canon.fallecidos == null && canon.heridos == null) return false;
  const nowIso = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO official_stats (id, fallecidos, heridos, refugiados, desaparecidos, source, origen, updated_at, pulled_at)
       VALUES (1, ?, ?, NULL, NULL, ?, 'ai_extract', ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       fallecidos = COALESCE(excluded.fallecidos, official_stats.fallecidos),
       heridos    = COALESCE(excluded.heridos, official_stats.heridos),
       source     = excluded.source,
       origen     = 'ai_extract',
       updated_at = excluded.updated_at,
       pulled_at  = excluded.pulled_at`,
  ).bind(canon.fallecidos, canon.heridos, CANON_SOURCE, canon.as_of ?? nowIso, nowIso).run().catch(() => {});
  return true;
}
