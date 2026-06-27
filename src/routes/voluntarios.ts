import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { rateLimit, nameHasSpam, textHasLink, requestIp, maskContact, maskPhone, maskEmail } from '../lib/security';
import { audit } from '../lib/audit';
import { SKILL_KEYS, AVAILABILITY, deriveSkills, normalizeRow, statsFromRows } from '../lib/volunteer-skills';

export const voluntarios = new Hono<{ Bindings: Env }>();

// Canonical disaster-volunteer skill keys (the form + filters share this list).
// Single source of truth lives in lib/volunteer-skills.ts.
const SKILLS = SKILL_KEYS as readonly string[];
const AVAIL = AVAILABILITY as readonly string[];

// Hard ceiling on rows scanned when building the directory/stats. The dataset is
// citizen-scale (hundreds today); this bounds D1 work if it ever grows. When the
// corpus approaches this, move skill tags to a persisted/indexed column instead.
const SCAN_CAP = 5000;

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
  ).bind(...binds, limit).all<any>();
  // Strip raw phone/email from the public list (anti-scraping) — only flags + mask.
  const items = (results ?? []).map((r) => {
    const { contact_phone, email, ...rest } = r;
    return {
      ...rest,
      has_phone: !!String(contact_phone ?? '').replace(/\D/g, '').match(/\d{6,}/),
      has_email: !!String(email ?? '').includes('@'),
      contact_mask: maskPhone(contact_phone) || maskEmail(email),
    };
  });
  return c.json({ ok: true, items, total: items.length }, 200, { 'Cache-Control': 'public, max-age=60' });
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
    // If a registered volunteer left skills blank, infer from their free text so the
    // profile still shows tags (same classifier the directory uses).
    if (!skills.length) skills = deriveSkills([r.full_name, r.notes, r.experience, r.area].filter(Boolean).join(' '));
    return c.json({
      ok: true, source: 'registered', id: r.id, full_name: r.full_name,
      city: r.city, state: r.state, area: r.area, skills,
      availability: r.availability, has_vehicle: !!r.has_vehicle, can_travel: !!r.can_travel,
      experience: r.experience, notes: r.notes,
      has_phone: !!String(r.contact_phone ?? '').replace(/\D/g, '').match(/\d{6,}/),
      has_email: !!String(r.email ?? '').includes('@'),
      contact_mask: maskPhone(r.contact_phone) || maskEmail(r.email),
      photo_url: null, lat: null, lng: null, created_at: r.created_ms ? new Date(r.created_ms).toISOString() : null,
    }, 200, { 'Cache-Control': 'public, max-age=120' });
  }

  // RAV citizen "se ofreció" report.
  const r = await c.env.DB.prepare(
    `SELECT id, category, title, description, city, state, area, lat, lng, contact, photo_url, tags, created_at
       FROM rav_reports WHERE id = ? AND lower(coalesce(kind,'')) = 'voluntario' AND coalesce(hidden,0) = 0 LIMIT 1`,
  ).bind(id).first<any>().catch(() => null);
  if (!r) return c.json({ error: 'not_found' }, 404);
  // RAV rows have no skills field → derive them server-side (same classifier the
  // directory uses) so the profile page shows the same tags as the card.
  const skills = deriveSkills([r.title, r.description, r.area].filter(Boolean).join(' '));
  return c.json({
    ok: true, source: 'rav', id: r.id, full_name: r.title || 'Voluntario',
    city: r.city, state: r.state, area: r.area, skills,
    availability: null, has_vehicle: false, can_travel: false,
    experience: null, notes: r.description,
    ...maskContact(r.contact),
    photo_url: r.photo_url, lat: r.lat, lng: r.lng, category: r.category, created_at: r.created_at,
  }, 200, { 'Cache-Control': 'public, max-age=120' });
});

