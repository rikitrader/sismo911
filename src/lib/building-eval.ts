// Engineering-evaluation layer (Eng Nivel 1/2/3) — pure logic, no I/O.
// ATC-20-inspired evaluation pipeline per building, tracked as SIGNED events:
// the server computes a SHA-256 over the canonical payload at insert time and
// anyone can recompute it later (tamper-evident, append-only). Corrections are
// modeled as 'anulacion' events pointing at the event they void — nothing is
// ever edited or deleted. Kept pure so test/building-eval.test.ts can assert
// the invariants without a DB (same pattern as building-score.ts).

export interface EvalEventRow {
  id?: number;
  building_id: string;
  level: number;
  status?: string | null;
  event_kind: string;
  note?: string | null;
  actor_name?: string | null;
  actor_role?: string | null;
  signed_by?: string | null;
  user_id?: string | null;
  user_name?: string | null;
  voids_event_id?: number | null;
  signature?: string;
  created_at: string;
}

export const EVAL_LEVEL_META = [
  { level: 1, name: 'Nivel 1 — Evaluación Rápida', desc: 'Triage exterior tipo ATC-20: marcado habitable / uso restringido / inseguro' },
  { level: 2, name: 'Nivel 2 — Evaluación Detallada', desc: 'Inspección detallada interior/exterior por inspector certificado' },
  { level: 3, name: 'Nivel 3 — Evaluación de Ingeniería', desc: 'Evaluación estructural completa por ingeniero (CIV) con memoria de cálculo' },
] as const;

export const EVAL_STATUSES = new Set(['pendiente', 'en_curso', 'completada', 'bloqueada']);
export const EVAL_KINDS = new Set(['inicio', 'inspeccion', 'hallazgo', 'documento', 'cambio_estado', 'firma', 'nota', 'anulacion']);
export const EVAL_KIND_LABELS: Record<string, string> = {
  inicio: 'Inicio de nivel', inspeccion: 'Inspección', hallazgo: 'Hallazgo', documento: 'Documento',
  cambio_estado: 'Cambio de estado', firma: 'Firma', nota: 'Nota', anulacion: 'Anulación',
};

/** Canonical `|`-joined payload the signature covers (nulls → empty string). */
export function canonicalPayload(e: EvalEventRow): string {
  return [
    e.building_id, e.level, e.status ?? '', e.event_kind, e.note ?? '',
    e.actor_name ?? '', e.actor_role ?? '', e.signed_by ?? '',
    e.user_id ?? '', e.voids_event_id ?? '', e.created_at,
  ].join('|');
}

/** SHA-256 hex over the canonical payload (WebCrypto — works in Workers and vitest). */
export async function signEvent(e: EvalEventRow): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalPayload(e)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** True if the stored signature matches a recomputation from the stored fields. */
export async function verifyEventSignature(e: EvalEventRow): Promise<boolean> {
  if (!e.signature) return false;
  return (await signEvent(e)) === e.signature;
}

/**
 * Workflow-order rule: starting (`en_curso`) or completing (`completada`) level N
 * requires every lower level to be `completada`. `pendiente`/`bloqueada` and
 * non-status events are allowed at any level. Returns a Spanish error or null.
 */
export function levelOrderViolation(levelStatuses: Record<number, string>, level: number, newStatus: string | null | undefined): string | null {
  if (newStatus !== 'en_curso' && newStatus !== 'completada') return null;
  for (let l = 1; l < level; l++) {
    if ((levelStatuses[l] ?? 'pendiente') !== 'completada') {
      return `Nivel ${level} no puede ${newStatus === 'completada' ? 'completarse' : 'iniciarse'}: Nivel ${l} no está completado`;
    }
  }
  return null;
}

export interface EvalSummary {
  levels: Array<{ level: number; name: string; desc: string; status: string; events: number; lastAt: string | null; assignee: string | null }>;
  currentLevel: number | null;
  progress: number;
  events: Array<EvalEventRow & { voided: boolean }>;
  eventCount: number;
  note: string;
}

/**
 * Derive the pipeline view from the raw event rows (expected newest-first).
 * Voided events (referenced by an 'anulacion' row's voids_event_id) are kept in
 * the event list — flagged `voided` so the UI can strike them through — but are
 * IGNORED when deriving per-level status, counts, and assignee.
 */
export function summarizeEval(rows: EvalEventRow[]): EvalSummary {
  const voided = new Set(rows.filter((e) => e.event_kind === 'anulacion' && e.voids_event_id != null).map((e) => Number(e.voids_event_id)));
  const events = rows.map((e) => ({ ...e, voided: e.id != null && voided.has(Number(e.id)) }));
  const live = events.filter((e) => !e.voided && e.event_kind !== 'anulacion');
  const levels = EVAL_LEVEL_META.map((m) => {
    const evs = live.filter((e) => Number(e.level) === m.level);
    const status = (evs.find((e) => e.status)?.status as string | undefined) ?? 'pendiente';
    return {
      level: m.level, name: m.name, desc: m.desc, status,
      events: evs.length,
      lastAt: evs[0]?.created_at ?? null,
      assignee: (evs.find((e) => e.actor_name)?.actor_name as string | undefined) ?? null,
    };
  });
  const done = levels.filter((l) => l.status === 'completada').length;
  const current = levels.find((l) => l.status === 'en_curso') ?? levels.find((l) => l.status !== 'completada') ?? null;
  return {
    levels,
    currentLevel: current?.level ?? null,
    progress: Math.round((done / levels.length) * 100),
    events,
    eventCount: events.length,
    note: 'Seguimiento operativo de evaluación estructural por niveles (inspirado en ATC-20). Eventos firmados con hash SHA-256 — trazabilidad, no peritaje oficial.',
  };
}

/** Per-level statuses from a summary — input for levelOrderViolation. */
export function levelStatusMap(s: EvalSummary): Record<number, string> {
  const m: Record<number, string> = {};
  for (const l of s.levels) m[l.level] = l.status;
  return m;
}
