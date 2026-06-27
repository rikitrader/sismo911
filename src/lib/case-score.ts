// SISMO911 — Case Priority Scoring Engine (FEMA START-triage inspired)
// ---------------------------------------------------------------------------
// A PURE, DETERMINISTIC function that turns a missing-person case into a triage
// priority (Alta / Media / Baja) + a 0–100 score + the reasons behind it.
//
// Modeled on FEMA/START field triage, mapped to search-and-reunification:
//   INMEDIATA (IMMEDIATE · red)   → priority 'alta'  — active search, act now
//   DEMORADA  (DELAYED · yellow)  → priority 'media' — search, with mitigants
//   MENOR     (MINOR · green)     → priority 'baja'  — located safe, resolved
//   FALLECIDA (DECEASED · black)  → priority 'baja'  — recovery / identification
//
// Design rules (the "set of rules" the engine enforces):
//   1. Status dominates. found_safe → resolved (baja). found_deceased → recovery
//      track (baja, distinct triage). Only missing/unknown get a computed score.
//   2. Vulnerability escalates: minors and elderly outrank average adults.
//   3. The quake context escalates: stronger PAGER alert / magnitude ⇒ higher.
//   4. Time is dynamic: the first 72 h is the critical search window (boost);
//      a >30-day case with zero activity goes "cold" (mild de-prioritization for
//      resource triage) — BUT a still-missing minor never drops below 'media'.
//   5. New information escalates: a docket movement in the last 48 h boosts.
//
// The engine takes `now` as an input so tests are deterministic and so the same
// case re-scores over time (the basis of the autonomous auto-update sweep).

// found-alive statuses: found_safe (a salvo), aparecido (apareció / localizado con
// vida), hospitalizado (localizado en un centro de salud). All resolve the case.
export type CaseStatus = 'missing' | 'found_safe' | 'aparecido' | 'hospitalizado' | 'found_deceased' | 'unknown';
export type Priority = 'alta' | 'media' | 'baja';
export type Triage = 'immediate' | 'delayed' | 'minor' | 'deceased';

export interface CaseSignals {
  status: CaseStatus;
  age?: number | null;
  incidentType?: string | null;   // e.g. 'menor', 'medico', 'persona_desaparecida'
  createdMs?: number | null;      // when the case was opened
  lastActivityMs?: number | null; // most recent docket movement
  docketCount?: number | null;    // number of docket movements
  eventMag?: number | null;       // reference quake magnitude
  eventAlert?: string | null;     // PAGER alert: green | yellow | orange | red
  now?: number;                   // current time (ms); defaults to Date.now()
}

export interface CaseScore {
  score: number;          // 0–100
  priority: Priority;     // alta | media | baja
  triage: Triage;         // immediate | delayed | minor | deceased
  label: string;          // Spanish triage label (INMEDIATA / DEMORADA / MENOR / FALLECIDA)
  color: string;          // FEMA triage color (hex)
  reasons: string[];      // human-readable rule hits (Spanish), highest-impact first
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

// FEMA triage palette (aligned with the app's tokens where possible).
const TRIAGE: Record<Triage, { label: string; color: string; priority: Priority }> = {
  immediate: { label: 'INMEDIATA', color: '#c8102e', priority: 'alta' },   // red
  delayed:   { label: 'DEMORADA',  color: '#e57200', priority: 'media' },  // amber/yellow
  minor:     { label: 'MENOR',     color: '#2e7d32', priority: 'baja' },   // green
  deceased:  { label: 'FALLECIDA', color: '#1f2430', priority: 'baja' },   // black
};

function build(triage: Triage, score: number, reasons: string[]): CaseScore {
  const t = TRIAGE[triage];
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    priority: t.priority,
    triage,
    label: t.label,
    color: t.color,
    reasons,
  };
}

