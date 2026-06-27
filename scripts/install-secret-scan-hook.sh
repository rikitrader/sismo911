#!/usr/bin/env bash
# install-secret-scan-hook.sh — install the secret scanner as a pre-commit hook.
# Composes with the existing worktree guard (appends, never overwrites). Hooks
# live in the shared .git, so installing once covers main + every worktree.
set -euo pipefail
repo_root="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || git rev-parse --git-dir)"
hooks="$repo_root/hooks"; mkdir -p "$hooks"
hook="$hooks/pre-commit"
marker='# >>> sismo911 secret-scan >>>'
# Skip-if-absent: only enforce when this worktree/branch actually has the script,
# so the shared hook never blocks commits on branches predating it.
scan='S="$(git rev-parse --show-toplevel)/scripts/secret-scan.sh"; [ -x "$S" ] && { "$S" staged || exit 1; } || true'

if [ ! -f "$hook" ]; then
  printf '#!/usr/bin/env bash\nset -e\n%s\n%s\n# <<< sismo911 secret-scan <<<\n' "$marker" "$scan" > "$hook"
elif ! grep -qF "$marker" "$hook"; then
  printf '\n%s\n%s\n# <<< sismo911 secret-scan <<<\n' "$marker" "$scan" >> "$hook"
fi
chmod +x "$hook"
echo "✓ secret-scan pre-commit hook installed at $hook"
