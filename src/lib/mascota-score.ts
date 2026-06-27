// SISMO911 — Lost-Pet Case Urgency Scoring
// ---------------------------------------------------------------------------
// A PURE, DETERMINISTIC function that turns a lost-pet case into an urgency
// bucket + a 0–100 score + the reasons behind it. Mirrors src/lib/case-score.ts
// (the persons triage engine) but tuned for pet reunification:
//
//   ACTIVA       (alta · red)   → buscar ahora — fresh / hot lead
//   SEGUIMIENTO  (media · amber)→ búsqueda en curso
//   EN PAUSA     (baja · gray)  → sin novedad / caso frío
//   REUNIDA      (baja · green) → resuelto, sin búsqueda activa
//   CERRADO      (baja · black) → fallecida
//
// Rules:
//   1. Status dominates. reunida/encontrada(con dueño) → resuelto; fallecida → cerrado.
//   2. Active states get a base (perdida/avistada/en_transito); a sighting state is hotter.
//   3. Time: first 72 h is the critical window (boost); >30 d with no movement goes cold.
//   4. New information: a movement/sighting in the last 48 h boosts.
//
// `now` is an input so tests are deterministic and the same case re-scores over time.

export type MascotaStatus = 'perdida' | 'avistada' | 'en_transito' | 'reunida' | 'encontrada' | 'fallecida';
export type MascotaPriority = 'alta' | 'media' | 'baja';
export type MascotaBucket = 'activa' | 'seguimiento' | 'pausa' | 'reunida' | 'cerrado';

export interface MascotaSignals {
  status?: string | null;        // case_status (perdida | avistada | …); null → perdida
  createdMs?: number | null;     // when the case/report was opened
  caseUpdatedMs?: number | null; // last activity (case_updated_ms)
  movimientos?: number | null;   // approved timeline events
  lastSightingMs?: number | null;// most recent approved sighting/activity
  now?: number;                  // current time (ms); defaults to Date.now()
}

export interface MascotaScore {
  score: number;             // 0–100
  priority: MascotaPriority; // alta | media | baja
  bucket: MascotaBucket;     // activa | seguimiento | pausa | reunida | cerrado
  label: string;             // Spanish urgency label
  color: string;             // hex
  reasons: string[];         // human-readable rule hits (Spanish)
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

const BUCKET: Record<MascotaBucket, { label: string; color: string; priority: MascotaPriority }> = {
  activa:      { label: 'ACTIVA',      color: '#c8102e', priority: 'alta' },  // red
  seguimiento: { label: 'SEGUIMIENTO', color: '#e57200', priority: 'media' },// amber
  pausa:       { label: 'EN PAUSA',    color: '#5b6781', priority: 'baja' },  // gray
  reunida:     { label: 'REUNIDA',     color: '#1f8a4c', priority: 'baja' },  // green
  cerrado:     { label: 'CERRADO',     color: '#1f2430', priority: 'baja' },  // black
};

function build(bucket: MascotaBucket, score: number, reasons: string[]): MascotaScore {
  const b = BUCKET[bucket];
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    priority: b.priority,
    bucket,
    label: b.label,
    color: b.color,
    reasons,
  };
}

/** Score a single pet case into an urgency bucket. Pure + deterministic. */
export function scoreMascota(sig: MascotaSignals): MascotaScore {
  const now = sig.now ?? Date.now();
  const status = String(sig.status || 'perdida').toLowerCase();

  // ---- Rule 1: status overrides -----------------------------------------
  if (status === 'reunida') return build('reunida', 5, ['Reunida con su familia — caso resuelto.']);
  if (status === 'fallecida') return build('cerrado', 8, ['Fallecida — expediente cerrado.']);

  // ---- active states → compute ------------------------------------------
  const reasons: string[] = [];
  let score: number;
  if (status === 'avistada') { score = 58; reasons.push('Avistamiento reciente — pista activa.'); }
  else if (status === 'en_transito') { score = 48; reasons.push('En tránsito / en rescate.'); }
  else if (status === 'encontrada') { score = 32; reasons.push('Encontrada — busca a su dueño.'); }
  else { score = 50; reasons.push('Mascota perdida — búsqueda activa.'); }

  // ---- Rule 3: time dynamics --------------------------------------------
  const opened = typeof sig.createdMs === 'number' ? sig.createdMs : null;
  const ageMs = opened != null ? Math.max(0, now - opened) : null;
  const movimientos = sig.movimientos ?? 0;
  if (ageMs != null) {
    if (ageMs <= 72 * HOUR) { score += 12; reasons.push('Ventana crítica (primeras 72 h).'); }
    else if (ageMs <= 7 * DAY) { score += 5; reasons.push('Búsqueda en curso (primera semana).'); }
    else if (ageMs > 30 * DAY && movimientos === 0) { score -= 14; reasons.push('Caso frío (>30 días sin novedad).'); }
  }

  // ---- Rule 4: new information ------------------------------------------
  const lastAct = typeof sig.lastSightingMs === 'number' ? sig.lastSightingMs
    : (typeof sig.caseUpdatedMs === 'number' ? sig.caseUpdatedMs : null);
  if (lastAct != null && now - lastAct <= 48 * HOUR) {
    score += 10; reasons.push('Actividad o avistamiento reciente (<48 h).');
  }

  // ---- Bucket -----------------------------------------------------------
  score = Math.max(0, Math.min(100, score));
  const bucket: MascotaBucket = score >= 65 ? 'activa' : score >= 40 ? 'seguimiento' : 'pausa';
  return build(bucket, score, reasons);
}
