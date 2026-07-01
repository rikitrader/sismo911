import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { getUserFromRequest } from '../lib/auth';
import { rateLimit, burstLimit } from '../lib/security';
import { audit } from '../lib/audit';
import { runGate, clientMessage, recordClean } from '../security/ingestion-gate';
import { z, nameField, textField, contactField } from '../security/validators';
import { recomputeCaseScore } from '../lib/case-score-sync';
import { cleanPersonas, cleanNameFloods, purgeRejectedPersonas } from '../lib/clean';
import { dedupePersonas } from '../lib/dedupe';
import { queryByIds, deleteByIds, deletePhotos } from '../lib/sql';
import { edgeCached } from '../lib/edge-cache';
import { isSafePublicUrl } from '../lib/sanitize';
import { sendEmail } from '../lib/email';
import { caseRegisteredEmail } from '../lib/email-catalog';
import { isMinor, isPublicSuppressed, coarsenLocation, scrubMinorText, PERSONAS_PUBLIC_SUPPRESS_SQL, personsPublicSuppressSql } from '../lib/minor-protect';
import { computeSearchFields } from '../lib/search-index';

// Missing-persons registry (/familia). Reads the `personas` dataset in the main
// (sismo911) D1 database; photos live in the DESAP_FOTOS R2 bucket (keyed by foto_r2).
// Keyset/cursor pagination for scale. Phone (`contacto`) redacted for the public.
export const familia = new Hono<{ Bindings: Env }>();
const DEFAULT_LIMIT = 24;

const estadoToStatus = (e: string) =>
  e === 'localizado' ? 'found_safe'
  : e === 'aparecido' ? 'aparecido'
  : e === 'hospitalizado' ? 'hospitalizado'
  : e === 'fallecido' ? 'found_deceased'
  : 'missing';
const statusToEstado = (s: string) =>
  s === 'found_safe' ? 'localizado'
  : s === 'aparecido' ? 'aparecido'
  : s === 'hospitalizado' ? 'hospitalizado'
  : s === 'found_deceased' ? 'fallecido'
  : s === 'missing' ? 'sin-contacto' : null;

async function isOperator(c: any): Promise<boolean> {
  const me = await getUserFromRequest(c.env, c).catch(() => null);
  return !!me && (me.role === 'operator' || me.role === 'admin');
}
const clampLimit = (v: string | undefined, def: number) => Math.min(60, Math.max(1, Number(v || def) || def));
// cursor = "<updated_at>_<id>"; most rows share updated_at, so id is the real key
function cursorClause(cursor: string, where: string[], binds: unknown[]) {
  if (!cursor) return;
  const i = cursor.lastIndexOf('_');
  const ms = Number(cursor.slice(0, i)); const id = cursor.slice(i + 1);
  if (Number.isFinite(ms) && id) { where.push('(updated_at < ? OR (updated_at = ? AND id < ?))'); binds.push(ms, ms, id); }
}
const nextCursor = (rows: any[], limit: number) =>
  rows.length > limit ? `${rows[limit - 1].updated_at}_${rows[limit - 1].id}` : null;

function mapPerson(p: any, op: boolean) {
  // Minor protection: coarsen a child's last-seen to locality + scrub house/unit
  // numbers from the free-text description for the public.
  const minorPub = !op && isMinor(p.edad);
  const last_seen = minorPub ? coarsenLocation(p.ubicacion) : p.ubicacion;
  return {
    id: p.id, full_name: p.nombre, age: p.edad, sex: null,
    last_seen, status: estadoToStatus(p.estado),
    photo_url: p.foto_r2 ? `/api/familia/photo/${p.id}` : (isSafePublicUrl(p.foto) ? p.foto : null),
    contact_phone: op ? (p.contacto || null) : (p.contacto ? '•••••• (solo operadores)' : null),
    notes: minorPub ? scrubMinorText(p.descripcion) : p.descripcion, updated_ms: p.updated_at,
  };
}