/** Score a single case into a triage priority. Pure + deterministic. */
export function scoreCase(sig: CaseSignals): CaseScore {
  const now = sig.now ?? Date.now();

  // ---- Rule 1: status overrides ------------------------------------------
  if (sig.status === 'found_safe' || sig.status === 'aparecido') {
    return build('minor', 5, ['Localizada con vida — caso resuelto, sin búsqueda activa.']);
  }
  if (sig.status === 'hospitalizado') {
    return build('minor', 5, ['Localizada con vida (hospitalizada) — seguimiento médico, sin búsqueda activa.']);
  }
  if (sig.status === 'found_deceased') {
    return build('deceased', 10, ['Fallecida — gestión de recuperación e identificación.']);
  }

  // ---- missing | unknown → compute --------------------------------------
  const reasons: string[] = [];
  let score = sig.status === 'unknown' ? 35 : 50;
  reasons.push(sig.status === 'unknown' ? 'Estado sin confirmar.' : 'Persona desaparecida — búsqueda activa.');

  const age = typeof sig.age === 'number' && Number.isFinite(sig.age) ? sig.age : null;
  const minor = age != null ? age <= 17 : sig.incidentType === 'menor';

  // ---- Rule 2: vulnerability ---------------------------------------------
  if (age != null && age <= 12) { score += 25; reasons.push('Menor de edad (≤12 años) — alta vulnerabilidad.'); }
  else if (age != null && age <= 17) { score += 14; reasons.push('Menor de edad (13–17 años).'); }
  else if (age != null && age >= 65) { score += 15; reasons.push('Adulto mayor (≥65 años).'); }
  else if (sig.incidentType === 'menor') { score += 12; reasons.push('Caso marcado como menor de edad.'); }
  if (sig.incidentType === 'medico') { score += 12; reasons.push('Necesidad médica conocida.'); }

  // ---- Rule 3: earthquake context ----------------------------------------
  const alert = (sig.eventAlert ?? '').toLowerCase();
  if (alert === 'red') { score += 12; reasons.push('Sismo de referencia con alerta PAGER roja.'); }
  else if (alert === 'orange') { score += 8; reasons.push('Sismo de referencia con alerta PAGER naranja.'); }
  else if (alert === 'yellow') { score += 4; reasons.push('Sismo de referencia con alerta PAGER amarilla.'); }
  else if (typeof sig.eventMag === 'number') {
    if (sig.eventMag >= 7) { score += 8; reasons.push(`Sismo de gran magnitud (M${sig.eventMag}).`); }
    else if (sig.eventMag >= 6) { score += 4; reasons.push(`Sismo de magnitud considerable (M${sig.eventMag}).`); }
  }

  // ---- Rule 4: time dynamics ---------------------------------------------
  const opened = typeof sig.createdMs === 'number' ? sig.createdMs : null;
  const ageMs = opened != null ? Math.max(0, now - opened) : null;
  const docket = sig.docketCount ?? 0;
  if (ageMs != null) {
    if (ageMs <= 72 * HOUR) { score += 10; reasons.push('Ventana crítica de búsqueda (primeras 72 h).'); }
    else if (ageMs <= 7 * DAY) { score += 4; reasons.push('Búsqueda en curso (primera semana).'); }
    else if (ageMs > 30 * DAY && docket === 0) { score -= 8; reasons.push('Caso frío (>30 días sin novedad).'); }
  }

  // ---- Rule 5: new information -------------------------------------------
  if (docket > 0 && typeof sig.lastActivityMs === 'number' && now - sig.lastActivityMs <= 48 * HOUR) {
    score += 8; reasons.push('Actividad o nueva pista reciente (<48 h).');
  }

  // ---- Bucket -------------------------------------------------------------
  score = Math.max(0, Math.min(100, score));
  let triage: Triage = score >= 70 ? 'immediate' : score >= 40 ? 'delayed' : 'minor';

  // ---- Rule 4 floor: a still-missing minor never drops below 'media'. ----
  if (sig.status === 'missing' && minor && triage === 'minor') {
    triage = 'delayed';
    reasons.push('Mínimo DEMORADA: menor de edad aún desaparecido.');
  }

  return build(triage, score, reasons);
}

/** Convenience: just the priority bucket (used where only alta/media/baja is needed). */
export function priorityOf(sig: CaseSignals): Priority {
  return scoreCase(sig).priority;
}
