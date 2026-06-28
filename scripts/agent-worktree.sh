#!/usr/bin/env bash
# Project rule (REQUIRED): every agent works in its OWN git worktree, NEVER the
# shared canonical checkout. Sharing one working tree across concurrent agents
# causes branch slips (a commit landing on local `main` when another agent runs
# `git checkout`), a dirty `main`, `node_modules` corruption from racing
# `npm install`s, and general checkout races. A worktree gives each agent an
# isolated working directory while sharing the same `.git`.
#
# Usage:
#   wt=$(./scripts/agent-worktree.sh <branch-name>) && cd "$wt"
#   # ...edit, commit, push, open PR from inside "$wt"...
#
# This is a thin, dependency-free wrapper over the global helper, which:
#   - bases a NEW branch on a freshly-fetched origin/main (no stale start),
#   - resumes an existing local/remote branch idempotently (keyed by branch),
#   - prints the worktree path on stdout (so `wt=$(...)` works),
#   - lives worktrees under ~/.claude/worktrees/<repo>/<branch-slug>.
# Helpers: --list, --trace [repo-dir], --remove <branch>, --prune.
set -euo pipefail

HELPER="${AGENT_WORKTREE_HELPER:-$HOME/.claude/scripts/agent-worktree.sh}"

if [[ ! -x "$HELPER" ]]; then
  {
    echo "ERROR: agent-worktree helper not found/executable at: $HELPER"
    echo
    echo "Install the Claude global scripts, or create a worktree manually:"
    echo "  git fetch origin"
    echo "  git worktree add ~/.claude/worktrees/sismo911/<branch> -b <branch> origin/main"
    echo "  cd ~/.claude/worktrees/sismo911/<branch>"
  } >&2
  exit 1
fi

exec "$HELPER" "$@"
