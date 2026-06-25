// Seismic threat-level engine. Scores a civil-protection "nivel de vigilancia"
// from the live USGS quakes (already filtered to the Venezuela bbox by the
// ingest). Drives the "Estado Actual" badge on the homepage/dashboard so it
// reflects reality (e.g. an active M7.5) instead of a hardcoded "Normal".

export interface ThreatLevel {
  level: 1 | 2 | 3 | 4;
  label: string;      // Spanish civil-protection label
  dot: string;        // tailwind bg-* class for the status dot
  reason: string;     // human explanation referencing the driving quake
  max_mag_48h: number | null;
  recent_6h: number;  // count of M>=3.5 in the last 6h (aftershock pressure)
  driver_id: string | null;
}

const H = 3_600_000;

function hoursAgo(now: number, ms: number): number {
  return Math.max(0, Math.round((now - ms) / H));
}

/** Score the current threat level from VE-bbox seismic events. */
export function scoreThreat(events: any[], now: number): ThreatLevel {
  const list = (events ?? []).filter((e) => typeof e?.mag === 'number' && typeof e?.time_ms === 'number');
  const within = (h: number) => list.filter((e) => e.time_ms >= now - h * H);
  const last48 = within(48);
  const last24 = within(24);
  const last6 = within(6);

  const strongest = (arr: any[]) =>
    arr.reduce((a, b) => (a && a.mag >= b.mag ? a : b), null as any);

  const driver48 = strongest(last48);
  const maxMag48 = driver48 ? driver48.mag : null;
  const maxMag24 = last24.length ? strongest(last24).mag : 0;
  const recent6 = last6.filter((e) => e.mag >= 3.5).length;
  const redFlag = last48.some((e) => e.alert === 'red' || e.mag >= 7);
  const strong6 = last6.some((e) => e.mag >= 6);

  const place = (e: any) => (e?.place ? String(e.place).replace(/^\d+\s*km\s+\w+\s+of\s+/i, '') : 'Venezuela');
  const drove = (e: any) => (e ? `M${e.mag} ${place(e)} hace ${hoursAgo(now, e.time_ms)} h` : 'actividad reciente');

  let level: ThreatLevel['level'];
  let label: string;
  let dot: string;
  let reason: string;

  if (redFlag || (maxMag48 != null && maxMag48 >= 6.5) || strong6) {
    level = 4; label = 'Alerta Máxima'; dot = 'bg-critical';
    reason = `Sismo mayor: ${drove(driver48)}${recent6 ? ` · ${recent6} réplicas en 6 h` : ''}`;
  } else if ((maxMag48 != null && maxMag48 >= 5.5) || maxMag24 >= 5 || recent6 >= 5) {
    level = 3; label = 'Alerta'; dot = 'bg-warning';
    reason = `Actividad fuerte: ${drove(driver48)}${recent6 ? ` · ${recent6} réplicas en 6 h` : ''}`;
  } else if (maxMag48 != null && maxMag48 >= 4.5) {
    level = 2; label = 'Atención'; dot = 'bg-advisory';
    reason = `Sismo moderado: ${drove(driver48)}`;
  } else {
    level = 1; label = 'Vigilancia Normal'; dot = 'bg-safe';
    reason = maxMag48 != null ? `Sin sismos significativos · máx M${maxMag48} en 48 h` : 'Sin sismos significativos en 48 h';
  }

  return { level, label, dot, reason, max_mag_48h: maxMag48, recent_6h: recent6, driver_id: driver48?.id ?? null };
}
