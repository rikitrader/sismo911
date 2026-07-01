// SISMO911 — Telegram intake: operator alert + sender reply.
// ---------------------------------------------------------------------------
// Operators are notified the same way the status bot already alerts them: a DM
// to each configured admin Telegram user id. The submitter gets a short receipt
// with a tracking code and what happened, in Spanish.

import type { Env } from '../../types';
import type { TelegramConfig } from '../env';
import type { IntakeResult } from './types';

const TG_API = 'https://api.telegram.org';

/** Fire-and-forget Telegram sendMessage (single, short message). */
export async function sendTelegram(token: string, chatId: number | string, text: string): Promise<void> {
  await fetch(`${TG_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3900), disable_web_page_preview: true }),
  }).catch(() => {});
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
  const msg = [`${head} (${r.code})`, r.note, r.fields.nombre ? `Nombre: ${r.fields.nombre}` : null, r.fields.cedula ? `Cédula: ${r.fields.cedula}` : null, link].filter(Boolean).join('\n');
  for (const adminId of cfg.adminUserIds) {
    await sendTelegram(cfg.botToken, adminId, msg);
  }
}

/** Build the receipt the submitter sees. */
export function buildReceipt(r: IntakeResult): string {
  const lines = [`✅ Recibido. Tu código de seguimiento es ${r.code}.`];
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
