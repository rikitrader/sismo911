// src/security/ingestion-gate.ts
//
// The orchestrator. Runs the full ingestion pipeline for a single submission and
// returns a structured verdict. The Hono middleware (src/middleware/secure-ingest.ts)
// is the usual entry point, but the gate is callable directly from cron ingests
// (RAV / familia sync) too — that is where most of SISMO911's data actually comes
// from, and where the dedupe step matters most.
//
//   rate-limit → turnstile → schema (zod) → spam-score → metadata-clean →
//   file-scan (if upload) → dedupe-hash → verdict (+ audit ledger write)
//
// SECURITY POSTURE:
//   • Fail CLOSED: any unexpected error → reject with a generic reason.
//   • The caller gets a generic message; the detailed reason is logged + stored.
//   • Never echo the offending payload back to the client.
//   • Every request gets a correlation id threaded through logs + ledger tables.

import type { Context } from 'hono';
import type { z } from 'zod';
import type { Env } from '../types';
import { uid } from '../lib/db';
import { requestIp } from '../lib/security';
import { parseJsonSafely, enforceAllowlist, normalizeString, LIMITS } from './validators';
import { scoreSpam, type ScoreInput } from './spam-score';
import { checkAndRecordHash, ipRateLimit, accountRateLimit } from './rate-limit';
import { scanFile, sha256Hex, type FileScanResult, type ScanOpts } from './file-scan';

// Stable machine reason codes (also referenced by migration 0028 comments).
export const REASON_CODES = {
  RATE_LIMIT_IP: 'rate_limit_ip',
  RATE_LIMIT_ACCOUNT: 'rate_limit_account',
  TURNSTILE_FAILED: 'turnstile_failed',
  TURNSTILE_MISSING: 'turnstile_missing',
  ORIGIN_BLOCKED: 'origin_blocked',
  COUNTRY_BLOCKED: 'country_blocked',
  OVERSIZED: 'oversized',
  MALFORMED_JSON: 'malformed_json',
  TOO_DEEP: 'too_deep',
  TOO_MANY_KEYS: 'too_many_keys',
  UNKNOWN_FIELDS: 'unknown_fields',
  SCHEMA_INVALID: 'schema_invalid',
  SPAM_SCORE: 'spam_score',
  FILE_REJECTED: 'file_rejected',
  REPLAY: 'replay_duplicate',
  INTERNAL: 'internal_error',
} as const;
export type ReasonCode = (typeof REASON_CODES)[keyof typeof REASON_CODES];

export interface GateConfig<S extends z.ZodTypeAny> {
  surface: string; // 'contact' | 'photo' | 'persona' | 'map_report' | 'api'
  schema: S; // zod schema for the JSON body
  allowedFields: readonly string[]; // strict key allowlist
  // Rate limits.
  ipLimit?: number;
  ipWindowSec?: number;
  accountId?: string | null; // when present, also enforce a per-account limit
  accountLimit?: number;
  accountWindowSec?: number;
  // Turnstile: 'required' enforces (when a secret is configured), 'optional'
  // verifies-if-present, 'off' skips.
  turnstile?: 'required' | 'optional' | 'off';
  honeypotField?: string; // name of the hidden honeypot input
  // Which validated string fields are NAMES (strict) vs free TEXT (links ok).
  nameFields?: readonly string[];
  textFields?: readonly string[];
  emailField?: string;
  jsonLimits?: Partial<typeof LIMITS>;
  // File upload (multipart) handling — omit for JSON-only surfaces.
  file?: ScanOpts & { fieldName?: string; required?: boolean };
  spamThresholdOverride?: number;
  // Skip the gate's own per-IP rate limit. Set when the calling route already
  // rate-limits (e.g. reports/familia call rateLimit() before runGate) so we
  // don't double-count the same request against two buckets.
  skipRateLimit?: boolean;
}

export interface GateReject {
  ok: false;
  status: 400 | 403 | 413 | 429;
  reason: ReasonCode;
  detail: string;
  correlationId: string;
  retryAfterSec?: number;
}
export interface GatePass<T> {
  ok: true;
  data: T; // validated + normalized fields
  correlationId: string;
  score: number;
  payloadHash: string;
  file?: FileScanResult & { bytes: Uint8Array };
}
export type GateResult<T> = GateReject | GatePass<T>;

