# Cloudflare Secret Management & Zero-Trust Deployment — SISMO911

Production-grade, least-privilege secret architecture for this Worker. **No secret
ever lives in git, `wrangler.toml`, or `.env`.** Runtime secrets live only in
Cloudflare Worker Secrets; deploy credentials come from the interactive OAuth
session (or scoped CI tokens), never a committed file.

## 1. Architecture (where each kind of value lives)

| Value kind | Lives in | Example |
|---|---|---|
| Non-secret config | `wrangler.toml [vars]` (committed) | `USGS_MINLAT`, `ALLOWED_ORIGINS` |
| **Intentionally public** keys | `wrangler.toml [vars]` (committed, documented) | `VAPID_PUBLIC_KEY`, `RAV_SUPABASE_KEY` (anon JWT) |
| **Runtime secrets** | **Cloudflare Worker Secrets** (`wrangler secret put`) | `PLAN_SECRET`, `VAPID_PRIVATE_KEY`, `*_INGEST_TOKEN`, `TWILIO_*`, `CROSSMINT_*` |
| Local dev overrides | `.dev.vars` (git-ignored) | a local `PLAN_SECRET` for `wrangler dev` |
| Deploy / D1 credentials | **OAuth session** (`wrangler login`); CI → GitHub Secrets | — |

The authoritative list of Worker secrets (required / recommended / optional) is
[`scripts/secrets.manifest`](../../scripts/secrets.manifest) — used by both the
bootstrap and preflight scripts.

## 2. Environment separation

- **Development:** `.dev.vars` (git-ignored) — `wrangler dev` auto-loads it. Never put production credentials here.
- **Local/tests:** `.env.local` / `.env.test` (git-ignored). `.env.example` is the only committed env file (placeholders only).
- **Staging / Production:** Cloudflare Worker Secrets. There is no production `.env`.

## 3. The `.env` auto-load trap (and the fix)

Wrangler v4 auto-loads `.env`. If `.env` contains `CLOUDFLARE_API_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID` (e.g. a token for a *different* account), wrangler uses it
and **overrides the OAuth session** → wrong-account deploys and D1 **Error 7500**.

**Fix — never manipulate/rename `.env` by hand.** Every script here begins with:
```bash
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
```
so the OAuth session is always used. Best practice: keep Cloudflare deploy creds
**out** of the project `.env` entirely; rely on `wrangler login`. `.env` should
hold only non-Cloudflare local config.

## 4. Least-privilege API tokens (when not using OAuth)

OAuth (`wrangler login`) is the default for this repo. If you must use API tokens
(CI), create **one scoped token per task** in the Cloudflare dashboard — never the
Global API Key, never an Account-Admin token:

| Token | Minimum permissions |
|---|---|
| Deploy (Workers) | Account · Workers Scripts: Edit |
| D1 admin/migrations | Account · D1: Edit |
| KV | Account · Workers KV Storage: Edit |
| R2 | Account · Workers R2 Storage: Edit |
| Queues | Account · Queues: Edit |
| Workers AI | Account · Workers AI: Read |
| Vectorize | Account · Vectorize: Edit |
| Pages | Account · Cloudflare Pages: Edit |
| DNS | Zone · DNS: Edit (scoped to the one zone) |
| Analytics | Account · Account Analytics: Read |

Store each as a **GitHub Environment secret** (`dev`/`staging`/`prod`), never in YAML or repo files.

## 5. Bootstrap (set the secrets) — idempotent

```bash
bash scripts/bootstrap-secrets.sh          # prompts only for MISSING required+recommended
bash scripts/bootstrap-secrets.sh --all    # also optional integrations
bash scripts/bootstrap-secrets.sh --rotate PLAN_SECRET   # re-enter one
```
Values are entered hidden, piped to `wrangler secret put`, never echoed or written to disk. Re-running with everything set is a no-op.

## 6. Deploy — guarded

```bash
npm run preflight        # auth, secrets, D1 access, versions, pending migrations
npm run deploy           # build:css + preflight + wrangler deploy
```
`preflight.sh` aborts the deploy if any **required** secret is missing, auth
fails, or D1 is unreachable. Multi-agent deploys still route through
`~/.claude/scripts/ship-deploy.sh` (serialized lock); run preflight first.

## 7. Secret rotation

Zero-downtime rotation (Worker Secrets are versioned per deploy):
1. Generate a new value (`openssl rand -hex 32`).
2. `bash scripts/bootstrap-secrets.sh --rotate <NAME>` (or `wrangler secret put <NAME>`).
3. Redeploy (`npm run deploy`). New invocations pick up the new value immediately.
4. Revoke the old upstream credential (provider dashboard) once traffic is healthy.

**Schedule:** signing/JWT secrets every 90 days; provider API keys per provider policy; **immediately** on any suspected exposure. Rotating `PLAN_SECRET` invalidates existing `/plan` access cookies (users re-enter an invite code — acceptable). Do **not** rotate `VAPID_*` casually — it invalidates all push subscriptions.

## 8. Recovery / emergency replacement

- **Leaked token:** revoke in the Cloudflare/provider dashboard → rotate (§7) → redeploy → audit `wrangler tail` + access logs.
- **Lost OAuth session:** `wrangler logout && wrangler login`.
- **Lost a secret value:** secrets are write-only (can't be read back) — generate a fresh one and rotate.

## 9. Troubleshooting — D1 Error 7500 & friends

`preflight.sh` checks D1 *before* migrating and maps failures:

| Symptom | Cause | Fix |
|---|---|---|
| `Error 7500` / Authentication error on D1 write | wrong/expired token, or `.env` token overriding OAuth | `unset CLOUDFLARE_API_TOKEN` (scripts do this) or `wrangler login` |
| `10000` Unauthorized | token lacks **D1: Edit** | use OAuth or a D1-Edit token |
| wrong account's resources | `.env` `CLOUDFLARE_ACCOUNT_ID` auto-loaded | unset it; rely on OAuth account |
| `migrations apply` re-runs applied migrations | drifted `d1_migrations` tracker | reconciled 2026-06-27 — `INSERT OR IGNORE` the applied rows; keep new migrations idempotent |

## 10. Pre-commit secret scanning

`scripts/secret-scan.sh` blocks commits containing CF/AWS/GitHub/Stripe/Anthropic/
OpenAI/Google/Slack tokens or private keys. Install once (covers all worktrees):
```bash
bash scripts/install-secret-scan-hook.sh
```
Whitelist a genuine example with a trailing `# pragma: allowlist secret`.

## 11. Security checklist (pre-deploy)

- [ ] `bash scripts/secret-scan.sh --all` is clean.
- [ ] No runtime secret in `wrangler.toml [vars]` (only config + documented public keys).
- [ ] `.env` / `.dev.vars` are git-ignored and hold no production credentials.
- [ ] `npm run preflight` passes (auth ✓, required secrets ✓, D1 ✓).
- [ ] CI deploy creds (if any) are GitHub Environment secrets, masked in logs.
- [ ] Rotation schedule recorded; revocation steps known.
