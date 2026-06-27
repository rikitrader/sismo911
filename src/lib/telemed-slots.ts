// Pure scheduling helpers for telemedicine v2 — no I/O, unit-tested directly.
// All local times are America/Caracas (fixed UTC-4, no DST since 2016).

export const CARACAS_OFFSET = '-04:00';

export type ApptType = 'video' | 'followup' | 'urgent' | 'mental_health' | 'refill';

// Appointment types the patient can pick. `duration` drives slot length.
export const APPT_TYPES: Record<ApptType, { label: string; duration: number; icon: string }> = {
  video: { label: 'Videoconsulta', duration: 30, icon: '🎥' },
  followup: { label: 'Consulta de seguimiento', duration: 20, icon: '🔁' },
  urgent: { label: 'Atención urgente', duration: 20, icon: '🚨' },
  mental_health: { label: 'Salud mental', duration: 50, icon: '🧠' },
  refill: { label: 'Renovación de receta', duration: 15, icon: '💊' },
};
export const APPT_TYPE_KEYS = Object.keys(APPT_TYPES) as ApptType[];
export function isApptType(s: unknown): s is ApptType {
  return typeof s === 'string' && (APPT_TYPE_KEYS as string[]).includes(s);
}

export const STATUSES = [
  'scheduled', 'checked_in', 'waiting_room', 'in_progress', 'completed', 'cancelled', 'no_show',
] as const;
export type ApptStatus = typeof STATUSES[number];
export function isStatus(s: unknown): s is ApptStatus {
  return typeof s === 'string' && (STATUSES as readonly string[]).includes(s);
}

const TERMINAL = new Set<ApptStatus>(['completed', 'cancelled', 'no_show']);
// Forward order for the "happy path" lifecycle.
const ORDER: Record<ApptStatus, number> = {
  scheduled: 0, checked_in: 1, waiting_room: 2, in_progress: 3, completed: 4, cancelled: 99, no_show: 99,
};

// Is a status change allowed, given who is making it?
export function canTransition(from: ApptStatus, to: ApptStatus, actor: 'patient' | 'doctor'): boolean {
  if (!isStatus(from) || !isStatus(to) || from === to) return false;
  if (TERMINAL.has(from)) return false; // closed appointments are immutable
  if (actor === 'patient') {
    if (to === 'cancelled') return ['scheduled', 'checked_in', 'waiting_room'].includes(from);
    if (to === 'checked_in') return from === 'scheduled';
    if (to === 'waiting_room') return ['scheduled', 'checked_in'].includes(from);
    return false;
  }
  // doctor: can cancel / mark no-show anytime pre-terminal, else move forward only.
  if (to === 'cancelled' || to === 'no_show') return true;
  return ORDER[to] >= ORDER[from];
}

export function pad2(n: number): string { return String(n).padStart(2, '0'); }
export function minToHHMM(min: number): string { return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`; }

// Local Caracas date (YYYY-MM-DD) + minutes-from-midnight → absolute UTC ms.
export function localToMs(date: string, min: number): number {
  return Date.parse(`${date}T${minToHHMM(min)}:00.000${CARACAS_OFFSET}`);
}
// Weekday (0=Sun..6=Sat) of a local date in Caracas.
export function weekdayOf(date: string): number {
  return new Date(localToMs(date, 0)).getUTCDay();
}

export interface Interval { start_min: number; end_min: number; }
export interface Slot { start_min: number; end_min: number; label: string; start_ms: number; }

// Free, bookable slots for a date. A candidate is valid if it fits inside an
// availability window, doesn't overlap a block or an existing booking, and is far
// enough in the future. `blocks` whole-day entries should be passed as 0..1440.
export function computeSlots(opts: {
  date: string;
  windows: Interval[];
  blocks: Interval[];
  busy: Interval[];
  duration: number;
  step: number;
  nowMs: number;
}): Slot[] {
  const { date, windows, blocks, busy, duration, step, nowMs } = opts;
  const occupied = [...blocks, ...busy];
  const minStartMs = nowMs + 5 * 60_000; // 5-minute booking buffer
  const seen = new Set<number>();
  const out: Slot[] = [];
  for (const w of [...windows].sort((a, b) => a.start_min - b.start_min)) {
    for (let s = w.start_min; s + duration <= w.end_min; s += step) {
      if (seen.has(s)) continue;
      const e = s + duration;
      if (occupied.some((o) => s < o.end_min && e > o.start_min)) continue;
      const start_ms = localToMs(date, s);
      if (start_ms < minStartMs) continue;
      seen.add(s);
      out.push({ start_min: s, end_min: e, label: minToHHMM(s), start_ms });
    }
  }
  return out.sort((a, b) => a.start_min - b.start_min);
}
