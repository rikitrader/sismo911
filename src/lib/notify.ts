import type { Env } from '../types';
import { uid } from './db';

// In-app notification writer. Real events (payment received, withdrawal status
// change, payment-link created, welcome) call notify() to drop a row that the
// citizen sees in the /cuenta bell dropdown. Best-effort: a failure here MUST
// NEVER break the originating flow (a payment must settle even if the notify
// insert fails), so every call is wrapped and swallowed.

export type NotificationType =
  | 'payment_received'
  | 'withdrawal_update'
  | 'link_created'
  | 'welcome'
  | 'plan_interest'
  | 'system';

export interface NotifyInput {
  type: NotificationType;
  title: string;
  body?: string | null;
  link?: string | null; // in-app destination, e.g. '#pagos' or a full URL
}

export async function notify(env: Env, userId: string, n: NotifyInput): Promise<void> {
  if (!userId || !n || !n.title) return;
  try {
    await env.DB.prepare(
      `INSERT INTO notifications (id, user_id, type, title, body, link, created_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      uid('ntf'),
      userId,
      n.type,
      String(n.title).slice(0, 160),
      n.body != null ? String(n.body).slice(0, 400) : null,
      n.link != null ? String(n.link).slice(0, 300) : null,
      Date.now(),
    ).run();
  } catch {
    // Swallow — notifications are non-critical; never fail the caller's flow.
  }
}
