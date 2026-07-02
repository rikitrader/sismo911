import type { Env } from '../types';

// Mirror the social_signals table into a Google Sheet once an hour. The Worker
// exchanges a stored OAuth refresh token for a short-lived access token, then
// clears + rewrites the "Señales" tab. All Google creds are wrangler secrets.

export async function googleAccessToken(env: Env): Promise<string | null> {
  if (!env.GOOGLE_REFRESH_TOKEN || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) { console.error('[sheets] token exchange failed', res.status); return null; }
  const j = await res.json<{ access_token?: string }>();
  return j.access_token ?? null;
}

const SEV_ES: Record<string, string> = { critical: '🔴 Crítico', alert: '🟠 Alerta', info: '🟡 Info' };

const HP_ESTADO_ES: Record<string, string> = {
  hospitalizado: '🟠 Hospitalizado', alta: '🟢 De alta', fallecido: '⚫ Fallecido', desconocido: '⚪ Desconocido',
};

// Mirror the hospital_patients registry (Cruz Roja feed + CIVIS atendidos) into
// the "Hospital" tab of the Google Sheet. Best-effort + additive: a no sheet-id /
// no-token / API failure returns 0 and never throws, so it can never break a cron
// tick. Newest-first, bounded to the most recent 5000 rows.
export async function syncHospitalSheet(env: Env): Promise<number> {
  const sheetId = env.HOSPITAL_SHEET_ID || env.MONITOR_SHEET_ID;
  if (!sheetId) return 0;
  const token = await googleAccessToken(env);
  if (!token) return 0;

  const { results } = await env.DB.prepare(
    `SELECT full_name, hospital, estado, edad, sexo, cedula, observaciones, source, source_ref, updated_ms
     FROM hospital_patients ORDER BY updated_ms DESC LIMIT 5000`
  ).all<any>();
  const rows = (results ?? []).map((r) => [
    r.updated_ms ? new Date(r.updated_ms).toISOString().replace('T', ' ').slice(0, 16) : '',
    r.full_name ?? '', r.hospital ?? '', HP_ESTADO_ES[r.estado] ?? r.estado ?? '',
    r.edad ?? '', r.sexo ?? '', r.cedula ?? '', String(r.observaciones ?? '').slice(0, 500),
    r.source ?? '', r.source_ref ?? '',
  ]);

  const tab = encodeURIComponent('Hospital');
  const auth = { authorization: `Bearer ${token}` };
  const header = [['Actualizado', 'Nombre', 'Centro', 'Estado', 'Edad', 'Sexo', 'Cédula', 'Observaciones', 'Fuente', 'Código']];
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${tab}!A1?valueInputOption=RAW`, {
    method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ values: header }),
  }).catch(() => {});
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${tab}!A2:J5001:clear`, { method: 'POST', headers: auth }).catch(() => {});
  if (rows.length) {
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${tab}!A2?valueInputOption=RAW`, {
      method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ values: rows }),
    });
  }
  return rows.length;
}

const SOS_ES: Record<string, string> = { active: '🔴 Activo', acknowledged: '🟠 Atendiendo', resolved: '🟢 Resuelto' };

// Mirror the emergency SOS table into the "SOS" tab of the same monitor sheet.
// Fired immediately on each /api/sos POST + PATCH (emergencies can't wait for
// the hourly cron) and again hourly as a safety net. Additive + best-effort:
// callers wrap it so a sheet failure can never block or fail an SOS insert.
export async function syncSosSheet(env: Env): Promise<number> {
  const sheetId = env.MONITOR_SHEET_ID;
  if (!sheetId) return 0;
  const token = await googleAccessToken(env);
  if (!token) return 0;

  const { results } = await env.DB.prepare(
    `SELECT id, lat, lon, name, phone, note, status, created_ms, updated_ms
     FROM sos_alerts ORDER BY created_ms DESC LIMIT 1000`
  ).all<any>();
  const rows = (results ?? []).map((r) => [
    r.created_ms ? new Date(r.created_ms).toISOString().replace('T', ' ').slice(0, 16) : '',
    SOS_ES[r.status] ?? r.status,
    r.name ?? '', r.phone ?? '', String(r.note ?? '').slice(0, 500),
    r.lat, r.lon,
    (r.lat != null && r.lon != null) ? `https://www.google.com/maps?q=${r.lat},${r.lon}` : '',
    r.id,
    r.updated_ms ? new Date(r.updated_ms).toISOString().replace('T', ' ').slice(0, 16) : '',
  ]);

  const tab = encodeURIComponent('SOS');
  const auth = { authorization: `Bearer ${token}` };
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${tab}!A2:J5000:clear`, { method: 'POST', headers: auth }).catch(() => {});
  if (rows.length) {
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${tab}!A2?valueInputOption=RAW`, {
      method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ values: rows }),
    });
  }
  return rows.length;
}

export async function syncMonitorSheet(env: Env): Promise<number> {
  const sheetId = env.MONITOR_SHEET_ID;
  if (!sheetId) return 0;
  const token = await googleAccessToken(env);
  if (!token) return 0;

  const { results } = await env.DB.prepare(
    `SELECT platform, severity, city, tags, title, text, author, lang, url, posted_ms
     FROM social_signals ORDER BY posted_ms DESC LIMIT 1000`
  ).all<any>();
  const rows = (results ?? []).map((r) => [
    r.posted_ms ? new Date(r.posted_ms).toISOString().replace('T', ' ').slice(0, 16) : '',
    r.platform, SEV_ES[r.severity] ?? r.severity, r.city ?? '', r.tags ?? '',
    (r.title || r.text || '').slice(0, 500), r.author ?? '', r.lang ?? '', r.url ?? '',
  ]);

  const tab = encodeURIComponent('Señales');
  const auth = { authorization: `Bearer ${token}` };
  // clear stale rows then write the fresh window
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${tab}!A2:I5000:clear`, { method: 'POST', headers: auth });
  if (rows.length) {
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${tab}!A2?valueInputOption=RAW`, {
      method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ values: rows }),
    });
  }
  // refresh the Resumen tab with a small summary
  const summary = await env.DB.prepare(
    `SELECT severity, COUNT(*) n FROM social_signals GROUP BY severity`
  ).all<any>().catch(() => ({ results: [] }));
  const sumRows = [['Severidad', 'Total'], ...((summary.results ?? []).map((r: any) => [SEV_ES[r.severity] ?? r.severity, r.n]))];
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent('Resumen')}!A1?valueInputOption=RAW`, {
    method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ values: sumRows }),
  }).catch(() => {});

  return rows.length;
}
