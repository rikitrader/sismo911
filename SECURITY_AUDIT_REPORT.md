# SISMO911 — Security Audit Report

**Scope:** full authorized defensive review of the SISMO911 Cloudflare Worker (Hono + D1 + KV + R2 + Cron) — every route, API, Worker, DB access layer, auth flow, upload handler, cron, migration, env var, CI/CD workflow, and deploy script. **Method:** static review (3 parallel read-only auditors) + `npm audit` + full git-history secret scan + `tsc`/tests/build. Findings are grounded in cited code; uncertain items are marked **NEEDS MANUAL VERIFICATION**. No exploit code was written; nothing was attacked.

## Executive summary

The codebase is in **good security health**. **No secrets are committed** to the repo or anywhere in git history; SQL is uniformly parameterized; uploads are magic-byte validated; rate limiting, CSRF origin checks, strong security headers (HSTS/CSP/frame-ancestors/COOP/COEP/Permissions-Policy), PBKDF2 password hashing, timing-safe key comparison, and an operator/admin write-guard are all already in place.

This review found **no Critical issues**. It hardened the highest-value items directly (CSP `unsafe-eval` removal, stored-XSS sanitization of AI-generated blog HTML, an SSRF guard on server-side photo fetches, CI least-privilege, and a deploy-guard regression I had introduced) and documents a short list of accepted/low and manual-verification items.

| Severity | Open | Fixed |
|---|---|---|
| Critical | 0 | 0 |
| High | 0 | 2 |
| Medium | 2 | 3 |
| Low | 6 | 1 |

All gates green: **typecheck ✓, tests ✓ (310), build ✓, dependency audit ✓ (prod), secret scan ✓**.

---

## HIGH (fixed)

### H-1 — CSP allowed `'unsafe-eval'` (weakened XSS containment) — FIXED
- **Files:** `src/lib/security.ts` (CSP `script-src`).
- **Evidence:** `script-src 'self' 'unsafe-inline' 'unsafe-eval' …`. `'unsafe-eval'` was originally required by the Tailwind Play CDN JIT.
- **Risk:** `eval()`/`Function()` permitted → a successful injection has far more leverage; weakens the primary XSS-containment layer for a public emergency platform.
- **Fix:** removed `'unsafe-eval'` — verified **0 pages load `cdn.tailwindcss.com`** (CSS is built to static `app.css`), and `test/csp.test.ts` endorses removal once no CDN pages remain. (`'unsafe-inline'` retained — pages still carry inline `<script>`; migration to hashes/nonces tracked in the hardening plan.)
- **Verification:** `grep "script-src" src/lib/security.ts` shows no `unsafe-eval`; `npm test` (csp.test) green.

### H-2 — Deploy guard unset the CI deploy token (would break production deploys) — FIXED
- **Files:** `scripts/preflight.sh` (introduced by the prior secret-management change; `predeploy` runs it).
- **Evidence:** preflight unconditionally ran `unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID`; the GitHub Actions deploy (`deploy.yml`) authenticates **with** that token.
- **Risk:** `npm run deploy` in CI → preflight strips the credential → `wrangler` unauthenticated → deploy aborts. Availability/deploy-pipeline breakage.
- **Fix:** preflight now detects CI (`$CI`/`$GITHUB_ACTIONS`) and keeps the provided token; the `unset` runs only locally (where it prevents the `.env` auto-load override).
- **Verification:** `npm run preflight` passes locally (unsets, uses OAuth); CI path keeps the token.

---

## MEDIUM

### M-1 — Stored XSS via AI-generated blog HTML — FIXED
- **Files:** `src/ingest/blog-cron.ts` (`writeArticle`), `src/routes/blog.ts` (`${p.body_html}` render + ingest binds).
- **Evidence:** the blog body is produced by Workers-AI from **scraped social captions** (a prompt-injection surface) and stored, then rendered as **raw HTML** (`${p.body_html}`). A crafted caption could coerce `<script>`/`onerror` into the stored body → stored XSS to every reader.
- **Risk:** stored XSS on a public page (session theft, defacement on an emergency site). Confidence: medium (depends on AI robustness; the vector is real).
- **Fix:** added `src/lib/sanitize.ts#sanitizeHtml` (tag allowlist; strips `<script>/<iframe>/<svg>`, all attributes except a vetted `<a href>`, `on*` handlers, and `javascript:`/`data:text/html`). Applied at **storage** (AI output + manual ingest binds) **and** at **render** (covers legacy rows). Tested.
- **Verification:** `test/security-hardening.test.ts` (sanitizeHtml strips script/handlers/iframe/svg, neutralizes `javascript:`).

### M-2 — SSRF: server-side fetch of DB-sourced photo URLs without validation — FIXED
- **Files:** `src/ingest/rav-photos.ts` (`fetch(row.foto)` ×2).
- **Evidence:** photo URLs come from an external aggregator and are fetched server-side with no scheme/host check.
- **Risk:** if the upstream feed is poisoned, the Worker can be coerced to fetch attacker-chosen URLs (internal hostnames, non-HTTP schemes). Workers have no cloud-metadata endpoint, so impact is limited, but it's avoidable.
- **Fix:** added `src/lib/sanitize.ts#isSafePublicUrl` (https/http only; rejects localhost/`.local`/`.internal` and private/loopback/link-local IPv4) and gated both fetches. Reused in the ingestion gatekeeper. Tested.
- **Verification:** `test/security-hardening.test.ts` (rejects `file://`, `127.0.0.1`, `169.254.169.254`, `10.x`, `192.168.x`, `*.internal`).