// GET /api/familia/persons?q=&status=&cursor=&limit=
familia.get('/persons', async (c) => {
  const limited = await rateLimit(c.env, c, 'familia_browse', 90, 60);
  if (limited) return limited;
  const op = await isOperator(c);
  // Public (redacted) responses are identical per URL, so the homepage's hottest call
  // is served from a 30s per-colo edge cache instead of recomputing from D1 on every
  // request. Operators bypass the cache entirely — their view carries PII (contact
  // phones), so a redacted/PII crossover is structurally impossible. Vary: Cookie keeps
  // an operator's own browser from reusing a publicly-cached (redacted) response.
  const build = async () => {
  const q = (c.req.query('q') || '').trim();
  const limit = clampLimit(c.req.query('limit'), DEFAULT_LIMIT);
  const base: string[] = []; const baseBinds: unknown[] = [];
  // Public sees only moderated rows; operators see everything (incl. pending).
  // Minor protection: hide operator-protected + resolved-minor cases from the public.
  if (!op) { base.push("moderation = 'approved'"); base.push(`NOT ${PERSONAS_PUBLIC_SUPPRESS_SQL}`); }
  if (q) { base.push('(nombre LIKE ? OR ubicacion LIKE ?)'); baseBinds.push(`%${q}%`, `%${q}%`); }
  const est = statusToEstado(c.req.query('status') || '');
  if (est) { base.push('estado = ?'); baseBinds.push(est); }
  const wBase = base.length ? 'WHERE ' + base.join(' AND ') : '';

  const total = ((await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM personas ${wBase}`).bind(...baseBinds).first<any>())?.n) ?? 0;
  const where = [...base]; const binds = [...baseBinds];
  cursorClause(c.req.query('cursor') || '', where, binds);
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const { results } = await c.env.DB.prepare(
    `SELECT id, nombre, edad, ubicacion, descripcion, contacto, foto, foto_r2, estado, updated_at
     FROM personas ${w} ORDER BY updated_at DESC, id DESC LIMIT ?`
  ).bind(...binds, limit + 1).all<any>();
  const rows = results ?? [];

  // Federate operator case files (native `persons` in the main DB) so /familia searches
  // ALL cases, not just the registry. These are far fewer than the 48k registry, so we
  // surface them on the first page only; the registry keeps its keyset pagination below.
  let nativeCases: any[] = []; let nativeTotal = 0;
  if (!(c.req.query('cursor') || '')) {
    const nb: string[] = []; const nbinds: unknown[] = [];
    if (!op) { nb.push("review = 'approved'"); nb.push(`NOT ${personsPublicSuppressSql('persons')}`); }
    if (q) { nb.push('(full_name LIKE ? OR last_seen LIKE ?)'); nbinds.push(`%${q}%`, `%${q}%`); }
    const stq = c.req.query('status') || '';
    if (['missing', 'found_safe', 'found_deceased', 'unknown'].includes(stq)) { nb.push('status = ?'); nbinds.push(stq); }
    const nw = nb.length ? 'WHERE ' + nb.join(' AND ') : '';
    try {
      nativeTotal = ((await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM persons ${nw}`).bind(...nbinds).first<any>())?.n) ?? 0;
      const { results: nrows } = await c.env.DB.prepare(
        `SELECT id, full_name, age, sex, last_seen, status, photo_url, contact_phone, notes, updated_ms
         FROM persons ${nw} ORDER BY updated_ms DESC LIMIT 24`
      ).bind(...nbinds).all<any>();
      nativeCases = (nrows || []).map((r: any) => ({
        id: r.id, full_name: r.full_name, age: r.age, sex: r.sex,
        last_seen: r.last_seen, status: r.status || 'unknown', photo_url: r.photo_url || null,
        contact_phone: op ? (r.contact_phone || null) : (r.contact_phone ? '•••••• (solo operadores)' : null),
        notes: r.notes, updated_ms: r.updated_ms, kind: 'case',
      }));
    } catch (e: any) { console.error('[familia/persons] native-case merge failed:', e?.message ?? e); }
  }

  const persons = [...nativeCases, ...rows.slice(0, limit).map((r) => mapPerson(r, op))];
  return { persons, total: total + nativeTotal, nextCursor: nextCursor(rows, limit), limit };
  };
  if (op) return c.json(await build());
  const res = await edgeCached(c, 30, build);
  res.headers.set('Vary', 'Cookie');
  return res;
});

