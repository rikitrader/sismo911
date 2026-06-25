import type { Env } from '../types';
import { recordIngest, uid } from '../lib/db';

// KoboToolbox public form ingestion. This is openly-licensed humanitarian data
// (citizen damage form). Ingested rows enter as status='approved' with explicit
// attribution (source='kobotoolbox', source_url). Deduped by ext_id (_id).
//
// Public, no-auth endpoint:
//   https://kf.kobotoolbox.org/api/v2/assets/<ASSET>/data.json
const KOBO_ASSET = 'a8XWDsdUcpBzXGtgQmiiro';
const KOBO_URL = `https://kf.kobotoolbox.org/api/v2/assets/${KOBO_ASSET}/data.json?limit=300`;
const FORM_LINK = `https://kf.kobotoolbox.org/#/forms/${KOBO_ASSET}/data/map`;

// Map the form's free-text "Evento" → our category taxonomy.
function categorize(evento: string, desc: string): { category: string; severity: string | null } {
  const t = `${evento} ${desc}`.toLowerCase();
  if (/colaps|derrumb|cay[oó]|desplom/.test(t)) return { category: 'collapsed_building', severity: 'rojo' };
  if (/atrapad|sepultad|bajo escombro/.test(t)) return { category: 'trapped_people', severity: 'rojo' };
  if (/gas|fuga/.test(t)) return { category: 'gas_leak', severity: 'naranja' };
  if (/refugio|albergue/.test(t)) return { category: 'shelter', severity: null };
  if (/agua|water/.test(t)) return { category: 'water_point', severity: null };
  if (/m[eé]dic|herido|salud|hospital/.test(t)) return { category: 'medical_need', severity: 'naranja' };
  if (/ayuda|don|suministr|v[ií]ver/.test(t)) return { category: 'aid_point', severity: null };
  if (/grieta|fisura|da[ñn]|afectad/.test(t)) return { category: 'damaged_building', severity: 'amarillo' };
  return { category: 'other', severity: null };
}

const blur = (n: any) => (n == null || isNaN(Number(n)) ? null : Math.round(Number(n) * 1000) / 1000);

export async function ingestKobo(env: Env): Promise<number> {
  try {
    const res = await fetch(KOBO_URL, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`kobo HTTP ${res.status}`);
    const data: any = await res.json();
    const rows: any[] = data?.results ?? [];
    if (!rows.length) { await recordIngest(env, 'kobotoolbox', true, 0); return 0; }

    const now = Date.now();
    const stmt = env.DB.prepare(
      `INSERT INTO map_reports
        (id, ext_id, category, severity, status, verification, title, description,
         lat, lon, source, source_url, created_ms, updated_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(ext_id) DO UPDATE SET
         description=excluded.description, severity=excluded.severity, updated_ms=excluded.updated_ms`
    );
    const batch = rows.map((r) => {
      const evento = r['Evento'] ?? r['evento'] ?? '';
      const desc = r['Descripci_n_del_evento'] ?? r['descripcion'] ?? '';
      const { category, severity } = categorize(String(evento), String(desc));
      // _geolocation is [lat, lon] when present
      const geo = Array.isArray(r['_geolocation']) ? r['_geolocation'] : [null, null];
      return stmt.bind(
        uid('kob'), `kobo_${r['_id']}`, category, severity, 'approved', 'community_confirmed',
        String(evento).slice(0, 140) || 'Reporte ciudadano',
        String(desc).slice(0, 2000) || null,
        blur(geo[0]), blur(geo[1]), 'kobotoolbox', FORM_LINK, now, now
      );
    });
    await env.DB.batch(batch);
    await recordIngest(env, 'kobotoolbox', true, batch.length);
    return batch.length;
  } catch (e: any) {
    await recordIngest(env, 'kobotoolbox', false, 0, String(e?.message ?? e));
    return 0;
  }
}
