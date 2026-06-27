// src/security/rate-limit.ts
//
// Abuse throttling for the gate. Layered:
//   1. per-IP burst limit   — reuses the project's atomic D1 limiter
//   2. per-account limit    — same limiter, keyed by user/api-client id
//   3. payload-hash replay  — "have we seen this exact content recently?"
//   4. (optional) Durable Object counter for cross-colo abuse counting
//
// Everything FAILS OPEN on infra error: a dropped throttle is recoverable, a
// dropped life-safety report is not. The gate decides what to do with the result;
// this module only measures.

import type { Context } from 'hono';
import type { Env } from '../types';
import { burstLimit, requestIp } from '../lib/security';

export interface RateDecision {
  limited: boolean;
  scope?: 'ip' | 'account' | 'replay' | 'do';
  retryAfterSec?: number;
}

/** Per-IP burst check. Thin wrapper over the existing D1 limiter so call sites
 *  get a structured decision instead of a Response. */
export async function ipRateLimit(
  env: Env,
  c: Context,
  name: string,
  limit: number,
  windowSec: number,
): Promise<RateDecision> {
  const res = await burstLimit(env, c, name, limit, windowSec);
  if (!res) return { limited: false };
  const retry = Number(res.headers.get('retry-after')) || windowSec;
  return { limited: true, scope: 'ip', retryAfterSec: retry };
}

/** Per-account burst check, keyed by a stable account id (user id / api-client
 *  id), independent of IP so one account can't fan out across many IPs. */
export async function accountRateLimit(
  env: Env,
  accountId: string,
  name: string,
  limit: number,
  windowSec: number,
): Promise<RateDecision> {
  const key = `acct:${name}:${accountId}`;
  const now = Date.now();
  const reset = now + windowSec * 1000;
  try {
    const row: any = await env.DB.prepare(
      `INSERT INTO rate_buckets (key, count, reset_ms) VALUES (?1, 1, ?2)
       ON CONFLICT(key) DO UPDATE SET
         count    = CASE WHEN reset_ms < ?3 THEN 1  ELSE count + 1 END,
         reset_ms = CASE WHEN reset_ms < ?3 THEN ?2 ELSE reset_ms  END
       RETURNING count, reset_ms`,
    ).bind(key, reset, now).first();
    const count = Number(row?.count ?? 0);
    if (count > limit) {
      const retry = Math.max(1, Math.ceil((Number(row?.reset_ms ?? reset) - now) / 1000));
      return { limited: true, scope: 'account', retryAfterSec: retry };
    }
  } catch {
    return { limited: false }; // fail open
  }
  return { limited: false };
}

export interface ReplayResult {
  seen: boolean;
  hits: number;
}

/** Record a content hash in ingest_dedupe and report whether it was already seen
 *  within `windowMs`. Used both for spam scoring (repeat payload) and to short-
 *  circuit identical resubmissions. Fails open (treated as unseen) on DB error. */
export async function checkAndRecordHash(
  env: Env,
  hash: string,
  kind: 'payload' | 'file',
  surface: string,
  windowMs = 24 * 60 * 60 * 1000,
): Promise<ReplayResult> {
  const now = Date.now();
  try {
    const prev = await env.DB.prepare(
      `SELECT hits, last_ms FROM ingest_dedupe WHERE hash = ?`,
    ).bind(hash).first<{ hits: number; last_ms: number }>();
    await env.DB.prepare(
      `INSERT INTO ingest_dedupe (hash, kind, surface, hits, first_ms, last_ms)
       VALUES (?1, ?2, ?3, 1, ?4, ?4)
       ON CONFLICT(hash) DO UPDATE SET hits = hits + 1, last_ms = ?4`,
    ).bind(hash, kind, surface, now).run();
    if (prev && now - Number(prev.last_ms) <= windowMs) {
      return { seen: true, hits: Number(prev.hits) + 1 };
    }
    return { seen: false, hits: prev ? Number(prev.hits) + 1 : 1 };
  } catch {
    return { seen: false, hits: 0 }; // fail open
  }
}

export { requestIp };

// ---------------------------------------------------------------------------
// Optional Durable Object abuse counter.
//
// The D1 limiter above is the default and is sufficient for this app. This DO is
// an OPTIONAL drop-in for high-fan-out abuse where you want a single strongly-
// consistent counter per key across all colos. Bind it in wrangler.toml:
//
//   [[durable_objects.bindings]]
//   name = "ABUSE_COUNTER"
//   class_name = "AbuseCounter"
//   [[migrations]]
//   tag = "v1"
//   new_classes = ["AbuseCounter"]
//
// and export it from src/index.ts: `export { AbuseCounter } from './security/rate-limit';`
// ---------------------------------------------------------------------------

export class AbuseCounter {
  private state: DurableObjectState;
  constructor(state: DurableObjectState) {
    this.state = state;
  }

  // POST /incr  body: { limit, windowSec }  → { count, limited, resetMs }
  async fetch(req: Request): Promise<Response> {
    const { limit = 30, windowSec = 60 } = (await req.json().catch(() => ({}))) as {
      limit?: number;
      windowSec?: number;
    };
    const now = Date.now();
    let reset = (await this.state.storage.get<number>('reset')) ?? 0;
    let count = (await this.state.storage.get<number>('count')) ?? 0;
    if (now > reset) {
      reset = now + windowSec * 1000;
      count = 0;
    }
    count += 1;
    await this.state.storage.put({ reset, count });
    return Response.json({ count, limited: count > limit, resetMs: reset });
  }
}

/** Optional helper: increment the DO counter for a key. Returns a RateDecision.
 *  Falls back to "not limited" when the binding is absent (so it is never required). */
export async function doRateLimit(
  env: Env,
  key: string,
  limit: number,
  windowSec: number,
): Promise<RateDecision> {
  if (!env.ABUSE_COUNTER) return { limited: false };
  try {
    const id = env.ABUSE_COUNTER.idFromName(key);
    const stub = env.ABUSE_COUNTER.get(id);
    const res = await stub.fetch('https://do/incr', {
      method: 'POST',
      body: JSON.stringify({ limit, windowSec }),
    });
    const { limited, resetMs } = (await res.json()) as { limited: boolean; resetMs: number };
    if (limited) return { limited: true, scope: 'do', retryAfterSec: Math.max(1, Math.ceil((resetMs - Date.now()) / 1000)) };
  } catch {
    return { limited: false }; // fail open
  }
  return { limited: false };
}
