#!/usr/bin/env bash
# secret-scan.sh — block secrets from entering git. Scans staged changes by
# default (pre-commit hook); `--all` scans every tracked file (CI/manual).
# Exit 0 = clean, 1 = secret(s) found. Add `pragma: allowlist secret` on a line
# to whitelist an intentional example/placeholder.
set -uo pipefail
mode="${1:-staged}"

# High-signal credential patterns (provider tokens + private keys). Tuned to
# avoid the obvious false positives (placeholders, *_PUBLIC_*, whsec_… docs).
patterns=(
  'CLOUDFLARE_API_TOKEN[[:space:]]*[=:][[:space:]]*["'"'"']?[A-Za-z0-9_-]{30,}'
  'X-Auth-Key[[:space:]]*:[[:space:]]*[0-9a-f]{37}'
  'AKIA[0-9A-Z]{16}'
  'aws_secret_access_key[[:space:]]*=[[:space:]]*[A-Za-z0-9/+]{40}'
  'gh[posr]_[0-9A-Za-z]{36,}'
  'github_pat_[0-9A-Za-z_]{60,}'
  'sk_live_[0-9A-Za-z]{20,}'
  'rk_live_[0-9A-Za-z]{20,}'
  'sk-ant-[A-Za-z0-9_-]{20,}'
  'sk-proj-[A-Za-z0-9_-]{20,}'
  'AIza[0-9A-Za-z_-]{35}'
  'xox[baprs]-[0-9A-Za-z-]{10,}'
  'SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}'
  '-----BEGIN[[:space:]]+(RSA[[:space:]]|EC[[:space:]]|OPENSSH[[:space:]]|DSA[[:space:]])?PRIVATE[[:space:]]KEY-----'
  '"private_key"[[:space:]]*:[[:space:]]*"-----BEGIN'
)

# File list to scan (bash 3.2 compatible — no mapfile).
files=()
if [ "$mode" = "--all" ]; then list_cmd="git ls-files"; else list_cmd="git diff --cached --name-only --diff-filter=ACM"; fi
while IFS= read -r line; do [ -n "$line" ] && files+=("$line"); done < <($list_cmd)
[ "${#files[@]}" -eq 0 ] && { echo "✓ secret-scan: nothing to scan (${mode})."; exit 0; }

skip='node_modules/|/.git/|dist/|build/|\.next/|public/app\.css|package-lock\.json|pnpm-lock|yarn\.lock'
hits=0
for f in "${files[@]}"; do
  [ -f "$f" ] || continue
  echo "$f" | grep -qE "$skip" && continue
  for p in "${patterns[@]}"; do
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      echo "$line" | grep -q 'pragma: allowlist secret' && continue
      echo "🛑 possible secret in $f:"; echo "   ${line%%:*}: $(echo "$line" | cut -d: -f2- | cut -c1-80)…"
      hits=$((hits+1))
    done < <(grep -nIE "$p" "$f" 2>/dev/null)
  done
done

if [ "$hits" -gt 0 ]; then
  echo ""
  echo "❌ secret-scan: $hits potential secret(s) found — commit BLOCKED."
  echo "   Move it to a Cloudflare Worker Secret (wrangler secret put) or GitHub Secret."
  echo "   If it is a genuine non-secret example, append '# pragma: allowlist secret' to the line."
  exit 1
fi
echo "✓ secret-scan clean (${mode}, ${#files[@]} file(s))."
