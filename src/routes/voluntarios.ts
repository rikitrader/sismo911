import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { rateLimit, nameHasSpam, textHasLink, requestIp } from '../lib/security';
import { audit } from '../lib/audit';

export const voluntarios = new Hono<{ Bindings: Env }>();

// Canonical disaster-volunteer skill keys (the form + filters share this list).
const SKILLS = [
  'medico', 'primeros_auxilios', 'rescate', 'busqueda', 'logistica', 'transporte',
  'construccion', 'electricidad', 'plomeria', 'cocina', 'psicologia', 'traduccion',
  'comunicaciones', 'tecnologia', 'agua_saneamiento', 'veterinario', 'donaciones', 'general',
];
const AVAIL = ['inmediata', 'dias', 'fines_de_semana', 'remoto'];

// GET /api/voluntarios?q=&skill=&limit= — public directory of registered volunteers.
voluntarios.get('/', async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 300, 1), 500);
  const q = (c.req.query('q') || '').trim().toLowerCase().slice(0, 80);
  const skill = (c.req.query('skill') || '').trim().toLowerCase().slice(0, 40);
  const conds = ["moderation = 'approved'", "status = 'activo'"]; const binds: unknown[] = [];
  if (q) {
    const like = `%${q.replace(/[%_]/g, '')}%`;
    conds.push("(lower(full_name) LIKE ? OR lower(coalesce(city,'')) LIKE ? OR lower(coalesce(state,'')) LIKE ? OR lower(coalesce(skills,'')) LIKE ? OR lower(coalesce(notes,'')) LIKE ?)");
    binds.push(like, like, like, like, like);
  }
  if (skill && SKILLS.includes(skill)) { conds.push('lower(skills) LIKE ?'); binds.push(`%"${skill}"%`); }
  const { results } = await c.env.DB.prepare(
    `SELECT id, full_name, city, state, area, skills, availability, has_vehicle, can_travel, experience, notes, contact_phone, email, created_ms
     FROM volunteers WHERE ${conds.join(' AND ')} ORDER BY created_ms DESC LIMIT ?`,
  ).bind(...binds, limit).all();
  return c.json({ ok: true, items: results ?? [], total: results?.length ?? 0 }, 200, { 'Cache-Control': 'public, max-age=60' });
});

