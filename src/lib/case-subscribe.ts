// Email-subscription lifecycle for case alerts (double opt-in).
//
// A citizen subscribes to a missing-person case → we email a confirm link FIRST
// (status 'pending'); on confirm the row goes 'active' and we baseline its
// last_state_hash so they are never alerted about state that predates them. The
// `case-alerts` cron (src/ingest/case-alerts.ts) then emails them on each change.
//
// Tokens are never stored in plaintext: we store sha256(token) and put the raw
// token only in the email link (mirrors the flota/email-verification pattern).

import type { Env } from '../types';
import { randomToken, sha256hex, sendEmail, subscribeVerifyEmail, subscribeConfirmedEmail } from './email';
import { caseStateSnapshot, hashCaseState } from './case-alert';

// Full-string email check (stricter than the global scrubber regex in security.ts).
const EMAIL_ONE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
export function normalizeEmail(raw: unknown): string | null {
  const e = String(raw ?? '').trim().toLowerCase();
  return e.length <= 254 && EMAIL_ONE.test(e) ? e : null;
}

export function caseUrlFor(origin: string, caseId: string): string {
  return `${origin}/casos#caso=${encodeURIComponent(caseId)}`;
}
export const verifyUrlFor = (origin: string, tok: string) => `${origin}/s/verify/${tok}`;
export const unsubUrlFor = (origin: string, tok: string) => `${origin}/s/unsub/${tok}`;

const newId = () => 'sub_' + randomToken(8);

export interface SubscribeResult { ok: boolean; status: number; already?: boolean; verifyTok?: string }

// Step 1 — request a subscription. Validates, ensures the case exists, (re)arms a
// verify token, and sends the confirm email. Idempotent for an already-active sub.
export async function requestSubscription(
  env: Env, caseId: string, rawEmail: unknown, origin: string, now = Date.now(),
): Promise<SubscribeResult> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, status: 400 };
  const snap = await caseStateSnapshot(env, caseId);
  if (!snap) return { ok: false, status: 404 };

  const existing = await env.DB.prepare(
    `SELECT id, status FROM case_subscriptions WHERE case_id = ? AND email = ?`,
  ).bind(caseId, email).first<any>().catch(() => null);
  if (existing && existing.status === 'active') return { ok: true, status: 200, already: true };

  const verifyTok = randomToken(24);
  const unsubTok = randomToken(24);
  const verifyHash = await sha256hex(verifyTok);
  const id = existing?.id || newId();
  await env.DB.prepare(
    `INSERT INTO case_subscriptions (id, case_id, email, status, verify_hash, unsub_token, created_ms)
     VALUES (?, ?, ?, 'pending', ?, ?, ?)
     ON CONFLICT(case_id, email) DO UPDATE SET
       status='pending', verify_hash=excluded.verify_hash, created_ms=excluded.created_ms`,
  ).bind(id, caseId, email, verifyHash, unsubTok, now).run().catch(() => null);

  const msg = subscribeVerifyEmail({
    caseName: snap.name,
    verifyUrl: verifyUrlFor(origin, verifyTok),
    caseUrl: caseUrlFor(origin, caseId),
  });
  await sendEmail(env, email, msg).catch(() => false);
  return { ok: true, status: 200, verifyTok };
}

export interface ConfirmResult { ok: boolean; caseName?: string; caseUrl?: string; unsubUrl?: string }

// Step 2 — confirm via the emailed token: activate + baseline the watermark so the
// new subscriber is not alerted about state that already existed at signup.
export async function confirmSubscription(
  env: Env, token: string, origin: string, now = Date.now(),
): Promise<ConfirmResult> {
  const hash = await sha256hex(String(token || ''));
  const row = await env.DB.prepare(
    `SELECT id, case_id, email, unsub_token FROM case_subscriptions WHERE verify_hash = ?`,
  ).bind(hash).first<any>().catch(() => null);
  if (!row) return { ok: false };

  const snap = await caseStateSnapshot(env, row.case_id);
  const stateHash = snap ? await hashCaseState(snap) : null;
  await env.DB.prepare(
    `UPDATE case_subscriptions SET status='active', verified_ms=?, last_state_hash=?, verify_hash=NULL WHERE id=?`,
  ).bind(now, stateHash, row.id).run().catch(() => null);

  // Seed the per-case baseline so the cron has a prior snapshot to diff against.
  if (snap && stateHash) {
    await env.DB.prepare(
      `INSERT INTO case_alert_state (case_id, state_hash, state_json, updated_ms) VALUES (?, ?, ?, ?)
       ON CONFLICT(case_id) DO NOTHING`,
    ).bind(row.case_id, stateHash, JSON.stringify(snap), now).run().catch(() => null);
  }

  const caseName = snap?.name || '';
  const caseUrl = caseUrlFor(origin, row.case_id);
  const unsubUrl = unsubUrlFor(origin, row.unsub_token); // stable plaintext capability token
  await sendEmail(env, row.email, subscribeConfirmedEmail({ caseName, caseUrl, unsubUrl })).catch(() => false);
  return { ok: true, caseName, caseUrl, unsubUrl };
}

export interface UnsubResult { ok: boolean; caseId?: string; caseName?: string }

// Step 3 — one-click unsubscribe by token. Fail-safe: always reports ok=true to
// the page even if the token is unknown (no token-probing oracle), but only an
// actual match flips a row.
export async function unsubscribeByToken(env: Env, token: string): Promise<UnsubResult> {
  const tok = String(token || '');
  const row = await env.DB.prepare(`SELECT id, case_id FROM case_subscriptions WHERE unsub_token = ?`)
    .bind(tok).first<any>().catch(() => null);
  if (!row) return { ok: true };
  await env.DB.prepare(`UPDATE case_subscriptions SET status='unsubscribed' WHERE id=?`)
    .bind(row.id).run().catch(() => null);
  const snap = await caseStateSnapshot(env, row.case_id).catch(() => null);
  return { ok: true, caseId: row.case_id, caseName: snap?.name };
}
