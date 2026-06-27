# SISMO911 — Project Instructions

Inherits all global rules from `~/CLAUDE.md` (ship cycle, worktrees, deploy wait-list, etc.).

## No-Pre-Existing-Failure (HARD RULE — imperative, never excuse)

- **A failure I surface is a failure I fix — "pre-existing" never survives as a reason to leave it broken.** Don't label a broken cron job, red build, failing test, 4xx/5xx, or Cloudflare **subrequest-limit** error as "pre-existing / out of scope" to defer it. Diagnose and fix it in the same task, or get explicit agreement before deferring (then leave a tracked follow-up). Full rule in `~/CLAUDE.md` → **No-Pre-Existing-Failure**.
- **Cron / subrequests specifically:** scheduled jobs are split across STAGGERED cron triggers in `src/cron.ts` (`CRON_GROUPS`, :00/:15/:30/:45) so each invocation has its own subrequest budget — `wrangler.toml [triggers].crons` must stay in sync (enforced by `test/cron.test.ts`). If a job hits "Too many subrequests," fix it (move it to its own/lighter group, `env.DB.batch()` the writes, bound the fan-out) — do not leave it failing.

## Vault Recording (Enforce-Rule — imperative, never ask)

- **Record EVERY change + its full history to the project vault, automatically, AFTER deploy — never asking.**
  The vault is `~/projects/sismo911-vault/` (sibling to this repo). Once the ship cycle reaches LIVE:
  immediately append the change and its history to the vault as part of the same task — do not pause,
  do not ask for confirmation, do not wait to be told. A deploy is **not done** until the vault is updated.
- Minimum per change: `06-Sessions/YYYY-MM-DD-<slug>.md` (what/why/how, PR #, prod version, gotchas),
  `00-Indices/Decisions-Log.md` (decision + why), and `00-Indices/Followups.md` (anything pending).

## Project quick-reference

- **Stack:** Cloudflare Workers + Hono 4 + D1 + KV + R2 + Static Assets + hourly Cron. Single Worker serves `public/*.html` + `/api/*`.
- **Deploy:** `unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID` first (use gmail OAuth, NOT the icloud env token), then `npm run build:css && npx wrangler deploy` via `~/.claude/scripts/ship-deploy.sh`. Live at sismo911.com / sismo911.rikitrader.workers.dev.
- **D1 migrations:** the remote `d1_migrations` tracker was **reconciled 2026-06-27** (it had drifted: 9 already-applied migrations weren't recorded, so `migrations apply --remote` kept re-running non-idempotent `ADD COLUMN`s and crashing). It is now honest, so **use `npm run db:migrate:remote` normally** (`unset` the CF tokens first). Older migration headers say *"do NOT migrations apply --remote / tracker is drifted"* — that note is now historical. If you ever apply schema per-statement by hand on remote, **also record it** (`INSERT OR IGNORE INTO d1_migrations(name) VALUES ('NNNN_name.sql')`) so the tracker never drifts again. New migration files must stay idempotent (`CREATE … IF NOT EXISTS`; for columns, gate or accept that re-runs error).
- **Sidebar/nav:** `public/app-shell.js` (`NAV` array) is injected on every page; add new pages there.
- **Concurrency:** another agent may share this checkout — work in an isolated `git worktree` off `origin/main`, and if the canonical `main` has diverged at deploy time, deploy from the worktree reset to `origin/main` (run `npm install` there first).
