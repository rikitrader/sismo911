import type { Env } from '../types';
import { recordIngest } from '../lib/db';

// Hourly re-ingest of the missing-persons (Familia) registry from an external
// source, into the DESAP `personas` DB. The source URL is configured via the
// FAMILIA_SOURCE_URL secret/var; without it this is a no-op (logged), so the
// feature ships safely and activates the moment the URL is set.
//
// The mapper is schema-tolerant: it accepts a top-level array or an object with
// results/data/personas/items/features, and maps common field aliases (Spanish
// or English). Records are deduped by a stable external id → personas.id =
// `src_<extId>`, upserted so re-runs refresh rather than duplicate.

const pick = (o: any, keys: string[]) => { for (const k of keys) { const v = o?.[k]; if (v != null && v !== '') return v; } return null; };
function toArray(j: any): any[] {
  if (Array.isArray(j)) return j;
  for (const k of ['results', 'data', 'personas', 'items', 'records', 'features']) if (Array.isArray(j?.[k])) return j[k];
  return [];
}
function mapEstado(v: any): string {
  const s = String(v ?? '').toLowerCase();
  if (/localiz|encontrad|safe|a salvo|vivo/.test(s)) return 'localizado';
  if (/fallec|muert|decease|dead/.test(s)) return 'fallecido';
  return 'sin-contacto';
}

export async function ingestFamilia(env: Env): Promise<number> {
  const url = (env as any).FAMILIA_SOURCE_URL as string | undefined;
  if (!url) { console.warn('[familia] FAMILIA_SOURCE_URL not set — skipping'); return 0; }
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = toArray(await res.json());
    if (!rows.length) { await recordIngest(env, 'familia', true, 0); return 0; }
    const now = Date.now();
    const stmts = [];
    for (const r of rows) {
      // GeoJSON features carry fields under .properties
      const o = r.properties ? { ...r.properties, ...r } : r;
      const extId = pick(o, ['id', '_id', 'uuid', 'cedula', 'ext_id', 'codigo']);
      const nombre = pick(o, ['nombre', 'name', 'full_name', 'nombre_completo']);
      if (!extId || !nombre) continue;
      const id = `src_${String(extId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60)}`;
      const edad = pick(o, ['edad', 'age']);
      const ubicacion = pick(o, ['ubicacion', 'last_seen', 'location', 'lugar', 'direccion', 'sector']);
      const descripcion = pick(o, ['descripcion', 'notes', 'detalle', 'detalles', 'description', 'senas']);
      const contacto = pick(o, ['contacto', 'phone', 'telefono', 'celular', 'contact_phone']);
      const foto = pick(o, ['foto', 'photo', 'image', 'imagen', 'photo_url']);
      const estado = mapEstado(pick(o, ['estado', 'status', 'situacion']));
      stmts.push(env.DESAP.prepare(
        `INSERT INTO personas (id, nombre, edad, ubicacion, descripcion, contacto, foto, estado, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           nombre=excluded.nombre, edad=excluded.edad, ubicacion=excluded.ubicacion,
           descripcion=excluded.descripcion, contacto=excluded.contacto,
           foto=COALESCE(excluded.foto, personas.foto), estado=excluded.estado, updated_at=excluded.updated_at`
      ).bind(id, String(nombre).slice(0, 120), edad ? Number(edad) || null : null,
        ubicacion ? String(ubicacion).slice(0, 200) : null,
        descripcion ? String(descripcion).slice(0, 1000) : null,
        contacto ? String(contacto).slice(0, 80) : null,
        foto ? String(foto).slice(0, 500) : null, estado, now, now));
    }
    // D1 batches in chunks of 100.
    let written = 0;
    for (let i = 0; i < stmts.length; i += 100) { await env.DESAP.batch(stmts.slice(i, i + 100)); written += Math.min(100, stmts.length - i); }
    await recordIngest(env, 'familia', true, written);
    console.log(`[familia] ingested/updated ${written} of ${rows.length} records`);
    return written;
  } catch (e: any) {
    console.error('[familia] ingest failed:', e?.message ?? e);
    await recordIngest(env, 'familia', false, 0, String(e?.message ?? e)).catch(() => {});
    return 0;
  }
}