// GET /api/voluntarios/stats — totals + per-skill counts for the filter chips.
voluntarios.get('/stats', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT skills FROM volunteers WHERE moderation='approved' AND status='activo'`,
  ).all<{ skills: string }>();
  const counts: Record<string, number> = {}; let total = 0;
  for (const r of results ?? []) { total++; try { (JSON.parse(r.skills || '[]') as string[]).forEach((s) => { counts[s] = (counts[s] || 0) + 1; }); } catch { /* ignore */ } }
  return c.json({ ok: true, total, counts }, 200, { 'Cache-Control': 'public, max-age=60' });
});

// GET /api/voluntarios/profile/:id — single normalized volunteer profile for the
// per-volunteer page. Resolves from BOTH sources: registered self-registrations
// (id starts with "vol_") live in the volunteers table; RAV "se ofreció" reports
// (uuid ids) live in rav_reports with kind='voluntario'. Both are flattened to the
// same shape so /voluntario?id= renders either without branching. Skill tags are
// derived client-side from text (shared classifier), so this returns raw fields.
voluntarios.get('/profile/:id', async (c) => {
  const id = String(c.req.param('id') || '').trim().slice(0, 64);
  if (!id) return c.json({ error: 'id_required' }, 400);

  if (id.startsWith('vol_')) {
    const r = await c.env.DB.prepare(
      `SELECT id, full_name, city, state, area, skills, availability, has_vehicle, can_travel,
              experience, notes, contact_phone, email, created_ms
         FROM volunteers WHERE id = ? AND moderation='approved' AND status='activo' LIMIT 1`,
    ).bind(id).first<any>().catch(() => null);
    if (!r) return c.json({ error: 'not_found' }, 404);
    let skills: string[] = []; try { skills = JSON.parse(r.skills || '[]'); } catch { skills = []; }
    return c.json({
      ok: true, source: 'registered', id: r.id, full_name: r.full_name,
      city: r.city, state: r.state, area: r.area, skills,
      availability: r.availability, has_vehicle: !!r.has_vehicle, can_travel: !!r.can_travel,
      experience: r.experience, notes: r.notes, contact_phone: r.contact_phone, email: r.email,
      photo_url: null, lat: null, lng: null, created_at: r.created_ms ? new Date(r.created_ms).toISOString() : null,
    }, 200, { 'Cache-Control': 'public, max-age=120' });
  }

  // RAV citizen "se ofreció" report.
  const r = await c.env.DB.prepare(
    `SELECT id, category, title, description, city, state, area, lat, lng, contact, photo_url, tags, created_at
       FROM rav_reports WHERE id = ? AND lower(coalesce(kind,'')) = 'voluntario' AND coalesce(hidden,0) = 0 LIMIT 1`,
  ).bind(id).first<any>().catch(() => null);
  if (!r) return c.json({ error: 'not_found' }, 404);
  return c.json({
    ok: true, source: 'rav', id: r.id, full_name: r.title || 'Voluntario',
    city: r.city, state: r.state, area: r.area, skills: [],
    availability: null, has_vehicle: false, can_travel: false,
    experience: null, notes: r.description, contact_phone: r.contact, email: null,
    photo_url: r.photo_url, lat: r.lat, lng: r.lng, category: r.category, created_at: r.created_at,
  }, 200, { 'Cache-Control': 'public, max-age=120' });
});

// POST /api/voluntarios/register — public self-registration (rate-limited + spam-gated).
voluntarios.post('/register', async (c) => {
  const limited = await rateLimit(c.env, c, 'volunteer_register', 10, 300);
  if (limited) return limited;
  const b: any = (await c.req.json().catch(() => ({}))) || {};
  const name = String(b.full_name || '').trim();
  if (!name) return c.json({ error: 'full_name_required', hint: 'Indica tu nombre.' }, 400);
  const contact = String(b.contact_phone || '').trim();
  const email = String(b.email || '').trim();
  if (!contact && !email) return c.json({ error: 'contact_required', hint: 'Indica un teléfono o correo de contacto.' }, 400);
  if (nameHasSpam(name) || textHasLink(b.notes) || textHasLink(contact)) {
    await audit(c, 'spam_blocked', { ip: requestIp(c), src: 'voluntarios' }).catch(() => {});
    return c.json({ error: 'spam_blocked', hint: 'No incluyas enlaces ni sitios web.' }, 400);
  }
  let skills: string[] = Array.isArray(b.skills) ? b.skills : String(b.skills || '').split(',');
  skills = skills.map((s) => String(s).trim().toLowerCase()).filter((s) => SKILLS.includes(s)).slice(0, 14);
  const availability = AVAIL.includes(String(b.availability)) ? String(b.availability) : null;

  // Anti-duplicate: same name + contact → return the existing record.
  const existing = await c.env.DB.prepare(
    `SELECT id FROM volunteers WHERE lower(trim(full_name)) = lower(trim(?))
       AND lower(trim(coalesce(contact_phone,''))) = lower(trim(coalesce(?,''))) LIMIT 1`,
  ).bind(name, contact).first<{ id: string }>().catch(() => null);
  if (existing?.id) return c.json({ ok: true, id: existing.id, duplicate: true }, 200);

  const id = uid('vol'); const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO volunteers (id, full_name, contact_phone, email, city, state, area, skills, availability,
        has_vehicle, can_travel, experience, notes, moderation, status, ip, created_at, created_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id, name.slice(0, 120), contact.slice(0, 80) || null, email.slice(0, 120) || null,
    b.city ? String(b.city).slice(0, 80) : null, b.state ? String(b.state).slice(0, 80) : null,
    b.area ? String(b.area).slice(0, 120) : null,
    JSON.stringify(skills), availability, b.has_vehicle ? 1 : 0, b.can_travel ? 1 : 0,
    b.experience ? String(b.experience).slice(0, 200) : null, b.notes ? String(b.notes).slice(0, 1000) : null,
    'approved', 'activo', requestIp(c), new Date(now).toISOString(), now,
  ).run();
  return c.json({ ok: true, id, status: 'approved', message: '¡Gracias! Tu registro como voluntario está activo.' }, 201);
});
