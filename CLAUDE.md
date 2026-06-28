# SISMO911 — Project Instructions

Inherits all global rules from `~/CLAUDE.md` (ship cycle, worktrees, deploy wait-list, etc.).

## No-Pre-Existing-Failure (HARD RULE — imperative, never excuse)

- **A failure I surface is a failure I fix — "pre-existing" never survives as a reason to leave it broken.** Don't label a broken cron job, red build, failing test, 4xx/5xx, or Cloudflare **subrequest-limit** error as "pre-existing / out of scope" to defer it. Diagnose and fix it in the same task, or get explicit agreement before deferring (then leave a tracked follow-up). Full rule in `~/CLAUDE.md` → **No-Pre-Existing-Failure**.
- **Cron / subrequests specifically:** scheduled jobs are split across STAGGERED cron triggers in `src/cron.ts` (`CRON_GROUPS`, :00/:15/:30/:45) so each invocation has its own subrequest budget — `wrangler.toml [triggers].crons` must stay in sync (enforced by `test/cron.test.ts`). If a job hits "Too many subrequests," fix it (move it to its own/lighter group, `env.DB.batch()` the writes, bound the fan-out) — do not leave it failing.

## DO NOT DELETE BRANCHES UNTIL MERGE IS VERIFIED (CRITICAL — GODMODE, never violate)

