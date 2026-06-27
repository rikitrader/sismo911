// src/middleware/secure-ingest.ts
//
// Hono middleware that runs the ingestion gate in front of a write handler.
// Extracts the body (JSON or multipart/form-data), runs runGate(), and on
// rejection returns a GENERIC error (with a correlation ref) — the handler never
// runs for blocked requests. On pass it stashes the validated data + correlation
// id on the context for the handler to use.
//
// Usage (see src/routes/secure-ingest-example.ts for full examples):
//
//   app.post('/api/contact',
//     secureIngest({ surface: 'contact', schema: ContactSchema,
//                    allowedFields: ['name','email','message'],
//                    nameFields: ['name'], textFields: ['message'], emailField: 'email',
//                    honeypotField: 'website', turnstile: 'optional' }),
//     async (c) => {
//       const { data, correlationId, payloadHash, score } = getClean(c);
//       // ... parameterized D1 write ...
//       await recordClean(c.env, c, { correlationId, surface: 'contact', destTable: 'contacts', destId: id, score, payloadHash });
//       return c.json({ ok: true, ref: correlationId });
//     });

import type { Context, MiddlewareHandler } from 'hono';
import type { z } from 'zod';
import type { Env } from '../types';
import {
  runGate,
  clientMessage,
  type GateConfig,
  type GatePass,
} from '../security/ingestion-gate';

const CLEAN_KEY = '__gateClean';

export interface SecureIngestConfig<S extends z.ZodTypeAny> extends GateConfig<S> {
  // Override which form-field carries the file (multipart). Defaults to file.fieldName.
  // Max bytes read into memory before scanning (defense against giant uploads);
  // defaults to env.MAX_FILE_SIZE.
  maxBodyBytes?: number;
}

/** Pull the validated, gate-approved payload off the context inside a handler. */
export function getClean<T = unknown>(c: Context): GatePass<T> {
  const v = c.get(CLEAN_KEY as never) as GatePass<T> | undefined;
  if (!v) throw new Error('getClean() called without secureIngest() middleware');
  return v;
}

async function extractBody(
  c: Context,
  cfg: SecureIngestConfig<z.ZodTypeAny>,
): Promise<{
  rawBody: string;
  file?: { bytes: Uint8Array; filename?: string | null; mime?: string | null };
  turnstileToken?: string | null;
}> {
  const ct = (c.req.header('content-type') ?? '').toLowerCase();
  // Multipart upload: collect non-file fields into a JSON object + read the file.
  if (cfg.file && ct.includes('multipart/form-data')) {
    const form = await c.req.raw.formData();
    const fields: Record<string, unknown> = {};
    let file: { bytes: Uint8Array; filename?: string | null; mime?: string | null } | undefined;
    const fileField = cfg.file.fieldName ?? 'file';
    let turnstileToken: string | null = null;
    for (const [k, v] of form.entries()) {
      if (k === 'cf-turnstile-response') {
        turnstileToken = typeof v === 'string' ? v : null;
        continue;
      }
      // FormDataEntryValue is `string | File`; a non-string entry is the file.
      if (typeof v === 'string') {
        fields[k] = v;
      } else if (k === fileField) {
        const f = v as File;
        const buf = new Uint8Array(await f.arrayBuffer());
        file = { bytes: buf, filename: f.name, mime: f.type };
      }
    }
    return { rawBody: JSON.stringify(fields), file, turnstileToken };
  }
  // JSON body.
  const rawBody = await c.req.raw.text();
  let turnstileToken: string | null = null;
  try {
    const j = JSON.parse(rawBody);
    turnstileToken = j?.['cf-turnstile-response'] ?? j?.turnstileToken ?? null;
  } catch {
    /* malformed JSON is caught by the gate */
  }
  return { rawBody, turnstileToken };
}

export function secureIngest<S extends z.ZodTypeAny>(
  cfg: SecureIngestConfig<S>,
): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    let extracted;
    try {
      extracted = await extractBody(c, cfg);
    } catch {
      // Body unreadable → fail closed with a generic 400.
      return c.json({ error: 'No pudimos procesar tu envío.', ref: null }, 400);
    }
    const result = await runGate(
      c.env,
      c,
      cfg,
      extracted.rawBody,
      extracted.file,
      extracted.turnstileToken,
    );
    if (!result.ok) {
      const msg = clientMessage(result);
      if (result.retryAfterSec) c.header('Retry-After', String(result.retryAfterSec));
      return c.json(msg, result.status);
    }
    c.set(CLEAN_KEY as never, result as never);
    await next();
  };
}