// GET /api/familia/gallery?cursor=&limit=
familia.get('/gallery', async (c) => {
  const limited = await rateLimit(c.env, c, 'familia_browse', 90, 60);
  if (limited) return limited;
  return edgeCached(c, 60, async () => {
  const limit = clampLimit(c.req.query('limit'), 30);
  // Filters from the /personas wall (all optional). status → estado; q searches
  // name+location; edo/lugar match the freeform `ubicacion`; desde/hasta bound the
  // report date `fecha` (clean ISO YYYY-MM-DD → string comparison sorts correctly).
  const est = statusToEstado(c.req.query('status') || '');
  const q = (c.req.query('q') || '').trim();
  const edo = (c.req.query('edo') || '').trim();
  const lugar = (c.req.query('lugar') || '').trim();
  const isoDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  const desde = isoDay((c.req.query('desde') || '').trim());
  const hasta = isoDay((c.req.query('hasta') || '').trim());
  // Gallery is always the public (anonymous) view → suppress protected + resolved minors.
  const base = ['foto_r2 IS NOT NULL', "moderation = 'approved'", `NOT ${PERSONAS_PUBLIC_SUPPRESS_SQL}`]; const baseBinds: unknown[] = [];
  if (est) { base.push('estado = ?'); baseBinds.push(est); }
  if (q) { base.push('(nombre LIKE ? OR ubicacion LIKE ?)'); baseBinds.push(`%${q}%`, `%${q}%`); }
  if (edo) { base.push('ubicacion LIKE ?'); baseBinds.push(`%${edo}%`); }
  if (lugar) { base.push('ubicacion LIKE ?'); baseBinds.push(`%${lugar}%`); }
  // Rows without a fecha are excluded once a date bound is set (expected for a date filter).
  if (desde) { base.push('fecha >= ?'); baseBinds.push(desde); }
  if (hasta) { base.push('fecha <= ?'); baseBinds.push(hasta); }
  const wBase = base.join(' AND ');
  const total = ((await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM personas WHERE ${wBase}`).bind(...baseBinds).first<any>())?.n) ?? 0;
  const where = [...base]; const binds = [...baseBinds];
  cursorClause(c.req.query('cursor') || '', where, binds);
  const { results } = await c.env.DB.prepare(
    `SELECT id, nombre, edad, ubicacion, estado, foto_r2, updated_at FROM personas
     WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`
  ).bind(...binds, limit + 1).all<any>();
  const rows = results ?? [];
  return {
    photos: rows.slice(0, limit).map((p) => ({ id: p.id, full_name: p.nombre, age: p.edad, status: estadoToStatus(p.estado), last_seen: isMinor(p.edad) ? coarsenLocation(p.ubicacion) : p.ubicacion, photo_url: `/api/familia/photo/${p.id}` })),
    total, nextCursor: nextCursor(rows, limit),
  };
  });
});

// GET /api/familia/photo/:id  — serve from DESAP_FOTOS R2, fall back to the external URL
familia.get('/photo/:id', async (c) => {
  const row: any = await c.env.DB.prepare(`SELECT foto_r2, foto, edad, estado, protected FROM personas WHERE id = ?`).bind(c.req.param('id')).first();
  if (!row) return c.notFound();
  // Minor protection: a protected or resolved-minor photo is responder-only. The
  // operator lookup runs only for a suppressed row, so the public hot path is
  // unchanged; an operator response is never publicly cached.
  let opOnly = false;
  if (isPublicSuppressed({ age: row.edad, estado: row.estado, protected: row.protected })) {
    if (!(await isOperator(c))) return c.notFound();
    opOnly = true;
  }
  if (row.foto_r2) {
    const obj = await c.env.DESAP_FOTOS.get(row.foto_r2);
    if (obj) return new Response(obj.body, {
      headers: { 'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg', 'Cache-Control': opOnly ? 'private, no-store' : 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' },
    });
  }
  if (row.foto) return c.redirect(row.foto, 302);
  return c.notFound();
});

// GET /api/familia/person/:id  — full public detail for the click-to-open card modal.
familia.get('/person/:id', async (c) => {
  const limited = await rateLimit(c.env, c, 'familia_detail', 60, 60);
  if (limited) return limited;
  const id = c.req.param('id');
  // Native operator case file (id like "per_xxxxxxxx") lives in the main DB.
  if (id.startsWith('per_')) {
    const op = await isOperator(c);
    const r: any = await c.env.DB.prepare(
      `SELECT id, full_name, age, last_seen, status, incident_type, photo_url, contact_phone, notes, review, protected
       FROM persons WHERE id = ?`
    ).bind(id).first();
    if (!r || (!op && r.review !== 'approved')) return c.json({ error: 'not_found' }, 404);
    // Minor protection: a protected or resolved-minor case is responder-only.
    if (!op && isPublicSuppressed({ age: r.age, incidentType: r.incident_type, status: r.status, protected: r.protected })) {
      return c.json({ error: 'not_found' }, 404);
    }
    // Operator responses include the reporter phone (PII) → never publicly cached.
    c.header('Cache-Control', op ? 'private, no-store' : 'public, max-age=120');
    return c.json({
      id: r.id, full_name: r.full_name, age: r.age,
      last_seen: (!op && isMinor(r.age, r.incident_type)) ? coarsenLocation(r.last_seen) : r.last_seen,
      since: null, reporter: op ? (r.contact_phone || null) : null,
      description: ((!op && isMinor(r.age, r.incident_type)) ? scrubMinorText(r.notes) : r.notes) || null,
      status: r.status || 'unknown', estado: null, found_by: null, kind: 'case',
      photo_url: r.photo_url || null,
      share_url: `https://sismo911.com/familia?caso=${r.id}`,
    });
  }
  const p: any = await c.env.DB.prepare(
    `SELECT id, nombre, edad, ubicacion, fecha, descripcion, contacto, estado, foto, foto_r2, localizado_por, protected, updated_at
     FROM personas WHERE id = ? AND moderation = 'approved'`
  ).bind(id).first();
  if (!p) return c.json({ error: 'not_found' }, 404);
  // SECURITY: `contacto` is the reporter's phone (PII). It is operator-only on every
  // other surface (mapPerson + the per_ branch above); the personas branch previously
  // leaked it to ANY anonymous caller. Redact for non-operators, and never publicly
  // cache an operator response (which carries the PII).
  const op = await isOperator(c);
  // Minor protection: a protected or resolved-minor case is responder-only.
  if (!op && isPublicSuppressed({ age: p.edad, estado: p.estado, protected: p.protected })) {
    return c.json({ error: 'not_found' }, 404);
  }
  c.header('Cache-Control', op ? 'private, no-store' : 'public, max-age=120');
  return c.json({
    id: p.id, full_name: p.nombre, age: p.edad,
    last_seen: (!op && isMinor(p.edad)) ? coarsenLocation(p.ubicacion) : p.ubicacion,
    since: p.fecha || null, reporter: op ? (p.contacto || null) : null,
    description: ((!op && isMinor(p.edad)) ? scrubMinorText(p.descripcion) : p.descripcion) || null,
    status: estadoToStatus(p.estado), estado: p.estado, found_by: op ? (p.localizado_por || null) : null,
    photo_url: (p.foto_r2 || p.foto) ? `/api/familia/photo/${p.id}` : null,
    share_url: `https://sismo911.com/familia?persona=${p.id}`,
  });
});

// POST /api/familia/:id/localizar  — mark as found (operator-gated in index.ts + here).
familia.post('/:id/localizar', async (c) => {
  if (!(await isOperator(c))) return c.json({ error: 'unauthorized', hint: 'Solo operadores pueden confirmar' }, 401);
  const b = await c.req.json().catch(() => ({} as any));
  const id = c.req.param('id');
  const nota = String(b?.nota ?? 'Marcada como localizada').slice(0, 300);
  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE personas SET estado = 'localizado', localizado_nota = ?, updated_at = ? WHERE id = ?`
  ).bind(nota, now, id).run();
  // Record the operator-confirmed location in the docket (source='operator') so it
  // becomes a VERIFIABLE platform-facilitated outcome — this is the only signal the
  // "personas ayudadas" impact metric counts (the imported registry has no events).
  try {
    const actor = await getUserFromRequest(c.env, c).catch(() => null);
    await c.env.DB.prepare(
      `INSERT INTO person_events (id, person_id, kind, status_to, detail, source, actor, review, created_ms)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(uid('pev'), id, 'status_change', 'localizado', nota, 'operator', actor?.email ?? actor?.id ?? null, 'approved', now).run();
  } catch (e: any) { console.error('[localizar] docket log failed:', e?.message ?? e); }
  // Autonomous auto-update: found → case re-scores to 'baja' (MENOR) immediately.
  await recomputeCaseScore(c.env, 'fam-' + id).catch(() => {});
  return c.json({ ok: true, status: 'found_safe' });
});

