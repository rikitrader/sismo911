import type { Env } from '../types';
import { sendEmail, telemedReminderEmail } from '../lib/email';
import { notifyPatientText } from '../lib/sms';

// Hourly cron: remind patients of upcoming telemedicine appointments (next ~24h)
// once each. Bounded per run to stay well within the Free-plan subrequest budget.
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_PER_RUN = 25;

function whenText(ms: number): string {
  return new Date(ms).toLocaleString('es-VE', { timeZone: 'America/Caracas', dateStyle: 'full', timeStyle: 'short' }) + ' (hora de Venezuela)';
}
const firstName = (s: string) => String(s || '').trim().split(/\s+/)[0] || '';
const baseUrl = (env: Env) => (env.PUBLIC_BASE_URL || 'https://sismo911.com').replace(/\/+$/, '');

export async function sendTelemedReminders(env: Env): Promise<{ sent: number; scanned: number }> {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.patient_name, a.patient_email, a.patient_phone, a.start_ms, a.video_url, a.manage_token,
            d.full_name AS doctor_name
       FROM telemed_appointments a LEFT JOIN telemed_doctors d ON d.id = a.doctor_id
      WHERE a.status IN ('scheduled','checked_in','waiting_room')
        AND a.reminded_ms IS NULL AND a.start_ms > ? AND a.start_ms <= ?
      ORDER BY a.start_ms ASC LIMIT ?`,
  ).bind(now, now + WINDOW_MS, MAX_PER_RUN).all<any>().catch(() => ({ results: [] as any[] }));
  const rows = results ?? [];
  let sent = 0;
  for (const a of rows) {
    const track = `${baseUrl(env)}/telemedicina?cita=${a.manage_token}`;
    const when = whenText(a.start_ms);
    if (a.patient_email) {
      await sendEmail(env, a.patient_email, telemedReminderEmail({ toName: firstName(a.patient_name), doctorName: a.doctor_name || 'tu médico', whenText: when, videoUrl: a.video_url, manageUrl: track })).catch(() => {});
    }
    if (a.patient_phone) {
      await notifyPatientText(env, a.patient_phone, `SISMO911: recordatorio de tu videoconsulta con Dr(a). ${a.doctor_name || ''} — ${when}. Entra: ${a.video_url} · ${track}`).catch(() => {});
    }
    await env.DB.prepare(`UPDATE telemed_appointments SET reminded_ms=? WHERE id=?`).bind(now, a.id).run().catch(() => {});
    sent++;
  }
  return { sent, scanned: rows.length };
}
