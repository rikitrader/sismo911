import type { Env } from '../types';

// --- Text messaging via Twilio (SMS + WhatsApp) ---
// Mirrors the sendEmail gating in ./email: if the relevant Twilio secrets are
// absent, sends are a no-op that logs and returns false — so a missing config
// never breaks the booking flow. The whole path is wired now; it lights up the
// moment the TWILIO_* Worker secrets are set (zero code change).

export type TextChannel = 'sms' | 'whatsapp';

export function twilioFrom(env: Env, channel: TextChannel): string {
  return (channel === 'whatsapp' ? env.TWILIO_WHATSAPP_FROM : env.TWILIO_SMS_FROM) || '';
}
// Is Twilio fully configured for this channel?
export function twilioReady(env: Env, channel: TextChannel): boolean {
  return !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && twilioFrom(env, channel));
}
// WhatsApp addresses are prefixed `whatsapp:`; SMS uses the bare E.164 number.
export function addr(channel: TextChannel, n: string): string {
  const v = String(n || '').trim();
  return channel === 'whatsapp' ? `whatsapp:${v}` : v;
}

// Send one message on one channel. Returns true only on a 2xx Twilio response.
export async function sendText(env: Env, to: string, body: string, channel: TextChannel = 'sms'): Promise<boolean> {
  const dest = String(to || '').trim();
  if (!dest) return false;
  if (!twilioReady(env, channel)) {
    console.warn(`[sms] Twilio ${channel} not configured — not sent to`, dest);
    return false;
  }
  const params = new URLSearchParams({ From: addr(channel, twilioFrom(env, channel)), To: addr(channel, dest), Body: body });
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    if (!r.ok) { console.error(`[sms] Twilio ${channel} send failed:`, r.status); return false; }
    return true;
  } catch (e: any) {
    console.error('[sms] send error:', e?.message ?? e);
    return false;
  }
}

// Owner chose WhatsApp + SMS: fire both when configured. Never throws.
export async function notifyPatientText(env: Env, phone: string | null | undefined, body: string): Promise<{ whatsapp: boolean; sms: boolean }> {
  const to = String(phone || '').trim();
  if (!to) return { whatsapp: false, sms: false };
  const [whatsapp, sms] = await Promise.all([sendText(env, to, body, 'whatsapp'), sendText(env, to, body, 'sms')]);
  return { whatsapp, sms };
}