### M-3 — CI deploy workflow had no `permissions:` (over-broad GITHUB_TOKEN) — FIXED
- **Files:** `.github/workflows/deploy.yml`.
- **Evidence:** no `permissions:` block → the auto `GITHUB_TOKEN` inherits the repo default (potentially write).
- **Risk:** a compromised action/step could use the token to write repo contents/releases.
- **Fix:** added `permissions: contents: read`. (Workflow already avoids `pull_request_target` and only injects CF secrets in the deploy step — both good.)
- **Verification:** workflow lints; deploy only needs read.

### M-4 (OPEN, recommended) — Public write endpoints rate-limited per-IP only
- **Files:** `src/routes/telemedicina-scheduling.ts` (`telemed_book` 12/600), `src/routes/data-api.ts` (`/api/v1/register`), registration endpoints.
- **Evidence:** limits are per-IP; no per-email/per-phone cap.
- **Risk:** a single IP can book many slots across doctors (griefing) or flood the API-client approval queue; weak enumeration resistance. Server-side slot re-validation already prevents double-booking.
- **Recommended fix:** add a per-email/per-phone counter (e.g. ≤2 bookings/hour/contact, ≤3 API registrations/hour/email). Not changed here to avoid behavior surprises; see HARDENING_PLAN.md (7-day).

### M-5 (OPEN, NEEDS MANUAL VERIFICATION) — `workers.dev` exposure vs Cloudflare Access
- **Files:** `wrangler.toml` (`workers_dev = true`; `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` empty), `src/lib/access.ts`, `src/lib/auth.ts`.
- **Evidence:** the raw `*.workers.dev` host is public; Access enforcement is a no-op while the ACCESS_* vars are empty. The `/api/admin/*` APIs are independently session-gated (operator/admin) regardless of host, so API exposure is limited — but the gate's reliance is worth confirming end-to-end.
- **Manual check:** confirm no admin-only **read** page leaks data on the workers.dev URL without a session; either set `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` to a live Access app, or disable `workers_dev` in production.

---

## LOW

- **L-1 (mitigated)** — Uploaded `text/plain`/PDF served `Content-Disposition: inline` (`src/routes/persons.ts`, `mascotas.ts`, `telemedicina-scheduling.ts`). **Mitigated** by the global `X-Content-Type-Options: nosniff` (`src/lib/security.ts`), so browsers won't sniff a `.txt` to HTML; no SVG/HTML type is accepted. Recommend `attachment` disposition for non-image types as extra (hardening plan).
- **L-2 (accepted)** — Session cookie `SameSite=Lax` (`src/lib/auth.ts`). Defense-in-depth: every authorized write also passes the Origin/Referer same-site check (`src/index.ts`), which **fails closed** when those headers are absent. Acceptable; `Strict` would break legitimate cross-site top-nav logins.
- **L-3 (dev-only)** — `npm audit`: 5 advisories (1 critical, 1 high, 3 moderate) **all in the dev toolchain** (esbuild/vitest chain); `npm audit --omit=dev` = **0**. Not in the deployed Worker bundle. Remediate via a dev-dep upgrade when convenient (`vitest@4` is a breaking bump).
- **L-4 (mitigated)** — First-user `role='admin'` via `COUNT(*)==0` isn't transactional (`src/routes/auth.ts`), but admin creation **also requires `ADMIN_BOOTSTRAP_TOKEN`** (timing-safe), so a race can't escalate without the secret.
- **L-5 (by design)** — `/appt/:id/ics` accepts the patient `manage_token` **or** the doctor `panel_token` (`src/routes/telemedicina-scheduling.ts`). Low value; both are unguessable per-record/per-doctor secrets.
- **L-6 (info)** — MCP `tools/list` requires an approved key but no specific scope (`src/routes/mcp.ts`); only the (already public) tool schema is exposed. Consider requiring a minimal scope.

---

## NEEDS MANUAL VERIFICATION (no code change)

- **R2 bucket ACLs** — confirm `sismo911-person-photos` and `desaparecidos-fotos` are **private** in the Cloudflare dashboard (no public `r2.dev` / custom-domain read). Bindings are private by default; verify no dashboard public-access was enabled. Missing-person photos are sensitive.
- **Local `.env`** — holds **real** Cloudflare/R2 credentials on the developer machine. **Verified git-ignored and NEVER committed** (full-history scan clean). Per the secret-management standard, keep CF deploy creds out of the project `.env` (the preflight already neutralizes the auto-load risk); rotating them is optional hygiene since they were never exposed in git.
- **Cloudflare Access** — see M-5.

---

## Verification steps (reproduce)

```bash
npm run security-audit   # dependency + secret + history + tsc + tests + build + config greps
npm run secret-scan      # tree-wide secret scan
npm run preflight        # deploy guard (auth, secrets, D1, versions)
npm run verify           # tsc --noEmit && vitest run (310 tests)
```
