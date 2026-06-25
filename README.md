# SISMO911

National seismic emergency platform for Venezuela. Live USGS earthquake feed, an
operations dashboard, USGS-style PAGER impact reports, a missing-persons registry,
and a national emergency-contact directory — on Cloudflare's edge.

> **Data-source honesty.** USGS is a real, live feed. Social ingestion
> (X/Facebook/Instagram/TikTok) and government data (Protección Civil / FUNVISIS /
> defense directories, missing persons) are **typed adapters + admin-entered data**,
> not magic connections to closed government systems. Adapters return nothing until
> real credentials/partnerships are configured. See `src/adapters/`.

## Architecture

```
Browser ──► Cloudflare Worker (Hono)
  public/ (static)         /api/* (JSON)
  • index.html  dashboard     ├─ events    (USGS mirror, D1 + KV)
  • pager.html  impact report ├─ persons   (missing-persons CRUD)
  • admin.html  ops console    ├─ contacts  (emergency directory)
                               └─ status    (ingest + adapter health)
        │
        ├─ D1   (events, persons, contacts, reports, ingest_log)
        ├─ KV   (hot cache: latest normalized USGS payload)
        └─ Cron (* * * * *) → poll USGS FDSN → KV + D1
```

**Stack (2026):** Cloudflare Workers · Hono 4 · D1 (SQLite) · KV · Workers Static
Assets · TypeScript 5.7 · Wrangler 4 · Vitest.

## Quickstart

```bash
pnpm install
# one-time: create resources, then paste the IDs into wrangler.toml
wrangler d1 create sismo911
wrangler kv namespace create CACHE
pnpm db:migrate:local && pnpm db:seed:local
pnpm dev                       # http://localhost:8787
curl localhost:8787/api/health
```

## Deploy

```bash
wrangler secret put ADMIN_BOOTSTRAP_TOKEN
# recommended before opening admin/operator paths publicly:
# set ACCESS_TEAM_DOMAIN and ACCESS_AUD in wrangler.toml after creating the
# Cloudflare Access application for app.sismo911.com.
pnpm db:migrate:remote && pnpm db:seed:remote
pnpm deploy                    # → https://sismo911.<account>.workers.dev
```

The first `/api/auth/register` call in an empty database creates the initial
admin only when `ADMIN_BOOTSTRAP_TOKEN` is supplied as `bootstrapToken` or the
`x-admin-bootstrap-token` header. Public emergency submissions remain open, but
triage, moderation queues, full SOS reads, damage photos, and status updates are
operator/admin-only.

## API

| Method | Path | Purpose |
|---|---|---|
| GET  | `/api/events?limit=` | Latest events (KV → D1 → live) |
| GET  | `/api/events/:id`    | One event + provisional PAGER |
| POST | `/api/events/refresh`| Force USGS ingest |
| GET/POST/PATCH | `/api/persons` | Missing-persons registry |
| GET/POST | `/api/contacts`  | Emergency directory |
| GET  | `/api/status`        | Ingest log + adapter health |
| GET  | `/api/health` `/api/ready` | Liveness / readiness |

## Roadmap

- [ ] Wire one live social adapter (X via Apify) once credentials land
- [ ] Auth (Cloudflare Access) on `/admin.html` + write endpoints
- [ ] Event-driven PAGER report generation per M≥5 event
- [ ] Geocode + match social/citizen reports to nearest event
