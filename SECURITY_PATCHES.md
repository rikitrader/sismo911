# SISMO911 — Security Patches (this PR)

Every code change made during the audit, with rationale. All changes are minimal, production-safe, and covered by `tsc` + tests (310 passing) + build.

## New files
- **`src/lib/sanitize.ts`** — shared defensive helpers:
  - `sanitizeHtml(html)` — allowlist HTML sanitizer (tags: p/br/strong/em/u/ul/ol/li/a/h2-4/blockquote; strips `<script>/<style>/<iframe>/<svg>/…` with content, all attributes except a vetted `<a href>`, `on*` handlers, and `javascript:`/`data:text/html`). *Why:* defense-in-depth for stored rich text that is later rendered raw.
  - `isSafePublicUrl(url)` — SSRF guard: https/http only; rejects localhost/`.local`/`.internal` and private/loopback/link-local IPv4. *Why:* gate server-side `fetch()` of externally-sourced URLs.
- **`scripts/ingestion-gatekeeper.ts`** — reusable ingestion validation layer: `gateUpload` (size/MIME/magic-byte/executable-block/`%PDF`), `gateUrl`, `gateRichText`, `gateRecord` (Zod), `looksExecutable`, `safeAuditDetail` (PII/secret redaction), `citizenRecordSchema`. *Why:* consolidate the scattered ingestion checks into one tested module for adoption across familia/RAV/blog/uploads.
- **`scripts/security-audit.sh`** (`npm run security-audit`) — defensive gate: `npm audit`, tree + history secret scan, `tsc`, tests, `build:css` + `wrangler deploy --dry-run`, and config/route safety greps. Non-zero on hard failures.
- **`test/security-hardening.test.ts`** — 11 tests covering `sanitizeHtml`, `isSafePublicUrl`, and the gatekeeper (`gateUpload` accept/reject incl. spoofed-MIME executable block, `gateRecord`, `safeAuditDetail` redaction).

## Modified files
- **`src/lib/security.ts`** — removed `'unsafe-eval'` from CSP `script-src` (H-1). No page uses the Tailwind CDN (CSS is static), so eval is no longer needed; `'unsafe-inline'` retained (inline page scripts) and annotated for future removal.
- **`src/ingest/blog-cron.ts`** — `writeArticle` now returns `sanitizeHtml(body_html)` (M-1): the AI body, built from scraped captions, is sanitized before storage.
- **`src/routes/blog.ts`** — import `sanitizeHtml`; sanitize `body_html` at both ingest binds (POST + backfill) and at render (`${sanitizeHtml(p.body_html)}`) so legacy stored rows are also neutralized (M-1).
- **`src/ingest/rav-photos.ts`** — import `isSafePublicUrl`; gate both `fetch(row.foto)` calls behind it (M-2).
- **`.github/workflows/deploy.yml`** — added `permissions: contents: read` (M-3, CI least privilege).
- **`scripts/preflight.sh`** — CI-aware: keeps `CLOUDFLARE_API_TOKEN` when `$CI`/`$GITHUB_ACTIONS` is set; only `unset`s locally (H-2 — fixes the deploy-guard breaking CI deploys).
- **`package.json`** — added `security-audit` script.

## Not changed (deliberately)
- `'unsafe-inline'` left in CSP — pages still carry inline `<script>`; removing needs nonces/hashes (long-term; tracked).
- Session `SameSite=Lax` — kept (origin check fails closed for authorized writes); `Strict` would break legit cross-site logins.
- Dev-only `npm audit` advisories — not auto-fixed (`vitest@4` breaking); they don't ship in the Worker.
- R2 ACL / Cloudflare Access / local `.env` rotation — manual/dashboard actions, documented in the report.

## Verification
`tsc --noEmit` ✓ · `vitest run` ✓ (310) · `build:css` + `wrangler deploy --dry-run` ✓ · `secret-scan --all` ✓ · git-history secret scan ✓ · `security-audit.sh` → **0 hard / 0 warnings**.
