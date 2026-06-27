#!/usr/bin/env bash
# bootstrap-secrets.sh — idempotent Cloudflare Worker secret setup.
# Verifies auth + worker, lists which manifest secrets are present vs missing,
# prompts ONLY for the missing ones, uploads them, re-validates, prints a report.
# Re-running with everything set is a no-op. Values are read silently (never
# echoed, never written to disk, never committed).
#
#   bash scripts/bootstrap-secrets.sh              # required + recommended
#   bash scripts/bootstrap-secrets.sh --all        # include optional
#   bash scripts/bootstrap-secrets.sh --rotate NAME # force re-enter one secret
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID   # use the OAuth session

include_optional=false; rotate=""
while [ $# -gt 0 ]; do case "$1" in
  --all) include_optional=true;; --rotate) rotate="${2:-}"; shift;; esac; shift; done

WORKER="$(grep -E '^name[[:space:]]*=' wrangler.toml | head -1 | cut -d'"' -f2)"
echo "▸ Bootstrapping secrets for Worker: $WORKER"
npx --no-install wrangler whoami 2>/dev/null | grep -qiE 'logged in|associated with' \
  || { echo "🛑 not authenticated — run: wrangler login"; exit 1; }

SECRETS_JSON="$(npx --no-install wrangler secret list 2>/dev/null || echo '[]')"
have(){ echo "$SECRETS_JSON" | grep -q "\"$1\""; }
put(){ # $1=name $2=desc — read silently, pipe to wrangler (value never printed)
  printf '   • %s — %s\n     enter value (input hidden, blank to skip): ' "$1" "$2"
  read -rs val; echo
  [ -z "$val" ] && { echo "     ↳ skipped"; return; }
  printf '%s' "$val" | npx --no-install wrangler secret put "$1" >/dev/null 2>&1 \
    && echo "     ↳ ✓ set" || echo "     ↳ ✗ failed"
  unset val
}

set_count=0
while IFS='|' read -r name level desc; do
  case "$name" in ''|\#*) continue;; esac
  $include_optional || [ "$level" != optional ] || continue
  if [ -n "$rotate" ] && [ "$name" != "$rotate" ]; then continue; fi
  if [ -z "$rotate" ] && have "$name"; then echo "   ✓ $name already set"; continue; fi
  put "$name" "$desc"; set_count=$((set_count+1))
done < scripts/secrets.manifest

echo "▸ Re-validating…"
SECRETS_JSON="$(npx --no-install wrangler secret list 2>/dev/null || echo '[]')"
miss=0
while IFS='|' read -r name level _d; do
  case "$name" in ''|\#*) continue;; esac
  [ "$level" = required ] || continue
  have "$name" && echo "   ✓ required $name present" || { echo "   ✗ required $name STILL missing"; miss=$((miss+1)); }
done < scripts/secrets.manifest
echo "▸ done — prompted for $set_count secret(s); $miss required still missing."
[ "$miss" -eq 0 ] || exit 1
