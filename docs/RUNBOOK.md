# SISMO911 — Operations Runbook

**Live:** https://sismo911.com · https://app.sismo911.com
**Worker:** `sismo911` (Cloudflare account configured in the deploy environment)
**Repo:** github.com/rikitrader/sismo911

## Architecture at a glance

```
Cron (* * * * *) ─► ingest USGS summary feed + Kobo ─► KV cache + D1
Browser ─► Worker (Hono) ─► /api/* + static assets (run_worker_first)
                            ├─ D1   events, persons, contacts, reports, users, sessions, …
                            ├─ KV   CACHE (feed/rate-limit), PHOTOS (damage images)
                            └─ Workers AI  sit-reps + damage vision
```

## Deploy

```bash
# auth: wrangler login
pnpm db:migrate:remote      # apply new migrations
pnpm deploy
```
CI deploy runs on tag `v*.*.*` (`.github/workflows/deploy.yml`).

## Health checks

| Check | Command | Healthy |
|---|---|---|
| Liveness | `curl https://app.sismo911.com/api/health` | `{"ok":true}` |
| Readiness (D1) | `curl …/api/ready` | `{"ready":true}` |
| Ingest status | `curl …/api/status` | `ingest[].last_error` null |
| Live feed | `curl …/api/events?limit=1` | event returned |

## Common incidents

**USGS feed stale (`/api/status` shows last_error or old last_ok_ms)**
- USGS summary feed (`…/feed/v1.0/summary/all_month.geojson`) may be down. Force a pull: `curl -X POST …/api/events/refresh` (operator session required).
- The client falls back to the last KV cache + D1, so the map stays populated.
- If local `wrangler dev` cannot reach USGS, compare with production before treating it as an outage.

**Rate-limit false positives (429s)**
- KV soft limit per IP. Limits live in `src/lib/security.ts` (`rateLimit` calls per route). Raise the window/limit and redeploy if a shared NAT trips it.

**AI features failing (`/api/sitrep`, `/api/damage` → ai_failed)**
- Workers AI model may need a one-time license acceptance: `curl -X POST https://api.cloudflare.com/client/v4/accounts/$ACCT/ai/run/<model> -H "Authorization: Bearer $TOKEN" -d '{"prompt":"agree"}'`.
- Vision model: `@cf/meta/llama-3.2-11b-vision-instruct`. Text: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.

**Locked out of admin**
- Promote a user directly: `wrangler d1 execute sismo911 --remote --command "UPDATE users SET role='admin' WHERE email='you@example.com'"`.
- First registration in an empty DB becomes admin (requires `ADMIN_BOOTSTRAP_TOKEN`).

## Backups

```bash
# export D1 to a local SQL dump (run periodically / before migrations)
wrangler d1 export sismo911 --remote --output backups/sismo911-$(date +%F).sql
```

## Secrets (Worker)

`VAPID_PRIVATE_KEY`, `ADMIN_BOOTSTRAP_TOKEN` — set via `wrangler secret put`. Never in the repo. Public VAPID key + non-secret vars live in `wrangler.toml`.

## Escalation

Data-source coverage limits are by design (FEMA/ShakeAlert = US-only; gov/social feeds need credentials). See `docs/ROADMAP.md` Phase 6 + the credentials checklist before promising a gated integration.
