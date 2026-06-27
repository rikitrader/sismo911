# SISMO911 — Hardening Plan

Prioritized remediation roadmap from the security audit. Items marked ✅ were implemented in this pass.

## ⚠️ MANUAL TODO — cannot be verified or fixed from code
- [ ] **R2 bucket privacy.** Cloudflare Dashboard → **R2** → `sismo911-person-photos` **and** `desaparecidos-fotos` → **Settings → Public access** must be **Disabled** (no `r2.dev` URL, no public custom domain). Missing-person photos are sensitive; the app serves them only through token-gated Worker routes, so a bucket is exposed *only* if public access was manually enabled.

## Immediate (done in this PR)
- ✅ Remove `'unsafe-eval'` from CSP `script-src` (`src/lib/security.ts`).
- ✅ Sanitize AI/scraped blog HTML (allowlist) at storage **and** render (`src/lib/sanitize.ts`, `blog-cron.ts`, `blog.ts`).
- ✅ SSRF guard (`isSafePublicUrl`) on server-side photo fetches (`rav-photos.ts`).
- ✅ CI least privilege: `permissions: contents: read` on `deploy.yml`.
- ✅ Fix the deploy-guard CI regression (preflight keeps the CI token).
- ✅ Ship the defensive tooling: `scripts/security-audit.sh`, `scripts/ingestion-gatekeeper.ts`, tests.

## 24-hour
- Verify **R2 bucket ACLs** are private (dashboard) for `sismo911-person-photos`, `desaparecidos-fotos`.
- Decide `workers.dev`: set `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` to a live Cloudflare Access app, **or** disable `workers_dev` in production. Confirm no admin read-page leaks on the raw workers.dev host.
- Serve uploaded non-image attachments with `Content-Disposition: attachment` (persons/mascotas/telemed file routes) in addition to the existing global `nosniff`.
- Install the pre-commit secret-scan hook for all contributors: `bash scripts/install-secret-scan-hook.sh`.

## 7-day
- Add per-email/per-phone rate limits to booking (`telemed_book`) and `/api/v1/register` (anti-griefing / anti-enumeration), on top of the per-IP limits.
- Adopt `scripts/ingestion-gatekeeper.ts` at the remaining ingestion sites (familia/RAV/blog) — `gateUpload` for files, `gateUrl` before any external fetch, `gateRecord` (Zod) at DB-write boundaries, `safeAuditDetail` for audit calls.
- Upgrade the dev toolchain to clear the `npm audit` esbuild/vitest advisories (dev-only; `vitest@4` is a breaking change — gate behind a green test run).
- Require a minimal scope on MCP `tools/list`.

## Long-term controls
- Eliminate `'unsafe-inline'` from `script-src` by moving page inline `<script>` blocks to external files or per-response **nonces**; then drop `'unsafe-inline'`.
- Centralize all DB writes behind the gatekeeper + Zod schemas (defense-in-depth against future injection/contamination).
- Periodic automated dependency + secret scan in CI (`npm run security-audit` as a CI job).
- Rotation schedule for signing/JWT secrets (≤90 days) per `docs/security/cloudflare-secrets.md`.

## Cloudflare-specific hardening
- Worker Secrets only for runtime secrets (already enforced; `scripts/secrets.manifest` is the SoT). `preflight.sh` blocks deploys missing required secrets.
- Confirm R2 private; never expose buckets via `r2.dev`/custom domain. Serve files only through the auth-gated Worker routes (already the case; token-checked).
- Keep CF deploy creds out of the project `.env`; rely on OAuth locally and the scoped GitHub-Secret token in CI. Least-privilege CF tokens per task (Workers/D1/KV/R2) — see the secrets doc.
- Cron jobs stay staggered across triggers (subrequest budget) — enforced by `test/cron.test.ts`.

## CI/CD hardening
- ✅ `permissions: contents: read` on deploy.
- No `pull_request_target` (verified). Secrets injected only in the deploy step, never echoed.
- Consider GitHub **Environments** (`prod`) with required reviewers + the CF token scoped there.
- Run `npm run security-audit` (or at least `secret-scan` + `tsc` + tests) as a CI gate on PRs.

## Database ingestion hardening
- Use `gateRecord(schema, input)` (Zod) at every write boundary; reject malformed records.
- Keep the existing `clean.ts`/dedupe pipeline (junk/flood/dup defense) — extend with the gatekeeper's `safeAuditDetail` so audit logs never carry PII.
- Enforce NOT-NULL/length constraints in migrations; sanitize rich-text fields before insert (now done for blog).

## Upload / file sanitation hardening
- `gateUpload` everywhere: size cap, MIME allowlist, **magic-byte content match**, **executable block** (MZ/ELF/Mach-O/shebang/Java), `%PDF` check. (Existing handlers already do most of this; consolidate on the gatekeeper.)
- Never accept `image/svg+xml`/`text/html` uploads (currently not accepted — keep it that way).
- Serve attachments with `nosniff` (global) + `attachment` disposition for non-images; keys are server-generated (no user-controlled paths) — keep it.
