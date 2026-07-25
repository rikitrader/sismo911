# Deployment credential separation

The deploy workflow uses two GitHub Actions secrets:

- `CLOUDFLARE_API_TOKEN`: Worker/container deployment permissions only.
- `CLOUDFLARE_D1_API_TOKEN`: D1 database read/write permission for remote
  migrations only.
- `CLOUDFLARE_ACCOUNT_ID`: the account identifier.

The D1 token should be scoped to the account and granted only `D1:Edit` (or
the current Cloudflare equivalent). The deployment token should retain the
Worker Scripts/Containers permissions required by `npm run deploy`, but does
not need D1 write access. Both tokens should have an expiration and should be
stored only as masked GitHub Actions secrets.

The workflow fails before any migration if `CLOUDFLARE_D1_API_TOKEN` is
missing. This prevents a partial deploy that runs application code against an
unapplied schema migration.
