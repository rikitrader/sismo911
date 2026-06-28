// src/ingest/casualty-gate.ts
//
// Ingestion gate for casualty (fallecidos/heridos/desaparecidos) figures. Every
// row — whether polled by the cron from USGS/ReliefWeb or POSTed by an operator
// — funnels through gateCasualty() BEFORE it touches D1, so junk / markup /
// link-spam / nonsensical numbers never infect the casualty ledger.
//
// It reuses the project's battle-tested in-memory ingestion gate (gateRow → the
// normalize → allowlist → zod → spam-score core) for the FREE-TEXT fields
// (source name + note), and adds numeric/enum sanity the text gate can't express
// (known metric, non-negative, min ≤ max, plausible ceiling, confidence ∈ [0,1],
// as_of not absurdly in the future). Pure + sync — safe in a cron row loop.

import { gateRow, REASON_CODES, type GateRowResult } from '../security/ingestion-gate';
import { z, textField } from '../security/validators';

/** Metrics the ledger accepts. Anything else is rejected at the door. */
export const CASUALTY_METRICS = ['dead', 'injured', 'missing', 'displaced', 'rescued', 'buildings'] as const;
export type CasualtyMetric = (typeof CASUALTY_METRICS)[number];

// Absolute sanity ceiling: VE population ≈ 28M. A single-event figure above this
// is a parse/units error, not data — reject it rather than store it.
const MAX_PLAUSIBLE = 30_000_000;
// Allow a little clock skew but reject figures dated far in the future (a sign of
// a bad timestamp/units bug).
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000; // 1 day

// Free-text fields run through the shared spam/markup filter. The numbers ride
// alongside and are checked separately below.
const CasualtyTextSchema = z.object({
  source_name: textField(120).optional(),
  note: textField(500).optional(),
  citation_url: textField(500).optional(),
});

const CASUALTY_TEXT_GATE = {
  schema: CasualtyTextSchema,
  allowedFields: ['source_name', 'note', 'citation_url'] as const,
  textFields: ['source_name', 'note'] as const,
};

export interface CasualtyRowInput {
  source_key: string;
  source_name?: string | null;
  metric: string;
  value_min: number | null | undefined;
  value_max?: number | null;
  as_of_ms: number;
  confidence?: number | null;
  citation_url?: string | null;
  note?: string | null;
}

export interface CasualtyGateOk {
  ok: true;
  row: {
    source_key: string;
    metric: CasualtyMetric;
    value_min: number;
    value_max: number | null;
    as_of_ms: number;
    confidence: number;
    citation_url: string | null;
    note: string | null;
  };
  score: number;
}
export interface CasualtyGateReject {
  ok: false;
  reason: string;
  detail: string;
}
export type CasualtyGateResult = CasualtyGateOk | CasualtyGateReject;

function reject(reason: string, detail: string): CasualtyGateReject {
  return { ok: false, reason, detail };
}

/** Validate one casualty figure. Returns a normalized row on pass, or a reason. */
export function gateCasualty(input: CasualtyRowInput): CasualtyGateResult {
  // 1. Known source + metric (enum) — fail closed on anything unexpected.
  const source_key = String(input.source_key ?? '').trim();
  if (!/^[a-z0-9_]{2,40}$/.test(source_key)) {
    return reject(REASON_CODES.SCHEMA_INVALID, `bad source_key: ${JSON.stringify(input.source_key)}`);
  }
  const metric = String(input.metric ?? '').trim() as CasualtyMetric;
  if (!CASUALTY_METRICS.includes(metric)) {
    return reject(REASON_CODES.SCHEMA_INVALID, `unknown metric: ${JSON.stringify(input.metric)}`);
  }

  // 2. Numeric sanity. value_min required, integer, ≥ 0, ≤ ceiling; value_max
  //    optional (open-ended figures) but if present must be an int ≥ value_min.
  const vmin = Number(input.value_min);
  if (!Number.isFinite(vmin) || !Number.isInteger(vmin) || vmin < 0 || vmin > MAX_PLAUSIBLE) {
    return reject(REASON_CODES.SCHEMA_INVALID, `value_min out of range: ${input.value_min}`);
  }
  let vmax: number | null = null;
  if (input.value_max != null && input.value_max !== undefined) {
    vmax = Number(input.value_max);
    if (!Number.isFinite(vmax) || !Number.isInteger(vmax) || vmax < vmin || vmax > MAX_PLAUSIBLE) {
      return reject(REASON_CODES.SCHEMA_INVALID, `value_max out of range: ${input.value_max}`);
    }
  }

  // 3. Timestamp sanity — finite, not absurdly in the future.
  const as_of_ms = Number(input.as_of_ms);
  if (!Number.isFinite(as_of_ms) || as_of_ms <= 0 || as_of_ms > Date.now() + MAX_FUTURE_MS) {
    return reject(REASON_CODES.SCHEMA_INVALID, `as_of_ms invalid: ${input.as_of_ms}`);
  }

  // 4. Confidence clamped to [0,1].
  let confidence = input.confidence == null ? 0.5 : Number(input.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.max(0, Math.min(1, confidence));

  // 5. Casualty text (source name / note) legitimately never contains markup, so
  //    we HARD-REJECT any tag-like markup or javascript: URI here (stricter than
  //    the generic textField, which sanitizes free-text descriptions in place).
  const rawText = `${input.source_name ?? ''} ${input.note ?? ''}`;
  if (/<[a-z!/]/i.test(rawText) || /javascript:/i.test(rawText)) {
    return reject(REASON_CODES.SCHEMA_INVALID, 'markup not allowed in casualty text');
  }

  // 6. Free-text fields through the shared ingestion filter (spam/hidden-unicode).
  const textGate: GateRowResult<unknown> = gateRow(
    {
      source_name: input.source_name ?? undefined,
      note: input.note ?? undefined,
      citation_url: input.citation_url ?? undefined,
    },
    CASUALTY_TEXT_GATE,
  );
  if (!textGate.ok) {
    return reject(textGate.reason, `text gate: ${textGate.detail}`);
  }

  // citation_url must be a real http(s) link or null (no javascript:/data: etc).
  let citation_url: string | null = input.citation_url ? String(input.citation_url).trim() : null;
  if (citation_url && !/^https?:\/\/[^\s]+$/i.test(citation_url)) citation_url = null;

  const note = input.note ? String(input.note).trim().slice(0, 500) : null;

  return {
    ok: true,
    score: textGate.score,
    row: { source_key, metric, value_min: vmin, value_max: vmax, as_of_ms, confidence, citation_url, note },
  };
}