// POST /api/familia/:id/report  — public "reportar contenido obsceno" flag (rate-limited).
familia.post('/:id/report', async (c) => {
  const limited = await rateLimit(c.env, c, 'familia_flag', 10, 300);
  if (limited) return limited;
  await c.env.DB.prepare(
    `UPDATE personas SET reportes = COALESCE(reportes,0) + 1,
       reportada = CASE WHEN COALESCE(reportes,0) + 1 >= 3 THEN 1 ELSE COALESCE(reportada,0) END,
       reportada_at = ? WHERE id = ?`
  ).bind(Date.now(), c.req.param('id')).run();
  return c.json({ ok: true });
});

// Citizen missing-person report gate. nombre strict (no link/markup/no-letter);
// last_seen/notes free text; contact validated; photo scanned by the gate.
const PersonReportSchema = z.object({
  nombre: nameField(120),
  age: z.coerce.number().int().min(0).max(130).optional(),
  last_seen: textField(200).optional(),
  notes: textField(1000).optional(),
  contact_phone: contactField(80),
});
const PERSON_FIELDS = ['nombre', 'age', 'last_seen', 'notes', 'contact_phone'] as const;

// POST /api/familia/persons  — citizen report → personas (photo → DESAP_FOTOS)
familia.post('/persons', async (c) => {
  const burst = await burstLimit(c.env, c, 'familia_register');
  if (burst) return burst;
  const limited = await rateLimit(c.env, c, 'familia_register', 15, 300);
  if (limited) return limited;
  let b: any = {}; let bytes: Uint8Array | null = null; let ctype = 'image/jpeg';
  if ((c.req.header('content-type') || '').includes('multipart/form-data')) {
    const f = await c.req.formData();
    for (const [k, v] of f.entries()) if (typeof v === 'string') b[k] = v;
    const ph = f.get('photo') as any;
    if (ph && typeof ph !== 'string' && typeof ph.arrayBuffer === 'function') { bytes = new Uint8Array(await ph.arrayBuffer()); ctype = ph.type || ctype; }
  } else { b = (await c.req.json().catch(() => ({}))) || {}; }
  const nombre = b.full_name || b.nombre;
  if (!nombre) return c.json({ error: 'full_name_required' }, 400);

  // Unified gate: normalizes + spam-SCORES nombre/notes (vs the old binary
  // link/markup check), and SCANS the photo (magic-bytes/MIME/polyglot/size).
  // rate limits already ran above → skipRateLimit. Rejections are audited in
  // rejected_ingestions. We map full_name→nombre and pass only the known fields
  // so stray form keys don't trip the strict allowlist.
  const gate = await runGate(c.env, c, {
    surface: 'persona',
    schema: PersonReportSchema,
    allowedFields: PERSON_FIELDS,
    nameFields: ['nombre'],
    textFields: ['last_seen', 'notes'],
    skipRateLimit: true,
    file: bytes ? { fieldName: 'photo', keyPrefix: 'fotos/', maxSize: 6_000_000 } : undefined,
  }, JSON.stringify({ nombre, age: b.age, last_seen: b.last_seen, notes: b.notes, contact_phone: b.contact_phone }),
     bytes ? { bytes, mime: ctype, filename: 'photo' } : undefined);
  if (!gate.ok) {
    if (gate.retryAfterSec) c.header('Retry-After', String(gate.retryAfterSec));
    return c.json(clientMessage(gate), gate.status);
  }
  const g = gate.data;

  // Anti-duplicate gate: if an identical report already exists (same name +
  // location + contact), return it instead of creating a duplicate — no photo
  // upload, no insert.
  const existing = await c.env.DB.prepare(
    `SELECT id FROM personas
      WHERE lower(trim(nombre)) = lower(trim(?))
        AND lower(trim(coalesce(ubicacion,''))) = lower(trim(coalesce(?,'')))
        AND lower(trim(coalesce(contacto,''))) = lower(trim(coalesce(?,'')))
      LIMIT 1`
  ).bind(String(g.nombre), g.last_seen ?? '', g.contact_phone ?? '').first<{ id: string }>().catch(() => null);
  if (existing?.id) return c.json({ ok: true, id: existing.id, duplicate: true }, 200);

  const id = uid('pc'); const now = Date.now(); let foto_r2: string | null = null;
  if (gate.file?.bytes?.length) {
    foto_r2 = `fotos/${id}.jpg`;
    await c.env.DESAP_FOTOS.put(foto_r2, gate.file.bytes, { httpMetadata: { contentType: `image/${gate.file.detectedType}` } });
  }
  const sf = computeSearchFields(g.nombre, g.last_seen);
  await c.env.DB.prepare(
    `INSERT INTO personas (id, nombre, edad, ubicacion, descripcion, contacto, foto_r2, estado, moderation, name_norm, geo_estado, geo_municipio, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, String(g.nombre).slice(0, 120), g.age ?? null,
    // ubicacion/descripcion/contacto are NOT NULL — coalesce missing to '' (a
    // null here is a 500: NOT NULL constraint failed).
    g.last_seen ? String(g.last_seen).slice(0, 200) : '',
    g.notes ? String(g.notes).slice(0, 1000) : '',
    g.contact_phone ? String(g.contact_phone).slice(0, 80) : '',
    foto_r2, 'sin-contacto', 'pending', sf.name_norm, sf.geo_estado, sf.geo_municipio, now, now
  ).run();
  await recordClean(c.env, c, { correlationId: gate.correlationId, surface: 'persona', destTable: 'personas', destId: id, r2Key: foto_r2 ?? undefined, score: gate.score, payloadHash: gate.payloadHash });
  // MP-01: if the reporter gave an email (optional field, NOT passed through the
  // persona gate / never stored on the record), send the case-registered receipt.
  // Non-blocking; best-effort.
  const reporterEmail = String(b.email || '').trim().toLowerCase();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(reporterEmail)) {
    const p = sendEmail(c.env, reporterEmail, caseRegisteredEmail({
      caseRef: id,
      when: new Date(now).toLocaleDateString('es-VE'),
      caseUrl: `https://sismo911.com/familia?caso=${id}`,
    }));
    try { c.executionCtx.waitUntil(p); } catch { /* no ctx (tests) — fire and forget */ }
  }
  // Public submission enters moderation — not shown until an operator approves.
  return c.json({ ok: true, id, status: 'pending', message: 'Recibido. Aparecerá tras revisión.' }, 201);
});

