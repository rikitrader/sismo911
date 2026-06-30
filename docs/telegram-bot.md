# SISMO911 — Telegram Case-Status Bot

A read-only Telegram bot, served by the existing SISMO911 Cloudflare Worker, that
answers humanitarian case-status queries **from verified database records only**.
Approved-group members (and admins in DM) can ask about a person's status; the
bot never hallucinates, never guesses, never infers a status from a weak match,
and redacts personal data by default.

It is implemented as a normal route module inside the main Worker — **not a
separate service** — so it reuses the project's D1 database, audit table,
rate-limiter, minor-protection redaction, and SHA-256 helper. The bot is **inert
until configured**: with no `TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET` the
webhook returns `503` and nothing else changes.

> **File-layout note.** The task brief listed a stand-alone layout
> (`src/worker.ts`, `src/security/rate-limit.ts`, `src/types.ts`,
> `src/utils/hash.ts`, root `README.md`/`wrangler.toml.example`). Those collide
> with files that already exist in this production Worker, so the bot integrates
> instead of overwriting them. Mapping:
>
> | Brief path | Actual path | Why |
> |---|---|---|
> | `src/worker.ts` (entrypoint) | route mounted in existing `src/index.ts` | one Worker, not two |
> | `src/telegram/handler.ts` | `src/telegram/route.ts` | webhook + orchestration |
> | `src/adapters/sismo911-api.ts` | same | read-only D1 adapter |
> | `src/security/rate-limit.ts` | reuses existing `src/security/rate-limit.ts` | don't duplicate |
> | `src/security/audit-log.ts` | `src/telegram/audit.ts` (writes existing `audit` table) | reuse schema |
> | `src/security/redaction.ts` | `src/telegram/redaction.ts` (reuses `lib/minor-protect`) | one redaction source |
> | `src/env.ts` | `src/telegram/env.ts` + additions to `src/types.ts` | Env is shared |
> | `src/utils/hash.ts` | `src/telegram/hash.ts` (re-exports `lib/apikey.sha256Hex`) | one crypto path |
> | root `README.md` / `wrangler.toml.example` | `docs/telegram-bot.md` / `docs/telegram-bot.wrangler.example.toml` | repo file-org rule |

## Files

```
src/telegram/types.ts        Zod schemas (Telegram Update) + bot domain types
src/telegram/env.ts          env validation + allow-list parsing
src/telegram/hash.ts         salted-hash helper for log identifiers (reuses sha256Hex)
src/telegram/auth.ts         webhook secret check + authorization + canViewSensitiveData
src/telegram/commands.ts     ES/EN command parser (deterministic, pure)
src/telegram/intent.ts       OPTIONAL Workers-AI intent normalization (parse only)
src/telegram/redaction.ts    CaseRecord → public-safe view (reuses minor-protect)
src/telegram/responses.ts    deterministic bilingual response builder
src/telegram/audit.ts        audit logging + abuse/scraping detection (hashed ids)
src/telegram/route.ts        Hono route: POST /webhook + GET /health + resolveQuery
src/adapters/sismo911-api.ts read-only D1 data adapter (verification gate lives here)
test/telegram-bot.test.ts       auth, commands, response building, redaction-in-reply
test/telegram-redaction.test.ts redaction / public-view
test/telegram-matching.test.ts  matching, status mapping, verified-vs-unverified
```

Wired in: `src/index.ts` mounts `app.route('/api/telegram', telegram)`; `src/types.ts`
gains the Telegram env vars; `src/rbac/route-policy.ts` classifies `/api/telegram`
as route-authed (the webhook self-authenticates on the secret-token header).

## Commands

Spanish (default) and English are both parsed; replies default to Spanish unless
the message uses English command words/keywords.

```
/buscar cedula V12345678
/buscar nombre "Maria Perez" nacimiento 1980-05-12
/caso EXP-2026-0123
/status EXP-2026-0123
/hospitalizados nombre "Jose Garcia"
/missing nombre "Ana Rodriguez"
/ayuda
# English aliases: /search /case /status /hospitalized /missing /help
#   keywords: id|name|dob|birth|phone|city
```

## Matching rules (strictness ladder)

| Input | Strength | Behavior |
|---|---|---|
| exact case id (`/caso`,`/status`) | strongest | direct lookup |
| exact national id (cédula) | strong | `hospital_patients.cedula` + `case_identity` (institution-confirmed ⇒ OFFICIAL) |
| full name + DOB | strong | name search; DOB-derived age must corroborate the row's age |
| full name only | weak | returns possible matches → "multiple", no sensitive data |
| partial name (1 short token) | — | refused → "send more info" |
| phone | sensitive | operators only; refused for public viewers |