// GET /api/voluntarios/directory — the unified, paginated directory feed that
// powers the /voluntarios page. Reads the FULL dataset from BOTH sources
// (registered volunteers + RAV "se ofreció" reports), derives skill tags
// server-side, then returns:
//   • stats  — exact total + per-skill + per-group counts over the WHOLE dataset
//              (independent of pagination, so the header is always accurate);
//   • items  — the q/skill/availability-filtered, sorted, offset-paginated slice;
//   • filteredTotal / nextOffset — for the "Cargar más" control.
// Query: q, skill, availability, sort(recent|name|skills), offset, limit(≤100).
voluntarios.get('/directory', async (c) => {
  const q = (c.req.query('q') || '').trim().toLowerCase().slice(0, 80);
  const skill = (c.req.query('skill') || '').trim().toLowerCase().slice(0, 40);
  const availability = (c.req.query('availability') || '').trim().toLowerCase().slice(0, 20);
  const sort = (c.req.query('sort') || 'recent').trim().toLowerCase();
  const offset = Math.max(0, Number(c.req.query('offset')) || 0);
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 60, 1), 100);

  const [regRes, ravRes] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, full_name, city, state, area, skills, availability, has_vehicle, can_travel,
              experience, notes, contact_phone, email, created_ms
         FROM volunteers WHERE moderation='approved' AND status='activo'
         ORDER BY created_ms DESC LIMIT ?`,
    ).bind(SCAN_CAP).all<any>().catch(() => ({ results: [] as any[] })),
    c.env.DB.prepare(
      `SELECT id, title, description, city, state, area, lat, lng, contact, photo_url, created_at
         FROM rav_reports WHERE lower(coalesce(kind,''))='voluntario' AND coalesce(hidden,0)=0
         ORDER BY created_at DESC LIMIT ?`,
    ).bind(SCAN_CAP).all<any>().catch(() => ({ results: [] as any[] })),
  ]);

  const all = [
    ...((regRes.results ?? []).map((r) => normalizeRow({
      source: 'registered', id: r.id, full_name: r.full_name, city: r.city, state: r.state, area: r.area,
      skills: r.skills, availability: r.availability, has_vehicle: r.has_vehicle, can_travel: r.can_travel,
      experience: r.experience, notes: r.notes, contact_phone: r.contact_phone, email: r.email,
      created_at: r.created_ms ? new Date(r.created_ms).toISOString() : null,
    }))),
    ...((ravRes.results ?? []).map((r) => normalizeRow({
      source: 'rav', id: r.id, full_name: r.title, city: r.city, state: r.state, area: r.area,
      notes: r.description, contact_phone: r.contact, photo_url: r.photo_url, lat: r.lat, lng: r.lng,
      created_at: r.created_at,
    }))),
  ];

  // Exact stats over the FULL dataset (pre-filter) → header + chips never undercount.
  const stats = statsFromRows(all);

  // Apply filters.
  let rows = all.filter((v) => {
    if (skill && SKILLS.includes(skill) && !v.skills.includes(skill as any)) return false;
    if (availability && v.availability !== availability) return false;
    if (q) {
      const hay = [v.full_name, v.city, v.state, v.notes, v.experience, v.skills.join(' ')].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // Sort.
  if (sort === 'name') rows.sort((a, b) => a.full_name.localeCompare(b.full_name, 'es'));
  else if (sort === 'skills') rows.sort((a, b) => b.skills.length - a.skills.length);
  else rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

  const filteredTotal = rows.length;
  // Strip raw phone/email from the public directory (anti-scraping) — only
  // has_*/contact_mask; the full value comes from the gated /contact/:id reveal.
  const items = rows.slice(offset, offset + limit).map((v: any) => {
    const { contact_phone, email, ...rest } = v;
    return {
      ...rest,
      has_phone: !!String(contact_phone ?? '').replace(/\D/g, '').match(/\d{6,}/),
      has_email: !!String(email ?? '').includes('@'),
      contact_mask: maskPhone(contact_phone) || maskEmail(email),
    };
  });
  const nextOffset = offset + limit < filteredTotal ? offset + limit : null;

  return c.json(
    { ok: true, stats, filteredTotal, offset, limit, nextOffset, items },
    200, { 'Cache-Control': 'public, max-age=60' },
  );
});

// GET /api/voluntarios/contact/:id — the ONLY endpoint that returns a volunteer's
// full phone/email. Heavily rate-limited so bulk scraping is impractical; the UI
// hits it once when a human clicks the call/email icon. Resolves from both sources.
voluntarios.get('/contact/:id', async (c) => {
  const limited = await rateLimit(c.env, c, 'volunteer_contact', 20, 300);
  if (limited) return limited;
  const id = String(c.req.param('id') || '').trim().slice(0, 64);
  if (!id) return c.json({ error: 'id_required' }, 400);

  let phone: string | null = null; let email: string | null = null;
  if (id.startsWith('vol_')) {
    const r = await c.env.DB.prepare(
      `SELECT contact_phone, email FROM volunteers WHERE id = ? AND moderation='approved' AND status='activo' LIMIT 1`,
    ).bind(id).first<any>().catch(() => null);
    if (!r) return c.json({ error: 'not_found' }, 404);
    phone = r.contact_phone || null; email = r.email || null;
  } else {
    const r = await c.env.DB.prepare(
      `SELECT contact FROM rav_reports WHERE id = ? AND lower(coalesce(kind,''))='voluntario' AND coalesce(hidden,0)=0 LIMIT 1`,
    ).bind(id).first<any>().catch(() => null);
    if (!r) return c.json({ error: 'not_found' }, 404);
    const s = String(r.contact ?? '').trim();
    const em = s.match(/[^\s,;]+@[^\s,;]+\.[^\s,;]+/);
    email = em ? em[0] : null;
    phone = s.replace(/[^\d+]/g, '').replace(/\D/g, '').length >= 6 ? s.replace(/[^\d+]/g, '') : null;
  }
  const wa = phone ? phone.replace(/\D/g, '') : null;
  await audit(c, 'volunteer.contact.reveal', { id }).catch(() => {});
  return c.json({ ok: true, phone, email, wa }, 200, { 'Cache-Control': 'no-store' });
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