// GET /api/familia/queue — pending citizen submissions (operator-only).
familia.get('/queue', async (c) => {
  if (!(await isOperator(c))) return c.json({ error: 'unauthorized', hint: 'Inicia sesión como operador o admin' }, 401);
  c.header('Cache-Control', 'no-store');
  const { results } = await c.env.DB.prepare(
    `SELECT id, nombre, edad, ubicacion, descripcion, contacto, foto_r2, estado, updated_at
     FROM personas WHERE moderation='pending' ORDER BY updated_at DESC, id DESC LIMIT 300`
  ).all<any>();
  return c.json({ persons: (results ?? []).map((r) => mapPerson(r, true)) });
});

// POST /api/familia/:id/approve — publish a pending submission (operator-only).
familia.post('/:id/approve', async (c) => {
  if (!(await isOperator(c))) return c.json({ error: 'unauthorized', hint: 'Inicia sesión como operador o admin' }, 401);
  const r = await c.env.DB.prepare(
    `UPDATE personas SET moderation='approved', updated_at=? WHERE id=? AND moderation='pending'`
  ).bind(Date.now(), c.req.param('id')).run();
  return c.json({ ok: true, approved: r.meta.changes });
});

// POST /api/familia/maintenance — scan + purge spam/junk + remove duplicates.
// Operator/admin only (same gate as /queue + /approve). The /api/admin clean and
// dedupe equivalents only soft-reject; this one PHYSICALLY purges. Steps:
//   1) flag junk/spam names + name-floods (e.g. "SIMONE BURATTI GAY" ×N) → rejected
//   2) PHYSICALLY purge every rejected row (confirmed junk, already hidden) + R2 photo
//   3) remove exact + same-photo duplicates among the survivors
// Convergent + bounded: re-call until purged/dedupe counts reach 0. apply=false → dry run.
// POST /api/familia/delete-ids — operator-only. Physically delete specific
// personas by id (+ their R2 photos). Used by the local edit-distance dedup
// script, which computes near-duplicate clusters offline (heavy Levenshtein work
// the Worker shouldn't carry) and submits only the loser ids here. Capped per
// call; the caller batches. Returns how many rows + photos were removed.
familia.post('/delete-ids', async (c) => {
  if (!(await isOperator(c))) return c.json({ error: 'unauthorized', hint: 'Inicia sesión como operador o admin' }, 401);
  const b: any = await c.req.json().catch(() => ({}));
  const ids: string[] = Array.isArray(b?.ids) ? b.ids.filter((x: any) => typeof x === 'string').slice(0, 500) : [];
  if (!ids.length) return c.json({ error: 'no_ids' }, 400);
  // Param-safe (chunked under the D1 cap) + R2 bulk-delete. Photos first, then rows.
  const photoRows = await queryByIds<{ foto_r2: string }>(c.env.DB, ids, (ph) =>
    `SELECT foto_r2 FROM personas WHERE foto_r2 IS NOT NULL AND id IN (${ph})`);
  const deletedPhotos = await deletePhotos(c.env.DESAP_FOTOS, photoRows.map((r) => r.foto_r2));
  const deletedRows = await deleteByIds(c.env.DB, 'personas', ids);
  await audit(c, 'personas.deleteIds', { requested: ids.length, deletedRows, deletedPhotos });
  return c.json({ ok: true, requested: ids.length, deletedRows, deletedPhotos });
});

