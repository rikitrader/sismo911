# SISMO911 Mobile

Native iOS and Android client for SISMO911. Phase 1 opens directly to missing-person reporting and writes to the existing Cloudflare Worker API at `https://sismo911.com/api/persons`.

## Development

```bash
npm install
npm run start
```

## Verification

```bash
npm run typecheck
npm run lint
```

## Store Builds

```bash
npm run build:android
npm run build:ios
```

Before production submission, replace `extra.eas.projectId` in `app.json` with the EAS project id created by `eas init`.
