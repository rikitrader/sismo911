// SISMO911 — Telegram intake: operator alert + sender reply.
// ---------------------------------------------------------------------------
// Operators are notified the same way the status bot already alerts them: a DM
// to each configured admin Telegram user id. The submitter gets a short receipt
// with a tracking code and what happened, in Spanish.

import type { Env } from '../../types';
import type { TelegramConfig } from '../env';
import type { IntakeResult } from './types';
import { escapeHtml } from '../responses';

const TG_API = 'https://api.telegram.org';

/** Fire-and-forget Telegram sendMessage (single, short message). Sends as HTML
 *  (bold codes/names); on a rejected entity parse resends plain so a formatting
 *  bug can never swallow a receipt. */
export async function sendTelegram(token: string, chatId: number | string, text: string): Promise<void> {
  const send = (parseMode?: 'HTML') =>
    fetch(`${TG_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 3900),
        disable_web_page_preview: true,
        ...(parseMode ? { parse_mode: parseMode } : {}),
      }),
    });
  try {
    const res = await send('HTML');
    if (!res.ok) await send().catch(() => {});
  } catch {
    /* network failure — nothing to retry against */
  }
}

/** DM every configured operator with the outcome + a console link. */
export async function notifyOperators(env: Env, cfg: TelegramConfig, r: IntakeResult): Promise<void> {
  if (!cfg.adminUserIds.length) return;
  const base = env.PUBLIC_BASE_URL || 'https://sismo911.com';
  const link = r.personId ? `${base}/familia?caso=${r.personId.replace(/^fam-/, '')}` : `${base}/console`;
  const head =
    r.outcome === 'matched'
      ? '🔗 Intake Telegram — coincide con caso'
      : r.outcome === 'created'
        ? '🆕 Intake Telegram — nuevo BORRADOR'
        : r.outcome === 'needs_review'
          ? '📥 Intake Telegram — revisar'
          : '⚠️ Intake Telegram — error';
  // One-tap moderation for a fresh draft: the operator can approve/reject right
  // here with the code (admin-tier /aprobar|/rechazar ITK-XXXX handled in route.ts).
  const actions =
    r.outcome === 'created' || r.outcome === 'matched'
      ? [`Aprobar:  /aprobar ${r.code}`, `Rechazar: /rechazar ${r.code}`]
      : [];
  const msg = [
    `${head} (<b>${escapeHtml(r.code)}</b>)`,
    r.note ? escapeHtml(r.note) : null,
    r.fields.nombre ? `Nombre: <b>${escapeHtml(r.fields.nombre)}</b>` : null,
    r.fields.cedula ? `Cédula: ${escapeHtml(r.fields.cedula)}` : null,
    ...actions,
    link,
  ]
    .filter(Boolean)
    .join('\n');
  for (const adminId of cfg.adminUserIds) {
    await sendTelegram(cfg.botToken, adminId, msg);
  }
}

/** Build the receipt the submitter sees. */
export function buildReceipt(r: IntakeResult): string {
  const lines = [`✅ Recibido. Tu código de seguimiento es <b>${escapeHtml(r.code)}</b>.`];
  switch (r.outcome) {
    case 'matched':
      lines.push('Relacionamos tu envío con un caso existente. Un operador lo verificará.');
      break;
    case 'created':
      lines.push('Registramos un caso nuevo (sin verificar). Un operador lo revisará antes de publicarlo.');
      break;
    case 'needs_review':
      lines.push('No pudimos leer un nombre o cédula claros. Si puedes, envía el nombre completo y la última ubicación en un mensaje de texto.');
      break;
    default:
      lines.push('Guardamos tu envío; un operador lo revisará.');
  }
  lines.push('Gracias por ayudar. SISMO911 no reemplaza a las autoridades: para emergencias llama al 911.');
  return lines.join('\n');
}
