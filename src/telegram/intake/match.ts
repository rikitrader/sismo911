// SISMO911 — Telegram intake: link an extracted record to an existing case.
// ---------------------------------------------------------------------------
// Two strategies, strongest first:
//   1. cédula exact — case_identity holds operator-verified cédula→person_id.
//      An exact digit match is the highest-confidence link we can make.
//   2. name fuzzy — token-overlap (Jaccard) against personas.name_norm. Only a
//      strong overlap counts as a match; weaker ones fall through to no-match,
//      which triggers a draft case for operator review (never a silent merge).

import type { Env } from '../../types';
import { normalizeName } from '../../lib/search-normalize';
import type { ExtractedRecord, MatchResult } from './types';

const NAME_THRESHOLD = 0.6; // Jaccard token-overlap required to count as a name match.
const CANDIDATE_LIMIT = 40;

const NONE: MatchResult = { personId: null, score: 0, reason: 'none' };

function tokens(norm: string): string[] {
  return [...new Set(norm.split(/\s+/).filter((t) => t.length >= 3))];
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const inter = a.filter((t) => setB.has(t)).length;
  return inter / (a.length + b.length - inter);
}

/** Resolve the best existing-case match for an extracted record. Never throws. */
export async function matchCase(env: Env, rec: ExtractedRecord): Promise<MatchResult> {
  try {
    // 1) cédula exact (operator-verified table).
    if (rec.cedula && /^\d{5,9}$/.test(rec.cedula)) {
      const row = await env.DB.prepare(
        `SELECT person_id FROM case_identity
          WHERE cedula = ? AND person_id IS NOT NULL AND person_id <> ''
          ORDER BY created_ms DESC LIMIT 1`,
      )
        .bind(rec.cedula)
        .first<{ person_id: string }>();
      if (row?.person_id) return { personId: String(row.person_id), score: 0.99, reason: 'cedula' };
    }

    // 2) name fuzzy against personas.name_norm.
    if (rec.nombre) {
      const norm = normalizeName(rec.nombre);
      const qTokens = tokens(norm);
      if (qTokens.length) {
        // Pull candidates that share the longest query token (cheap prefilter),
        // then score each by full token-overlap.
        const longest = qTokens.slice().sort((a, b) => b.length - a.length)[0];
        const { results } = await env.DB.prepare(
          `SELECT id, name_norm FROM personas
            WHERE name_norm IS NOT NULL AND name_norm <> '' AND name_norm LIKE ?
            LIMIT ?`,
        )
          .bind(`%${longest}%`, CANDIDATE_LIMIT)
          .all<{ id: string; name_norm: string }>();

        let best: MatchResult = NONE;
        for (const r of results ?? []) {
          const score = jaccard(qTokens, tokens(String(r.name_norm)));
          if (score > best.score) best = { personId: `fam-${r.id}`, score, reason: 'name' };
        }
        if (best.score >= NAME_THRESHOLD) return best;
      }
    }
  } catch {
    return NONE;
  }
  return NONE;
}