// ---------------------------------------------------------------------------
// Turnstile
// ---------------------------------------------------------------------------
export async function verifyTurnstile(
  env: Env,
  token: string | null | undefined,
  ip: string,
): Promise<{ ok: boolean; skipped: boolean }> {
  if (!env.TURNSTILE_SECRET_KEY) return { ok: true, skipped: true }; // not configured → skip
  if (!token) return { ok: false, skipped: false };
  try {
    const body = new FormData();
    body.append('secret', env.TURNSTILE_SECRET_KEY);
    body.append('response', token);
    if (ip && ip !== 'unknown') body.append('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    const data = (await res.json()) as { success: boolean };
    return { ok: !!data.success, skipped: false };
  } catch {
    return { ok: false, skipped: false }; // fail closed on verify error
  }
}

function envInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function cf(c: Context): { country?: string; asn?: number } {
  const meta = (c.req.raw as any).cf ?? {};
  return { country: meta.country, asn: meta.asn };
}

/** Structured JSON log line — one per gate decision. Never includes raw payload. */
function logGate(decision: Record<string, unknown>) {
  // console.* is captured by Workers observability (wrangler.toml [observability]).
  console.log(JSON.stringify({ gate: true, ...decision }));
}

async function recordReject(
  env: Env,
  c: Context,
  cfg: { surface: string },
  r: GateReject,
  meta: { ip: string; score?: number; payloadHash?: string; sample?: string },
) {
  const { country, asn } = cf(c);
  logGate({
    correlationId: r.correlationId,
    surface: cfg.surface,
    outcome: 'reject',
    reason: r.reason,
    status: r.status,
    score: meta.score,
    ip: meta.ip,
    country,
  });
  try {
    await env.DB.prepare(
      `INSERT INTO rejected_ingestions
        (id, correlation_id, surface, reason, detail, score, ip, asn, country, user_agent, payload_hash, sample, created_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        uid('rej'),
        r.correlationId,
        cfg.surface,
        r.reason,
        r.detail.slice(0, 1000),
        meta.score ?? null,
        meta.ip,
        asn ?? null,
        country ?? null,
        (c.req.header('user-agent') ?? '').slice(0, 300),
        meta.payloadHash ?? null,
        (meta.sample ?? '').slice(0, 512),
        Date.now(),
      )
      .run();
  } catch (e) {
    logGate({ correlationId: r.correlationId, surface: cfg.surface, ledgerError: String(e) });
  }
}

/** Record an accepted submission. Call AFTER the destination write so dest_id/r2
 *  are known. Best-effort (never throws). */
export async function recordClean(
  env: Env,
  c: Context,
  args: {
    correlationId: string;
    surface: string;
    destTable?: string;
    destId?: string;
    r2Key?: string;
    score: number;
    payloadHash: string;
  },
) {
  const { country } = cf(c);
  logGate({
    correlationId: args.correlationId,
    surface: args.surface,
    outcome: 'accept',
    destTable: args.destTable,
    destId: args.destId,
    score: args.score,
  });
  try {
    await env.DB.prepare(
      `INSERT INTO clean_ingestions
        (id, correlation_id, surface, dest_table, dest_id, r2_key, score, ip, country, payload_hash, created_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        uid('cln'),
        args.correlationId,
        args.surface,
        args.destTable ?? null,
        args.destId ?? null,
        args.r2Key ?? null,
        args.score,
        requestIp(c),
        country ?? null,
        args.payloadHash,
        Date.now(),
      )
      .run();
  } catch (e) {
    logGate({ ledger: 'clean_ingestions', error: String(e).slice(0, 300) });
  }
}

/**
 * Run the gate. `rawBody` is the JSON string (already extracted from the request
 * by the middleware) and `fileBytes` the optional uploaded bytes. Returns a
 * verdict; on reject it has already been logged + stored. The caller still owns
 * the destination write and should call recordClean() afterwards.
 */
export async function runGate<S extends z.ZodTypeAny>(
  env: Env,
  c: Context,
  cfg: GateConfig<S>,
  rawBody: string,
  file?: { bytes: Uint8Array; filename?: string | null; mime?: string | null },
  turnstileToken?: string | null,
): Promise<GateResult<z.infer<S>>> {
  const correlationId = uid('cid');
  const ip = requestIp(c);
  const reject = (
    status: GateReject['status'],
    reason: ReasonCode,
    detail: string,
    extra?: { retryAfterSec?: number; score?: number; payloadHash?: string; sample?: string },
  ): GateReject => {
    const r: GateReject = { ok: false, status, reason, detail, correlationId, retryAfterSec: extra?.retryAfterSec };
    // The ledger write must outlive the response — register it with waitUntil so
    // it isn't dropped when the Worker returns. Falls back to a bare promise when
    // no executionCtx (cron/test) is available.
    const p = recordReject(env, c, cfg, r, { ip, score: extra?.score, payloadHash: extra?.payloadHash, sample: extra?.sample });
    try { c.executionCtx?.waitUntil(p); } catch { void p; }
    return r;
  };

  try {
    const { country } = cf(c);

    // 0. Country block (optional).
    const blocked = (env.COUNTRY_BLOCKLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (country && blocked.includes(country)) return reject(403, REASON_CODES.COUNTRY_BLOCKED, `country ${country}`);

    // 1. Rate limits (skippable when the caller already rate-limited).
    if (!cfg.skipRateLimit) {
      const ipDec = await ipRateLimit(env, c, `gate:${cfg.surface}`, cfg.ipLimit ?? 20, cfg.ipWindowSec ?? 60);
      if (ipDec.limited) return reject(429, REASON_CODES.RATE_LIMIT_IP, 'ip rate limit', { retryAfterSec: ipDec.retryAfterSec });
    }
    if (cfg.accountId) {
      const aDec = await accountRateLimit(env, cfg.accountId, `gate:${cfg.surface}`, cfg.accountLimit ?? 60, cfg.accountWindowSec ?? 3600);
      if (aDec.limited) return reject(429, REASON_CODES.RATE_LIMIT_ACCOUNT, 'account rate limit', { retryAfterSec: aDec.retryAfterSec });
    }

    // 2. Turnstile.
    const mode = cfg.turnstile ?? 'off';
    if (mode !== 'off') {
      const t = await verifyTurnstile(env, turnstileToken, ip);
      if (!t.skipped && !t.ok) return reject(403, REASON_CODES.TURNSTILE_FAILED, 'turnstile verification failed');
      if (mode === 'required' && t.skipped && env.TURNSTILE_SECRET_KEY) {
        // secret set but token absent path is handled inside verifyTurnstile;
        // skipped only happens when no secret configured.
      }
    }

    // 3. JSON shape + parse.
    const shape = parseJsonSafely(rawBody, cfg.jsonLimits);
    if (!shape.ok) {
      const map: Record<string, ReasonCode> = {
        oversized: REASON_CODES.OVERSIZED,
        malformed_json: REASON_CODES.MALFORMED_JSON,
        too_deep: REASON_CODES.TOO_DEEP,
        too_many_keys: REASON_CODES.TOO_MANY_KEYS,
      };
      const status = shape.reason === 'oversized' ? 413 : 400;
      return reject(status, map[shape.reason!] ?? REASON_CODES.MALFORMED_JSON, shape.reason!);
    }
    const obj = (shape.value ?? {}) as Record<string, unknown>;

    // 4. Strict field allowlist (drop honeypot + turnstile token from the data
    //    surface first so they don't count as "unknown").
    const reserved = new Set([cfg.honeypotField, 'cf-turnstile-response', 'turnstileToken'].filter(Boolean) as string[]);
    const honeypotValue = cfg.honeypotField ? (obj[cfg.honeypotField] as string | undefined) : undefined;
    const probe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) if (!reserved.has(k)) probe[k] = v;
    const al = enforceAllowlist(probe, cfg.allowedFields, true);
    if (!al.ok) return reject(400, REASON_CODES.UNKNOWN_FIELDS, `unknown fields: ${al.unknownKeys.join(',')}`);

    // 5. Schema validation (zod normalizes/coerces).
    const parsed = cfg.schema.safeParse(al.picked);
    if (!parsed.success) {
      const detail = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return reject(400, REASON_CODES.SCHEMA_INVALID, detail);
    }
    const data = parsed.data as Record<string, unknown>;

    // 6. Payload hash (post-normalization) for replay detection + dedupe ledger.
    const canonical = JSON.stringify(data, Object.keys(data).sort());
    const payloadHash = await sha256Hex(new TextEncoder().encode(canonical));
    const replay = await checkAndRecordHash(env, payloadHash, 'payload', cfg.surface);

    // 7. Spam scoring.
    const pick = (fields?: readonly string[]) =>
      (fields ?? []).map((f) => ({ field: f, value: (data[f] as string | undefined) ?? null }));
    const scoreInput: ScoreInput = {
      names: pick(cfg.nameFields),
      texts: pick(cfg.textFields),
      email: cfg.emailField ? ((data[cfg.emailField] as string | undefined) ?? null) : null,
      honeypot: honeypotValue ?? null,
      userAgent: c.req.header('user-agent') ?? null,
      repeatHash: replay.seen,
      extraDisposable: new Set((env.EMAIL_BLOCKLIST ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)),
    };
    const { score, signals } = scoreSpam(scoreInput);
    const threshold = cfg.spamThresholdOverride ?? envInt(env.SPAM_THRESHOLD, 100);
    const sample = Object.values(data).map((v) => (typeof v === 'string' ? v : '')).join(' ').slice(0, 512);
    if (score >= threshold) {
      return reject(400, REASON_CODES.SPAM_SCORE, `score ${score} >= ${threshold} [${signals.map((s) => s.code).join(',')}]`, {
        score,
        payloadHash,
        sample,
      });
    }

    // 8. File scan (if this surface accepts an upload).
    let scanned: (FileScanResult & { bytes: Uint8Array }) | undefined;
    if (cfg.file) {
      if (!file?.bytes?.length) {
        if (cfg.file.required) return reject(400, REASON_CODES.FILE_REJECTED, 'file required');
      } else {
        const res = await scanFile(file.bytes, {
          ...cfg.file,
          declaredMime: file.mime,
          filename: file.filename,
          maxSize: cfg.file.maxSize ?? envInt(env.MAX_FILE_SIZE, 8 * 1024 * 1024),
          allowSvg: cfg.file.allowSvg ?? /^(1|true)$/i.test(env.ALLOW_SVG_UPLOADS ?? ''),
        });
        if (!res.ok) return reject(400, REASON_CODES.FILE_REJECTED, `${res.reason}${res.detail ? `: ${res.detail}` : ''}`, { payloadHash });
        // File content dedupe — a re-uploaded identical image is fine to accept
        // but we record it; the score already covered repeat payloads.
        if (res.sha256) await checkAndRecordHash(env, res.sha256, 'file', cfg.surface);
        scanned = { ...res, bytes: file.bytes };
      }
    }

    logGate({ correlationId, surface: cfg.surface, outcome: 'pass', score, country });
    return { ok: true, data: parsed.data, correlationId, score, payloadHash, file: scanned };
  } catch (e) {
    // Fail CLOSED — any unexpected error rejects with a generic reason.
    return reject(400, REASON_CODES.INTERNAL, `internal: ${String(e).slice(0, 200)}`);
  }
}

/** Generic client-facing message — never leak the internal reason. */
export function clientMessage(r: GateReject): { error: string; ref: string } {
  const friendly =
    r.status === 429
      ? 'Demasiadas solicitudes. Intenta de nuevo en un momento.'
      : r.status === 413
        ? 'El contenido es demasiado grande.'
        : 'No pudimos procesar tu envío. Verifica los datos e intenta de nuevo.';
  return { error: friendly, ref: r.correlationId };
}

// ===========================================================================
// gateRow — context-free, ZERO-D1 validator for cron/server ingests.
//
// The cron jobs (rav-cron, familia-cron, sos-damage sync) receive only `env`,
// not a Hono Context, and process up to thousands of rows per tick — so they
// CANNOT use runGate() (needs Context) and MUST NOT do per-row D1 work (Workers
// subrequest budget). gateRow() runs the same validation CORE — normalize →
// strict allowlist → zod → spam score — purely in memory. No rate limit, no
// Turnstile, no replay ledger, no file scan. Use it to drop junk/spam/markup
// rows before a bulk upsert.
// ===========================================================================

export interface GateRowConfig<S extends z.ZodTypeAny> {
  schema: S;
  allowedFields: readonly string[];
  nameFields?: readonly string[];
  textFields?: readonly string[];
  emailField?: string;
  spamThreshold?: number; // default 100
}

export type GateRowResult<T> =
  | { ok: true; data: T; score: number; reasons: string[] }
  | { ok: false; reason: ReasonCode; score: number; reasons: string[]; detail: string };

/** Validate one already-parsed object (a mapped scrape row). Pure + sync. */
export function gateRow<S extends z.ZodTypeAny>(
  input: Record<string, unknown>,
  cfg: GateRowConfig<S>,
): GateRowResult<z.infer<S>> {
  // 1. Strict allowlist (extra scrape fields are dropped, not rejected — sources
  //    legitimately carry columns we don't store).
  const al = enforceAllowlist(input, cfg.allowedFields, false);

  // 2. Schema (zod normalizes/coerces; nameField/textField strip markup + cap).
  const parsed = cfg.schema.safeParse(al.picked);
  if (!parsed.success) {
    const detail = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { ok: false, reason: REASON_CODES.SCHEMA_INVALID, score: 0, reasons: ['schema'], detail };
  }
  const data = parsed.data as Record<string, unknown>;

  // 3. Spam score (markup/link-spam in names, spam phrases, hidden unicode).
  const pick = (fields?: readonly string[]) =>
    (fields ?? []).map((f) => ({ field: f, value: (data[f] as string | undefined) ?? null }));
  const { score, signals } = scoreSpam({
    names: pick(cfg.nameFields),
    texts: pick(cfg.textFields),
    email: cfg.emailField ? ((data[cfg.emailField] as string | undefined) ?? null) : null,
    // No request context in a cron: a present, non-bot UA is assumed. Passing a
    // placeholder avoids the "missing UA" penalty firing on every trusted row.
    userAgent: 'cron',
  });
  const reasons = signals.map((s) => s.code);
  const threshold = cfg.spamThreshold ?? 100;
  if (score >= threshold) {
    return { ok: false, reason: REASON_CODES.SPAM_SCORE, score, reasons, detail: reasons.join(',') };
  }
  return { ok: true, data: parsed.data, score, reasons };
}

export interface RejectedRow {
  surface: string;
  reason: ReasonCode;
  detail?: string;
  score?: number;
  sample?: string;
}

/** Batch-insert rejected cron rows in ONE D1 statement (stays within the
 *  subrequest budget — never call per row). Best-effort; never throws. Caps the
 *  batch so a flood can't blow the SQL variable limit. */
export async function recordRejectedBatch(
  env: Env,
  rows: RejectedRow[],
  correlationId = uid('cid'),
): Promise<void> {
  if (!rows.length) return;
  const now = Date.now();
  // 8 binds/row; keep each INSERT under D1's ~100-param cap → 10 rows/statement.
  // One statement covers the common case; a heavy-reject tick spills to a few.
  const capped = rows.slice(0, 30);
  try {
    for (let i = 0; i < capped.length; i += 10) {
      const batch = capped.slice(i, i + 10);
      const valuesSql = batch.map(() => '(?,?,?,?,?,?,?,?)').join(',');
      const binds: unknown[] = [];
      for (const r of batch) {
        binds.push(uid('rej'), correlationId, r.surface, r.reason, (r.detail ?? '').slice(0, 1000), r.score ?? null, (r.sample ?? '').slice(0, 512), now);
      }
      await env.DB.prepare(
        `INSERT INTO rejected_ingestions (id, correlation_id, surface, reason, detail, score, sample, created_ms)
         VALUES ${valuesSql}`,
      ).bind(...binds).run();
    }
  } catch {
    // ledger best-effort; also emit a single structured log line for the batch.
    logGate({ correlationId, outcome: 'reject-batch', count: capped.length });
  }
}

// Re-export the row-level normalizer for cron mappers that want to clean a field
// before building the row object.
export { normalizeString };
