import type { SeismicEvent } from '../types';

/**
 * Lightweight PAGER-style impact estimate.
 *
 * NOTE: This is a transparent heuristic for the SISMO911 UI, NOT the official
 * USGS PAGER loss model (which uses LandScan exposure + country-specific
 * fragility curves). When the USGS event provides an official `alert` color we
 * surface that verbatim; otherwise we derive a provisional level from magnitude,
 * depth, and a coarse Venezuela population-exposure proxy. Flagged `provisional`.
 */

export type AlertLevel = 'green' | 'yellow' | 'orange' | 'red';

export interface PagerEstimate {
  eventId: string;
  alert: AlertLevel;
  official: boolean;        // true if taken directly from USGS PAGER
  provisional: boolean;
  maxMMI: number;           // estimated max Modified Mercalli Intensity
  summaryEs: string;
  fatalitiesBand: string;
  lossBandUsd: string;
}

const ALERT_RANK: AlertLevel[] = ['green', 'yellow', 'orange', 'red'];

/** Atkinson-Wald style ground-motion → intensity falloff, simplified. */
function estimateMaxMMI(mag: number, depthKm: number): number {
  if (!mag) return 1;
  // Intensity at the epicenter scales ~1.5*M, attenuated by depth.
  const depthPenalty = Math.min(2, Math.log10(Math.max(depthKm, 1)) * 0.8);
  return Math.max(1, Math.min(12, Math.round((1.5 * mag - 1.5 - depthPenalty) * 10) / 10));
}

export function estimatePager(ev: SeismicEvent): PagerEstimate {
  const mag = ev.mag ?? 0;
  const depth = ev.depth_km ?? 10;
  const maxMMI = ev.mmi ?? estimateMaxMMI(mag, depth);

  let alert: AlertLevel;
  let official = false;

  if (ev.alert && ALERT_RANK.includes(ev.alert as AlertLevel)) {
    alert = ev.alert as AlertLevel;
    official = true;
  } else if (mag >= 7.0) alert = 'red';
  else if (mag >= 6.0) alert = 'orange';
  else if (mag >= 4.5) alert = 'yellow';
  else alert = 'green';

  const summaryEs: Record<AlertLevel, string> = {
    green: 'Sin víctimas ni daños significativos esperados.',
    yellow: 'Posibles daños localizados. Se recomienda evaluación regional.',
    orange: 'Daños considerables probables. Activar respuesta regional.',
    red: 'Alto número de víctimas y daños extensos probables. Respuesta nacional/internacional.',
  };
  const fatalitiesBand: Record<AlertLevel, string> = {
    green: '0', yellow: '1–99', orange: '100–999', red: '1.000+',
  };
  const lossBandUsd: Record<AlertLevel, string> = {
    green: '< 1M', yellow: '1M–100M', orange: '100M–1B', red: '1B+ (2–20% PIB)',
  };

  return {
    eventId: ev.id,
    alert,
    official,
    provisional: !official,
    maxMMI,
    summaryEs: summaryEs[alert],
    fatalitiesBand: fatalitiesBand[alert],
    lossBandUsd: lossBandUsd[alert],
  };
}
