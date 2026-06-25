# 0001 — Cloudflare Workers + Hono + D1 for SISMO911

**Status:** Accepted · 2026-06-24

## Context

SISMO911 is a national seismic emergency platform for Venezuela. Signals from the
brief: read-heavy public dashboard, national scale, real-time-ish (USGS polled),
edge/no-servers preference, existing static `index.html` + `pager.html` to migrate,
and pluggable ingestion (social, government, missing persons) where most sources
have no open API.

## Decision

- **Edge serverless on Cloudflare Workers** with **Static Assets** serving the
  three HTML surfaces and **Hono 4** handling `/api/*`.
- **D1** (SQLite) for relational data: events, persons, contacts, reports, ingest_log.
- **KV** as the hot cache for the latest normalized USGS payload.
- **Cron Trigger** (1-min) mirrors the USGS FDSN GeoJSON feed into KV + D1 so the
  client never depends on USGS being reachable and we control the region/window.
- **Typed adapter interfaces** for social + government data, stubbed until credentials.

## Alternatives considered

- **Next.js 16 on OpenNext/Cloudflare** — richer app framework, but heavier, more CF
  build gotchas, and overkill for a read-heavy dashboard whose UI already exists as
  static HTML. Rejected for v1; revisit if the UI grows into a large authed SPA.
- **Cloudflare Queues for ingestion** — deferred: USGS volume for one country is tiny;
  a Cron→D1 inline write is simpler and free-tier friendly. Add Queues when fanning
  out to multiple social sources.

## Consequences

- Locks in: Cloudflare account, Hono routing, D1 schema, KV cache key.
- Leaves flexible: each social/gov source is one adapter file; swapping in real APIs
  doesn't touch routes or the DB. Auth (Cloudflare Access) can wrap `/admin.html`
  and write endpoints without restructuring.
