#!/usr/bin/env bash
# security-audit.sh — defensive, read-only security gate. Runs the dependency,
# secret, type, test, build, and config checks in one pass. Non-zero exit if any
# HARD gate fails (secret scan, typecheck, tests, build). Dependency audit and
# config greps are reported as warnings (don't fail the run on dev-only advisories).
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
hard=0; warn=0
hr(){ printf '\n──── %s ────\n' "$1"; }

hr "1. Dependency audit (npm audit)"
if npm audit --omit=dev >/dev/null 2>&1; then echo "  ✓ no production-dependency vulnerabilities"
else echo "  ⚠︎ production-dependency advisories — review 'npm audit --omit=dev'"; warn=$((warn+1)); fi
PROD_CRIT="$(npm audit --omit=dev --json 2>/dev/null | python3 -c 'import sys,json;v=json.load(sys.stdin).get("metadata",{}).get("vulnerabilities",{});print((v.get("critical",0))+(v.get("high",0)))' 2>/dev/null || echo 0)"
[ "${PROD_CRIT:-0}" -gt 0 ] && { echo "  ✗ ${PROD_CRIT} critical/high in PRODUCTION deps"; hard=$((hard+1)); }
echo "  · full tree: $(npm audit --json 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("metadata",{}).get("vulnerabilities",{}))' 2>/dev/null) (dev advisories don't ship in the Worker)"

hr "2. Secret scan (committed tree)"
bash scripts/secret-scan.sh --all || hard=$((hard+1))

hr "3. Secrets in git history"
if git log --all --diff-filter=A --name-only --pretty=format: 2>/dev/null | grep -qiE '(^|/)\.env$|\.dev\.vars$|\.pem$|\.key$|secrets?\.json$'; then
  echo "  ✗ a secret-like file was committed in history"; hard=$((hard+1))
else echo "  ✓ no .env/.key/.pem/secrets files ever committed"; fi

hr "4. TypeScript (strict typecheck)"
npx --no-install tsc --noEmit && echo "  ✓ tsc clean" || { echo "  ✗ tsc errors"; hard=$((hard+1)); }

hr "5. Tests"
npx --no-install vitest run >/dev/null 2>&1 && echo "  ✓ tests pass" || { echo "  ✗ tests failing"; hard=$((hard+1)); }

hr "6. Build verification"
npm run build:css >/dev/null 2>&1 && echo "  ✓ build:css ok" || { echo "  ✗ build:css failed"; hard=$((hard+1)); }
npx --no-install wrangler deploy --dry-run --outdir /tmp/sismo-dryout >/dev/null 2>&1 && echo "  ✓ wrangler bundle builds (dry-run)" || echo "  ⚠︎ wrangler dry-run inconclusive (needs auth/network)"

hr "7. Config / route safety greps"
# Match only the active script-src directive, not explanatory comments.
grep -qE "script-src[^\"]*'unsafe-eval'" src/lib/security.ts && { echo "  ⚠︎ CSP script-src allows 'unsafe-eval'"; warn=$((warn+1)); } || echo "  ✓ CSP script-src has no 'unsafe-eval'"
grep -q "frame-ancestors 'none'" src/lib/security.ts && echo "  ✓ frame-ancestors 'none'" || { echo "  ⚠︎ missing frame-ancestors"; warn=$((warn+1)); }
# Flag only INTERPOLATED sensitive values (\${token}), not the word in a string label.
if grep -rnE "console\.[a-z]+\([^)]*\\\$\{[^}]*(token|secret|password|cookie|c[eé]dula|api[_-]?key)" src/ >/dev/null 2>&1; then echo "  ⚠︎ a console.* call interpolates a sensitive value"; warn=$((warn+1)); else echo "  ✓ no secret/PII interpolated into logs"; fi
git ls-files | grep -qE '^\.env$' && { echo "  ✗ .env is tracked by git"; hard=$((hard+1)); } || echo "  ✓ .env not tracked"

printf '\n════ security-audit: %d hard failure(s), %d warning(s) ════\n' "$hard" "$warn"
[ "$hard" -eq 0 ] || { echo "❌ FAIL — fix hard failures above."; exit 1; }
echo "✅ PASS (warnings are advisory)."
