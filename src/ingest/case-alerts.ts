// case-alerts cron — the "AI worker" behind email subscriptions.
//
// Each tick: for every case that has ≥1 ACTIVE subscriber, snapshot the watched
// fields, hash them, and compare against the stored per-case baseline. On a real
// change it writes a one-sentence AI summary (deterministic template fallback if
// env.AI is absent/errors) and emails each subscriber who hasn't yet been alerted
// at this state. Bounded fan-out keeps a tick well under the subrequest budget;
// the AI call only fires for cases that actually changed (≈0 in a quiet tick).

import type { Env } from '../types';
import { caseStateSnapshot, hashCaseState, diffCase, type CaseSnapshot, type CaseChange } from '../lib/case-alert';
import { sendEmail, caseChangeAlertEmail } from '../lib/email';

const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return null; } }

// Deterministic human summary from the field deltas — the fallback whenever AI is
// unavailable, so an alert is NEVER blocked on the model.
export function templateSummary(_snap: CaseSnapshot, changes: CaseChange[]): string {
  const st = changes.find((c) => c.field === 'status');
  if (st) return `El estado del caso cambió de «${st.from}» a «${st.to}».`;
  const lead = changes.find((c) => c.field === 'verifiedLeads' || c.field === 'latestLead');
  if (lead) return 'Hay nuevas pistas verificadas en el caso.';
  const labels = changes.map((c) => c.label.toLowerCase());
  return `Se actualizó ${labels.join(', ')} en el caso.`;
}

// One-sentence Spanish summary of the change. Best-effort AI; falls back to the
// deterministic template on any absence/error.
export async function summarizeChange(env: Env, snap: CaseSnapshot, changes: CaseChange[]): Promise<string> {
  const fallback = templateSummary(snap, changes);
  const ai = env.AI;
  if (!ai) return fallback;
  const model = env.BLOG_AI_MODEL || AI_MODEL;
  const sys = `Eres un asistente del sistema de emergencia sísmica SISMO911 (Venezuela). Resumes en UNA sola frase, en español sobrio y claro, el cambio en el expediente de una persona desaparecida, para avisar por correo a quien sigue el caso. Usa SOLO los cambios indicados; no inventes datos. Sin saludos ni firmas. Máximo 240 caracteres.`;
  const user = `Caso: ${snap.name || 'persona desaparecida'} (estado actual: ${snap.statusLabel}).
Cambios detectados:
${changes.map((c) => `- ${c.label}: ${c.from || '(vacío)'} → ${c.to || '(vacío)'}`).join('\n')}

Escribe la frase de aviso.`;
  try {
    const resp: any = await ai.run(model, {
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      max_tokens: 120, temperature: 0.2,
    });
    const cands = [resp?.response, resp?.choices?.[0]?.message?.content, resp?.result?.response, typeof resp === 'string' ? resp : '']
      .filter((x) => typeof x === 'string') as string[];
    const text = (cands.find((x) => x.trim()) || '').trim().replace(/^["'«»\s]+|["'«»\s]+$/g, '').slice(0, 280);
    return text || fallback;
  } catch (e: any) {
    console.error('[case-alerts] AI summary failed:', e?.message ?? e);
    return fallback;
  }
}

export interface CaseAlertsResult { casesScanned: number; casesChanged: number; emailsSent: number }

export async function runCaseAlerts(
  env: Env, opts: { maxCases?: number; maxEmails?: number; origin?: string } = {},
): Promise<CaseAlertsResult> {
  const maxCases = opts.maxCases ?? 40;
  const maxEmails = opts.maxEmails ?? 80;
  const origin = opts.origin || 'https://sismo911.com';
  const now = Date.now();
  let casesScanned = 0, casesChanged = 0, emailsSent = 0;

  const cases = await env.DB.prepare(
    `SELECT case_id, COUNT(*) AS subs FROM case_subscriptions WHERE status='active'
     GROUP BY case_id ORDER BY subs DESC LIMIT ?`,
  ).bind(maxCases).all<any>().catch(() => ({ results: [] as any[] }));

  for (const row of (cases.results || [])) {
    if (emailsSent >= maxEmails) break;
    casesScanned++;
    const caseId = row.case_id as string;
    const snap = await caseStateSnapshot(env, caseId);
    if (!snap) continue;
    const newHash = await hashCaseState(snap);
    const prev = await env.DB.prepare(`SELECT state_hash, state_json FROM case_alert_state WHERE case_id = ?`)
      .bind(caseId).first<any>().catch(() => null);

    if (prev && prev.state_hash === newHash) continue; // unchanged → cheapest path

    // Capture the prior snapshot BEFORE advancing the baseline — the diff must be
    // computed against the OLD state, never the row we're about to overwrite.
    const prevSnap = prev?.state_json ? safeParse(prev.state_json) : null;

    // Advance the per-case baseline (so the next tick diffs against latest state).
    await env.DB.prepare(
      `INSERT INTO case_alert_state (case_id, state_hash, state_json, updated_ms) VALUES (?,?,?,?)
       ON CONFLICT(case_id) DO UPDATE SET state_hash=excluded.state_hash, state_json=excluded.state_json, updated_ms=excluded.updated_ms`,
    ).bind(caseId, newHash, JSON.stringify(snap), now).run().catch(() => null);

    if (!prev) continue; // first observation → baseline only, never alert
    const changes = diffCase(prevSnap, snap);
    if (changes.length === 0) continue;
    casesChanged++;

    const summary = await summarizeChange(env, snap, changes);
    const subs = await env.DB.prepare(
      `SELECT id, email, unsub_token, last_state_hash FROM case_subscriptions WHERE case_id = ? AND status='active'`,
    ).bind(caseId).all<any>().catch(() => ({ results: [] as any[] }));

    for (const s of (subs.results || [])) {
      if (emailsSent >= maxEmails) break;
      if (s.last_state_hash === newHash) continue; // already alerted at this exact state
      const msg = caseChangeAlertEmail({
        caseName: snap.name, statusLabel: snap.statusLabel, summary, changes,
        caseUrl: `${origin}/casos#caso=${encodeURIComponent(caseId)}`,
        unsubUrl: `${origin}/s/unsub/${s.unsub_token}`,
      });
      const ok = await sendEmail(env, s.email, msg).catch(() => false);
      // Advance the per-sub watermark regardless of send success: at-most-once
      // semantics avoid a permanently-failing address re-alerting every tick (the
      // case baseline already advanced, so the NEXT change still notifies).
      await env.DB.prepare(`UPDATE case_subscriptions SET last_state_hash=?, last_alert_ms=? WHERE id=?`)
        .bind(newHash, now, s.id).run().catch(() => null);
      if (ok) emailsSent++;
    }
  }
  return { casesScanned, casesChanged, emailsSent };
}