- **Never** delete a feature/cleanup/temp branch until the PR is verifiably **MERGED** (gh state=MERGED, mergeStateStatus not CONFLICTING/DIRTY, merge commit an ancestor of `origin/main` after `git fetch --all --prune`). Branch deletion is the **FINAL** cleanup step, never intermediate. A premature delete after a conflicted merge already orphaned an Increment-4 commit here (recovered via `git reflog` → re-PR #283).
- **The ONLY sanctioned deletion path:** `~/.claude/scripts/safe-branch-delete.sh <branch> [main]` (fail-closed; verifies the merge first). **Never** hand-run `gh pr merge --delete-branch`, `git push origin --delete <branch>`, or `git branch -D <branch>` on a PR branch.
- **On any merge conflict: STOP** — do not delete branches, recreate commits, or `--force`. Recover the work (`gh pr checkout <PR>` / `git fetch origin pull/<PR>/head:…` / `git reflog`), resolve on a `recovery/pr-<PR>-conflict-fix` branch keeping BOTH sides' behavior (imports/types/routes/migrations/tests), verify (no `<<<<<<<`/`=======`/`>>>>>>>` remain; tsc + tests + build green), then re-PR. Full protocol in `~/CLAUDE.md` → **Merge-Conflict Recovery**.

## Per-Agent Git Worktrees (REQUIRED — never use the shared checkout)

**Every agent works ONLY inside its own isolated git worktree, never the shared canonical checkout.** Sharing one working tree across concurrent agents has repeatedly caused: a commit landing on local `main` when another agent ran `git checkout` mid-task, a dirty/diverged `main`, `node_modules` corruption from racing `npm install`s (`ENOTDIR` / `Cannot find module 'anymatch'` → failed deploys), and general checkout races. A worktree gives each agent an isolated working directory while sharing the same `.git`.

**Required at the start of every task — create/enter your worktree before any edit, commit, or branch op:**
```bash
wt=$(./scripts/agent-worktree.sh <branch-name>) && cd "$wt"
# …edit, commit, push, open PR from inside "$wt"…
```
`scripts/agent-worktree.sh` wraps `~/.claude/scripts/agent-worktree.sh`: it bases a NEW branch on a freshly-fetched `origin/main`, resumes an existing branch idempotently (keyed by branch), and prints the worktree path. Helpers: `--list`, `--trace`, `--remove <branch>`, `--prune`.

**Hard prohibitions:** do NOT commit in the canonical checkout (a `pre-commit` guard blocks it — do **not** bypass with `ALLOW_MAIN_COMMIT=1` just to avoid making a worktree); do NOT run `npm install` / `wrangler deploy` in the shared checkout while others may be working it (deploy from your worktree, or via `~/.claude/scripts/ship-deploy.sh`). The canonical checkout is coordination/read-only. Full rule: `~/CLAUDE.md` → **Per-Agent Git Worktrees**.

## Vault Recording (Enforce-Rule — imperative, never ask)

- **Record EVERY change + its full history to the project vault, automatically, AFTER deploy — never asking.**
  The vault is `~/projects/sismo911-vault/` (sibling to this repo). Once the ship cycle reaches LIVE:
  immediately append the change and its history to the vault as part of the same task — do not pause,
  do not ask for confirmation, do not wait to be told. A deploy is **not done** until the vault is updated.
- Minimum per change: `06-Sessions/YYYY-MM-DD-<slug>.md` (what/why/how, PR #, prod version, gotchas),
  `00-Indices/Decisions-Log.md` (decision + why), and `00-Indices/Followups.md` (anything pending).

## Cloudflare Secret Management & Zero-Trust Deployment (HARD RULE — never violate)

- **No secret in git, ever** — not in `wrangler.toml`, `.env*`, `.dev.vars`, scripts, CI YAML, tests, or docs. Runtime secrets live ONLY in **Cloudflare Worker Secrets** (`wrangler secret put`). The authoritative list is `scripts/secrets.manifest`. Only non-secret config + **documented public** keys (`VAPID_PUBLIC_KEY`, `RAV_SUPABASE_KEY` anon JWT) may sit in `wrangler.toml [vars]`.
- **Never manipulate/rename `.env` to deploy.** Wrangler v4 auto-loads `.env`; a Cloudflare token there overrides the OAuth session → wrong-account deploys + D1 **Error 7500**. Every deploy/migration path begins with `unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID` (the scripts do this). Keep CF deploy creds out of the project `.env`; rely on `wrangler login`.
- **Preflight gates every deploy:** run `npm run preflight` (or it runs via `predeploy`) — validates auth, required secrets present, D1 reachable (catches Error 7500 before migrating), versions, pending migrations. **Deploy aborts on any required failure.** Set/rotate secrets with the idempotent `npm run bootstrap:secrets` (values entered hidden, never echoed).
- **Secret scanning:** `bash scripts/install-secret-scan-hook.sh` installs a pre-commit guard (`scripts/secret-scan.sh`) that blocks commits containing CF/AWS/GitHub/Stripe/Anthropic/OpenAI/Google/Slack tokens or private keys. Run `npm run secret-scan` in CI. Whitelist a true example with `# pragma: allowlist secret`.
- **Least privilege:** if not using OAuth, use one scoped Cloudflare token per task (Workers/D1/KV/R2/…), never the Global API Key or an admin token; store CI creds as GitHub Environment secrets, masked. **Rotation:** signing/JWT secrets ≤90 days and immediately on suspected exposure (`bootstrap-secrets.sh --rotate <NAME>` → redeploy → revoke old). Full spec: private security vault (`sismo911-vault/09-Security-Internal/cloudflare-secrets.md`).

## Project quick-reference

- **Stack:** Cloudflare Workers + Hono 4 + D1 + KV + R2 + Static Assets + hourly Cron. Single Worker serves `public/*.html` + `/api/*`.
- **Deploy:** `unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID` first (use gmail OAuth, NOT the icloud env token), then `npm run build:css && npx wrangler deploy` via `~/.claude/scripts/ship-deploy.sh`. Live at sismo911.com / sismo911.rikitrader.workers.dev.
- **D1 migrations:** the remote `d1_migrations` tracker was **reconciled 2026-06-27** (it had drifted: 9 already-applied migrations weren't recorded, so `migrations apply --remote` kept re-running non-idempotent `ADD COLUMN`s and crashing). It is now honest, so **use `npm run db:migrate:remote` normally** (`unset` the CF tokens first). Older migration headers say *"do NOT migrations apply --remote / tracker is drifted"* — that note is now historical. If you ever apply schema per-statement by hand on remote, **also record it** (`INSERT OR IGNORE INTO d1_migrations(name) VALUES ('NNNN_name.sql')`) so the tracker never drifts again. New migration files must stay idempotent (`CREATE … IF NOT EXISTS`; for columns, gate or accept that re-runs error).
- **Sidebar/nav:** `public/app-shell.js` (`NAV` array) is injected on every page; add new pages there.
- **Concurrency:** another agent may share this checkout — work in an isolated `git worktree` off `origin/main`, and if the canonical `main` has diverged at deploy time, deploy from the worktree reset to `origin/main` (run `npm install` there first).
- **Git hooks (installed, enforced):** a `pre-commit` worktree guard blocks commits in the shared canonical checkout, and a `pre-push` **git-sync-guard** blocks pushing any feature branch not rebased on the latest `origin/main` (rebase first: `git fetch origin && git rebase origin/main`; override once with `ALLOW_STALE_PUSH=1 git push`). Both live in the shared `.git`. Re-install if missing: `~/.claude/scripts/install-worktree-guard.sh .` and `~/.claude/scripts/install-git-sync-guard.sh .`. See `~/CLAUDE.md` → **MANDATORY GIT SYNC + PR HANDOFF RULE**.
