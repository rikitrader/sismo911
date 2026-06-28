#!/usr/bin/env bash
# Seed a few DEMO flota_units into the LOCAL D1 only — for development/staging.
#
# HARD RULE: no fake data in production. This script ALWAYS uses `--local` and
# refuses any attempt to target remote/prod. There is no flag to point it at
# production — by design. To demo on a deployed staging Worker, point it at a
# separate staging D1, never the prod `sismo911` remote.
set -euo pipefail

# Refuse if anyone tries to sneak a remote/prod target in via args.
for arg in "$@"; do
  case "$arg" in
    --remote|--env=prod*|--env=production*|production|prod)
      echo "REFUSED: this seed is LOCAL-ONLY. No fake data in production." >&2
      exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."
echo "Seeding DEMO flota_units into the LOCAL D1 (never remote)…"
npx wrangler d1 execute sismo911 --local --file=./migrations/seed_flota_demo.sql
echo "Done. 4 demo units in LOCAL D1. (Production untouched.)"
