import type { Env } from '../types';
import { uid } from './db';
import { sendEmail } from './email';
import { notificationEmail } from './email-catalog';

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
  | 'support'
  | 'system';

export interface NotifyInput {
  type: NotificationType;
  title: string;
  body?: string | null;
  link?: string | null; // in-app destination, e.g. '#pagos' or a full URL
  email?: boolean;       // ALSO mirror to the user's email (transactional events)
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

  // Optional email mirror for transactional notifications (payments, withdrawals).
  // Gated by the user's "correos de pago" preference (sec_payment_emails, default
  // ON). Best-effort: a delivery failure never breaks the caller.
  if (n.email) {
    try {
      const u: any = await env.DB.prepare(`SELECT email, name, settings_json FROM users WHERE id = ?`).bind(userId).first();
      if (u && u.email) {
        let allow = true;
        try { const st = u.settings_json ? JSON.parse(u.settings_json) : {}; allow = st.sec_payment_emails !== false; } catch {}
        if (allow) {
          const base = env.PUBLIC_BASE_URL || 'https://sismo911.com';
          await sendEmail(env, u.email, notificationEmail({
            title: n.title, body: n.body || undefined, name: u.name || undefined, url: `${base}/cuenta`,
          }));
        }
      }
    } catch {
      // Swallow — email is non-critical.
    }
  }
}
