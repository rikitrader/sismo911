import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { audit } from '../lib/audit';
import { runGate, clientMessage, recordClean } from '../security/ingestion-gate';
import { z, nameField, textField, contactField, latField, lonField } from '../security/validators';

export const contacts = new Hono<{ Bindings: Env }>();

// Directory-entry gate. agency is the strict name field; radio/region are free
// text (link-checked via the spam score); email is validated; coords bounded.
// id/flags ride along. Operator-curated, so the threshold stays lenient — the
// point is to block injection + audit every write, not to fight a spam flood.
const ContactSchema = z.object({
  id: z.string().max(80).optional(),
  agency: nameField(160),
  category: z.string().min(1).max(60).transform((s) => s.trim()),
  region: textField(160).optional(),
  phone: contactField(80),
  alt_phone: contactField(80),
  radio: textField(120).optional(),
  email: z.string().email().max(254).optional().or(z.literal('')),
  lat: latField.optional(),
  lon: lonField.optional(),
  is_hotline: z.coerce.boolean().optional(),
  source: z.string().max(60).optional(),
  verified: z.coerce.boolean().optional(),
});
const CONTACT_FIELDS = [
  'id', 'agency', 'category', 'region', 'phone', 'alt_phone', 'radio', 'email',
  'lat', 'lon', 'is_hotline', 'source', 'verified',
] as const;

// GET /api/contacts?category=civil_protection&region=Falcón
contacts.get('/', async (c) => {
  const cat = c.req.query('category');
  const region = c.req.query('region');
  const where: string[] = [];
  const binds: unknown[] = [];
  if (cat) { where.push('category = ?'); binds.push(cat); }
  if (region) { where.push('region = ?'); binds.push(region); }
  const sql = `SELECT * FROM contacts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY is_hotline DESC, agency ASC`;
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all();
  return c.json({ contacts: results ?? [] });
});

// POST /api/contacts — add/curate a directory entry (admin).
contacts.post('/', async (c) => {
  const raw = await c.req.raw.text();
  const gate = await runGate(c.env, c, {
    surface: 'contact',
    schema: ContactSchema,
    allowedFields: CONTACT_FIELDS,
    nameFields: ['agency'],
    textFields: ['region', 'radio'],
    emailField: 'email',
    ipLimit: 20,
    ipWindowSec: 60,
  }, raw);
  if (!gate.ok) {
    if (gate.retryAfterSec) c.header('Retry-After', String(gate.retryAfterSec));
    return c.json(clientMessage(gate), gate.status);
  }
  const b = gate.data;
  const id = b.id ?? uid('con');
  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO contacts (id, agency, category, region, phone, alt_phone, radio, email, lat, lon, is_hotline, source, verified_ms, created_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, b.agency, b.category, b.region ?? null, b.phone ?? null, b.alt_phone ?? null,
    b.radio ?? null, b.email || null, b.lat ?? null, b.lon ?? null,
    b.is_hotline ? 1 : 0, b.source ?? 'manual', b.verified ? Date.now() : null, Date.now()
  ).run();
  await recordClean(c.env, c, { correlationId: gate.correlationId, surface: 'contact', destTable: 'contacts', destId: id, score: gate.score, payloadHash: gate.payloadHash });
  await audit(c, 'contacts.upsert', { id, category: b.category, region: b.region ?? null });
  return c.json({ ok: true, id, ref: gate.correlationId }, 201);
});
