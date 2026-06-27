#!/usr/bin/env bash
# preflight.sh — deployment guard. Run BEFORE every deploy / remote migration.
# Validates auth, account, tooling, required Worker secrets, D1 access (catches
# Error 7500 early), and pending migrations. Aborts (exit 1) on any REQUIRED
# failure; warnings don't block. Read-only — never mutates the Worker.
#
#   bash scripts/preflight.sh            # full preflight
#   bash scripts/preflight.sh --quick    # skip the remote D1 round-trip
set -uo pipefail
quick=false; [ "${1:-}" = "--quick" ] && quick=true
cd "$(git rev-parse --show-toplevel)"

# Locally: never let an auto-loaded .env Cloudflare token override the OAuth
# session (wrangler v4 auto-loads .env). In CI the token IS the intended auth
# (a GitHub Secret), so DO NOT unset there.
if [ -n "${CI:-}" ] || [ -n "${GITHUB_ACTIONS:-}" ]; then
  echo "ℹ︎  CI detected — using the provided CLOUDFLARE_API_TOKEN (not unsetting)."
else
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || grep -qsE '^CLOUDFLARE_(API_TOKEN|ACCOUNT_ID)=' .env 2>/dev/null; then
    echo "ℹ︎  Cloudflare creds present in env/.env — unsetting for this local run so the OAuth session is used."
  fi
  unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
fi

WORKER="$(grep -E '^name[[:space:]]*=' wrangler.toml | head -1 | cut -d'"' -f2)"
fails=0; warns=0
ok(){ echo "  ✓ $1"; }
warn(){ echo "  ⚠︎ $1"; warns=$((warns+1)); }
bad(){ echo "  ✗ $1"; fails=$((fails+1)); }

echo "▸ SISMO911 deploy preflight (worker: ${WORKER:-?})"

# 1) Tooling versions
node -v >/dev/null 2>&1 && ok "node $(node -v)" || bad "node not found"
WV="$(npx --no-install wrangler --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
[ -n "$WV" ] && ok "wrangler $WV" || warn "could not read wrangler version"

# 2) Auth (OAuth session)
WHO="$(npx --no-install wrangler whoami 2>/dev/null)"
if echo "$WHO" | grep -qiE 'logged in|associated with'; then
  ok "authenticated ($(echo "$WHO" | grep -oiE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+' | head -1))"
else
  bad "not authenticated — run: wrangler login"
fi

# 3) Required + recommended Worker secrets (from the manifest)
SECRETS_JSON="$(npx --no-install wrangler secret list 2>/dev/null || echo '[]')"
have(){ echo "$SECRETS_JSON" | grep -q "\"$1\""; }
if [ -f scripts/secrets.manifest ]; then
  while IFS='|' read -r name level _desc; do
    case "$name" in ''|\#*) continue;; esac
    if have "$name"; then ok "secret $name"
    elif [ "$level" = required ]; then bad "REQUIRED secret missing: $name  → wrangler secret put $name"
    elif [ "$level" = recommended ]; then warn "recommended secret missing: $name"
    fi
  done < scripts/secrets.manifest
fi

# 4) D1 access — catches Error 7500 / bad token / missing D1 scope BEFORE migrating.
if ! $quick; then
  D1OUT="$(npx --no-install wrangler d1 execute "$WORKER" --remote --command 'SELECT 1 AS ok' 2>&1 || true)"
  if echo "$D1OUT" | grep -qE '"ok": ?1|│ ok |\bok\b.*1'; then ok "D1 remote reachable"
  elif echo "$D1OUT" | grep -qiE '7500|Authentication|permission|Unauthorized|10000'; then
    bad "D1 access failed (token/scope). Use OAuth (wrangler login) or a token with D1 Edit. Detail: $(echo "$D1OUT" | grep -iE '7500|Auth|permission' | head -1)"
  else warn "D1 check inconclusive: $(echo "$D1OUT" | tail -1 | cut -c1-100)"; fi

  # 5) Pending migrations (informational)
  MIG="$(npx --no-install wrangler d1 migrations list "$WORKER" --remote 2>&1 || true)"
  if echo "$MIG" | grep -qiE 'No migrations to apply'; then ok "no pending D1 migrations"
  else warn "pending D1 migrations — apply before/with deploy ($(echo "$MIG" | grep -cE '^\s*│\s*[0-9]') file(s))"; fi
fi

# 6) Git hygiene (warn only)
[ -z "$(git status --porcelain 2>/dev/null)" ] && ok "working tree clean" || warn "uncommitted changes in working tree"

echo "▸ preflight: $fails error(s), $warns warning(s)"
if [ "$fails" -gt 0 ]; then echo "🛑 DEPLOY BLOCKED — fix the error(s) above."; exit 1; fi
echo "✅ preflight passed — safe to deploy."