familia.post('/maintenance', async (c) => {
  if (!(await isOperator(c))) return c.json({ error: 'unauthorized', hint: 'Inicia sesión como operador o admin' }, 401);
  const b: any = await c.req.json().catch(() => ({}));
  const apply = b?.apply !== false; // default: apply

  // 1) flag junk/spam names + name floods → moderation='rejected'
  const clean = await cleanPersonas(c.env, { apply });
  const floods = await cleanNameFloods(c.env, { apply, minCount: b?.minCount });

  // 2) physically purge rejected rows + their R2 photos (bounded + convergent —
  //    the same helper the :15 cron runs; re-call until purge.remaining is 0).
  const purge = await purgeRejectedPersonas(c.env, { apply, limit: 400 });

  // 3) remove duplicates among survivors: exact re-scrapes + same-photo reuse are
  //    auto-safe; fuzzyphone (name+age+phone) is near-zero-risk. fuzzyname
  //    (name+age ONLY) can merge two distinct same-name+age people, so it is
  //    OPT-IN via { broad: true } and is NEVER run unattended in the cron.
  const broad = b?.broad === true;
  const dedupe: Record<string, unknown> = {
    exact: await dedupePersonas(c.env, { mode: 'exact', apply }),
    photo: await dedupePersonas(c.env, { mode: 'photo', apply }),
    fuzzyphone: await dedupePersonas(c.env, { mode: 'fuzzyphone', apply, limit: 400 }),
  };
  if (broad) dedupe.fuzzyname = await dedupePersonas(c.env, { mode: 'fuzzyname', apply, limit: 400 });

  if (apply) await audit(c, 'personas.maintenance', { clean, floods, purge, dedupe, broad });
  return c.json({
    ok: true, apply, clean, floods, dedupe,
    rejected: purge.found, purgedRows: purge.deletedRows, purgedPhotos: purge.deletedPhotos, purgeRemaining: purge.remaining,
  });
});
