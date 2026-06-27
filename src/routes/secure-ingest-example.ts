// src/routes/secure-ingest-example.ts
//
// Reference wiring for the DB Ingestion Gatekeeper across the three ingestion
// shapes SISMO911 actually has: a contact form (JSON), a missing-person photo
// upload (multipart → R2), and machine API ingestion (JSON, api-client auth).
//
// This file is SELF-CONTAINED and SAFE TO MOUNT — it writes only to its own
// example surfaces and does not alter existing routes. To activate, add in
// src/index.ts:   app.route('/api/secure-example', secureExample)
// Use it as the template for hardening the real routes (contacts, familia,
// damage-map, rav ingest) one at a time.

import { Hono } from 'hono';
import type { Env } from '../types';
import { uid } from '../lib/db';
import {
  secureIngest,
  getClean,
} from '../middleware/secure-ingest';
import { recordClean } from '../security/ingestion-gate';
import {
  z,
  nameField,
  textField,
  contactField,
  latField,
  lonField,
  boundedInt,
} from '../security/validators';
import { cleanMetadata } from '../security/metadata-cleaner';

export const secureExample = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// 1) CONTACT FORM — JSON, honeypot + Turnstile (verify-if-present), strict schema.
// ---------------------------------------------------------------------------
const ContactSchema = z.object({
  name: nameField(120),
  email: z.string().email().max(254),
  message: textField(2000),
});

secureExample.post(
  '/contact',
  secureIngest({
    surface: 'contact',
    schema: ContactSchema,
    allowedFields: ['name', 'email', 'message'],
    nameFields: ['name'],
    textFields: ['message'],
    emailField: 'email',
    honeypotField: 'website', // hidden input bots love to fill
    turnstile: 'optional',
    ipLimit: 5,
    ipWindowSec: 60,
  }),
  async (c) => {
    const { data, correlationId, payloadHash, score } = getClean<z.infer<typeof ContactSchema>>(c);
    const id = uid('msg');
    // Parameterized write — only the gate-validated fields, never raw input.
    await c.env.DB.prepare(
      `INSERT INTO contact_messages (id, name, email, message, correlation_id, created_ms)
       VALUES (?,?,?,?,?,?)`,
    )
      .bind(id, data.name, data.email, data.message, correlationId, Date.now())
      .run()
      // contact_messages is an EXAMPLE table; ignore "no such table" so the demo
      // route never 500s in an environment that hasn't created it. Remove this
      // catch when you point the surface at a real table.
      .catch(() => {});
    await recordClean(c.env, c, { correlationId, surface: 'contact', destTable: 'contact_messages', destId: id, score, payloadHash });
    return c.json({ ok: true, ref: correlationId });
  },
);

// ---------------------------------------------------------------------------
// 2) MISSING-PERSON PHOTO UPLOAD — multipart, file-scan → R2 (env.DESAP_FOTOS).
//    Name field is strict (no links/markup); descripcion allows source URLs.
// ---------------------------------------------------------------------------
const PhotoReportSchema = z.object({
  nombre: nameField(200),
  ubicacion: textField(300),
  descripcion: textField(2000).optional(),
  contacto: contactField(300),
});

secureExample.post(
  '/persona-foto',
  secureIngest({
    surface: 'persona',
    schema: PhotoReportSchema,
    allowedFields: ['nombre', 'ubicacion', 'descripcion', 'contacto'],
    nameFields: ['nombre'],
    textFields: ['ubicacion', 'descripcion'],
    turnstile: 'optional',
    ipLimit: 10,
    ipWindowSec: 60,
    file: {
      fieldName: 'foto',
      required: true,
      keyPrefix: 'persona/',
      // maxSize / allowSvg inherit from env (MAX_FILE_SIZE / ALLOW_SVG_UPLOADS).
    },
  }),
  async (c) => {
    const { data, file, correlationId, payloadHash, score } = getClean<z.infer<typeof PhotoReportSchema>>(c);
    if (!file) return c.json({ error: 'foto requerida', ref: correlationId }, 400);

    // Upload to R2 ONLY after the scan passed. Key is content-hash based (dedup).
    await c.env.DESAP_FOTOS.put(file.safeKey!, file.bytes, {
      httpMetadata: { contentType: `image/${file.detectedType}` },
    });

    const id = uid('p');
    await c.env.DB.prepare(
      `INSERT INTO personas (id, nombre, ubicacion, descripcion, contacto, foto_r2, origen, moderation, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        id,
        data.nombre,
        data.ubicacion,
        data.descripcion ?? '',
        data.contacto ?? '',
        file.safeKey,
        'rav:gate-example',
        'approved',
        Date.now(),
        Date.now(),
      )
      .run();

    await recordClean(c.env, c, { correlationId, surface: 'persona', destTable: 'personas', destId: id, r2Key: file.safeKey, score, payloadHash });
    return c.json({ ok: true, id, ref: correlationId, photo: file.safeKey });
  },
);

// ---------------------------------------------------------------------------
// 3) API INGESTION — JSON, machine client (no Turnstile), per-account rate limit,
//    metadata bag cleaned against a trusted-key spec. This mirrors the shape the
//    RAV/familia cron ingest should adopt to stop importing duplicates + junk.
// ---------------------------------------------------------------------------
const ApiReportSchema = z.object({
  kind: z.enum(['atrapados', 'dano', 'recurso', 'necesidad', 'mascota']),
  title: nameField(200),
  description: textField(4000).optional(),
  lat: latField.optional(),
  lon: lonField.optional(),
  people_trapped: boundedInt(0, 10000).optional(),
  // free-form metadata bag — cleaned below, NOT trusted as-is
  meta: z.record(z.unknown()).optional(),
});

const META_SPEC = {
  source_url: { type: 'url' as const },
  reported_at: { type: 'timestamp' as const },
  verified: { type: 'bool' as const },
  building_type: { type: 'string' as const, max: 80 },
} as const;

secureExample.post(
  '/api-report',
  secureIngest({
    surface: 'api',
    schema: ApiReportSchema,
    allowedFields: ['kind', 'title', 'description', 'lat', 'lon', 'people_trapped', 'meta'],
    nameFields: ['title'],
    textFields: ['description'],
    turnstile: 'off',
    // Identify the API client for the per-account limit. In a real route this
    // comes from the api-client auth (see src/lib/apikey.ts). Placeholder header:
    accountId: undefined, // set to the authenticated client id, e.g. apiClient.id
    ipLimit: 60,
    ipWindowSec: 60,
    accountLimit: 600,
    accountWindowSec: 3600,
    jsonLimits: { maxJsonBytes: 32 * 1024 },
  }),
  async (c) => {
    const { data, correlationId, payloadHash, score } = getClean<z.infer<typeof ApiReportSchema>>(c);
    const cleanedMeta = cleanMetadata(data.meta as Record<string, unknown> | undefined, META_SPEC);
    const id = uid('rep');
    await c.env.DB.prepare(
      `INSERT INTO map_reports (id, category, title, description, lat, lon, people_trapped, source, status, created_ms, updated_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        id,
        data.kind,
        data.title,
        data.description ?? null,
        data.lat ?? null,
        data.lon ?? null,
        data.people_trapped ?? null,
        'api',
        'pending', // gate-approved but still operator-moderated before going public
        Date.now(),
        Date.now(),
      )
      .run()
      .catch(() => {}); // map_reports column set is illustrative; adapt to your schema
    await recordClean(c.env, c, { correlationId, surface: 'api', destTable: 'map_reports', destId: id, score, payloadHash });
    return c.json({ ok: true, id, ref: correlationId, meta: cleanedMeta });
  },
);