**Verification gate (no-hallucination guarantee).** A final `ALIVE / DEATH /
MISSING / HOSPITALIZED / LOCATED` status is emitted **only** when the record is
`VERIFIED` (operator-approved, or an un-conflicted official hospital-feed row) or
`OFFICIAL` (cédula confirmed against CNE/SAIME). Anything else collapses to
`PENDING_VERIFICATION` — the bot will not assert the underlying claim. The status
is always read from a DB row; the LLM never produces it.

## Data-response policy

Public/group replies carry only: case id · public status · verification level ·
general (city/state) location · last-verified date · recommended next action.
**Redacted by default:** full cédula, exact address, phone, hospital name,
medical notes, family contact, minors' detail, unverified allegations. Sensitive
detail is shown only to an admin/authorized user **in a private DM** — never in a
group, even an approved one. Resolved minors and operator-`protected` cases are
suppressed from public viewers entirely (reuses `lib/minor-protect`).

## Security

- Webhook authenticity: constant-time check of the `X-Telegram-Bot-Api-Secret-Token`
  header against `TELEGRAM_WEBHOOK_SECRET` (fail closed).
- Authorization: approved groups only; DMs only for admins/authorized users.
- Zod-validated payloads; SQL is fully parameterized; read-only (no writes to case data).
- Per-user rate limiting (burst 8/30s) + scraping detection (40/3600s ⇒ admin alert),
  keyed by a **hashed** user id via the existing D1 limiter.
- Audit: every query logged to the `audit` table with the user identified only by
  a salted 64-bit hash and a query fingerprint — **no raw PII in logs**.
- No stack traces to users; safe generic error text.
- Least privilege: only `TELEGRAM_BOT_TOKEN` is privileged, and it is a Worker
  Secret. No token/credential/DB URL is hardcoded — all config is env-sourced.

---

## Deployment

### 1. Create the bot (BotFather)

In Telegram, message **@BotFather** → `/newbot` → copy the bot token.

### 2. Set the secrets (never in git)

```bash
cd ~/projects/sismo911            # (or your worktree)
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID   # use the gmail OAuth session

# the BotFather token:
npx wrangler secret put TELEGRAM_BOT_TOKEN

# a random webhook secret (generate locally; do not echo it):
openssl rand -hex 32 | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

### 3. Add the non-secret allow-lists to `wrangler.toml`

Append the `[vars]` entries from `docs/telegram-bot.wrangler.example.toml`
(`ALLOWED_TELEGRAM_GROUP_IDS`, `ADMIN_TELEGRAM_USER_IDS`, optionally
`ALLOWED_TELEGRAM_USER_IDS`) into the existing `[vars]` block, with your real
chat/user ids. Group ids are **negative**. To find a group's id, add the bot to
the group and read the `chat.id` from the bot's logs, or use a helper like
@RawDataBot.

### 4. Deploy

```bash
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
~/.claude/scripts/ship-deploy.sh ~/projects/sismo911     # build + wrangler deploy, serialized
```

### 5. Register the Telegram webhook

The secret you set in step 2 must match the one Telegram echoes back:

```bash
# read the secret WITHOUT printing it, then register the webhook:
SECRET="$(openssl rand -hex 32)"   # ← use the SAME value you piped to the secret in step 2

curl -fsS "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H 'content-type: application/json' \
  -d "{\"url\":\"https://sismo911.com/api/telegram/webhook\",\"secret_token\":\"$SECRET\",\"allowed_updates\":[\"message\"]}"
```

> Practical tip: generate the random value **once**, pipe it into
> `wrangler secret put TELEGRAM_WEBHOOK_SECRET`, and reuse the exact same value
> in `secret_token` here. Do not paste it into chat/logs.

Verify (no secrets returned):

```bash
curl -fsS "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
curl -fsS "https://sismo911.com/api/telegram/health"   # {"ok":true,"configured":true,...}
```

### Env var checklist

| Name | Kind | Required | Purpose |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Worker Secret | ✅ | BotFather token; sending + webhook auth |
| `TELEGRAM_WEBHOOK_SECRET` | Worker Secret | ✅ | echoed by Telegram; constant-time verified |
| `ALLOWED_TELEGRAM_GROUP_IDS` | `[vars]` | ✅ (else no group works) | approved chats |
| `ADMIN_TELEGRAM_USER_IDS` | `[vars]` | ✅ for sensitive access | admins (DM + alerts) |
| `ALLOWED_TELEGRAM_USER_IDS` | `[vars]` | optional | extra authorized users |
| `TELEGRAM_AI_MODEL` | `[vars]` | optional | intent-parsing model override |
| `AI` | binding | optional | Workers AI; intent parsing degrades gracefully if absent |

### Verify / test commands

```bash
npm run typecheck      # tsc --noEmit
npm test               # full vitest suite (includes the 3 telegram test files)
npm run build          # css + admin bundle
gitleaks dir . --config .gitleaks.toml   # confirm no secret committed
```

No secrets are committed: the code reads everything from `env`; the only files
added under git are source, tests, and these docs.
