// SISMO911 — Telegram bot: OPTIONAL AI intent normalization.
// ---------------------------------------------------------------------------
// STRICTLY a text-understanding helper. When the deterministic parser cannot
// extract identifiers from a free-text message, we may ask Workers AI to pull
// out a cédula / name / DOB / case id. The model is FORBIDDEN from producing a
// status — its output is validated by Zod and only ever used to drive the same
// DB lookups. If the AI binding is absent, the model errors, or the output is
// malformed, this returns null and the bot degrades to the deterministic parse.

import { z } from 'zod';
import type { Env } from '../types';

const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const IntentSchema = z.object({
  intent: z.enum(['buscar', 'caso', 'status', 'hospitalizados', 'missing', 'ayuda', 'unknown']),
  cedula: z.string().optional(),
  name: z.string().optional(),
  dob: z.string().optional(),
  caseId: z.string().optional(),
  city: z.string().optional(),
});
export type AiIntent = z.infer<typeof IntentSchema>;

const SYSTEM =
  'Eres un extractor de datos para un bot humanitario. Lees un mensaje y devuelves SOLO un objeto JSON ' +
  'con los identificadores que el usuario menciona EXPLÍCITAMENTE. NUNCA inventes datos. NUNCA determines ' +
  'ni inventes el estado de una persona (vivo, muerto, desaparecido, etc.) — eso lo decide la base de datos, ' +
  'no tú. Campos: intent (buscar|caso|status|hospitalizados|missing|ayuda|unknown), cedula, name, dob ' +
  '(YYYY-MM-DD), caseId, city. Si un campo no aparece, omítelo. Devuelve SOLO el objeto JSON.';

/**
 * Best-effort structured extraction. Returns null on any failure so callers
 * never depend on it. Never throws.
 */
export async function aiNormalizeIntent(env: Env, text: string): Promise<AiIntent | null> {
  const ai = env.AI;
  if (!ai) return null;
  const model = env.TELEGRAM_AI_MODEL || DEFAULT_MODEL;
  try {
    const resp: any = await ai.run(model, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: String(text).slice(0, 500) },
      ],
      max_tokens: 200,
      temperature: 0,
    });
    const cands = [resp?.response, resp?.choices?.[0]?.message?.content, typeof resp === 'string' ? resp : '']
      .filter((x) => typeof x === 'string') as string[];
    const t = (cands.find((x) => x.includes('{')) || '').trim();
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a === -1 || b === -1) return null;
    const parsed = IntentSchema.safeParse(JSON.parse(t.slice(a, b + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
