# DB Ingestion Gatekeeper

A fail-closed validation pipeline that blocks spam, poisoned data, malicious
files, fake metadata, duplicates, and malformed payloads **before** anything
reaches D1, R2, or KV. Built on SISMO911's existing anti-abuse primitives
(`src/lib/security.ts`, `src/lib/clean.ts`) rather than replacing them.

> **Why this exists.** SISMO911 is a life-safety missing-persons + disaster
> registry. Its DB has already been hit with link-spam names
> (`TRUSTEDF57 - infinityhotel.it`), a name flood (`SIMONE BURATTI` ×353), and
> stored-XSS (`"><svg/onload=…>`), and its bulk ingests imported **~7.8k exact
> duplicate `personas` and ~2.5k duplicate `rav_reports`**. The gate stops all of
> that at the door. Crucially it is tuned so **legitimate** disaster data is never
> rejected: Venezuelan cédula (CI) numbers in name fields and X/Instagram/Google
> Maps source links in description fields **pass**.

## Pipeline

```
request → secureIngest middleware
        → rate limit (per-IP + per-account, D1-atomic)
        → Turnstile (verify-if-present / required / off)
        → JSON shape guard (size, nesting, key-count, malformed)
        → strict field allowlist (reject unknown keys)
        → zod schema (normalize + coerce + length caps)
        → payload hash → replay/dedupe ledger
        → spam scoring (weighted; reject ≥ SPAM_THRESHOLD)
        → file scan (magic bytes ↔ MIME ↔ ext, size, no exe/SVG/polyglot, SHA-256)
        → safe write to D1/R2  →  audit ledger (clean_ingestions)
   (any reject → generic client error + rejected_ingestions row + structured log)
```

## Files

| File | Purpose |
|---|---|
| `src/security/validators.ts` | Unicode hygiene, HTML stripping, JSON shape guards, field allowlist, injection detectors, reusable zod fields |
| `src/security/spam-score.ts` | Weighted spam scoring + disposable-email detection |
| `src/security/file-scan.ts` | Magic-byte sniff, MIME/ext agreement, exe/SVG/polyglot rejection, SHA-256, safe filename/key |
| `src/security/rate-limit.ts` | Per-IP + per-account limiter, content-hash replay, optional Durable Object counter |
| `src/security/metadata-cleaner.ts` | Trusted-key metadata bag: URL/timestamp/geo/bool/number normalization, tracking-param stripping |
| `src/security/ingestion-gate.ts` | Orchestrator: `runGate()`, Turnstile verify, reason codes, ledger writes |
| `src/middleware/secure-ingest.ts` | Hono middleware `secureIngest()` + `getClean()` |
| `src/routes/secure-ingest-example.ts` | Reference wiring: contact form, photo upload, API ingestion |
| `migrations/0028_ingestion_gatekeeper.sql` | `rejected_ingestions`, `clean_ingestions`, `ingest_dedupe` |
| `test/ingestion-gate.test.ts` | 44 unit + integration tests (real pass/fail payloads) |

## Setup

1. **Install dep** (already added to `package.json`): `npm install` (adds `zod`).
2. **Apply the migration**: `unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID && npm run db:migrate:remote` (and `:local` for dev).
3. **Configure env** (all optional — safe defaults; the gate degrades gracefully):

   | Var | Default | Meaning |
   |---|---|---|
   | `TURNSTILE_SECRET_KEY` | _(unset → skip)_ | Cloudflare Turnstile secret. `wrangler secret put TURNSTILE_SECRET_KEY` |
   | `MAX_FILE_SIZE` | `8388608` (8 MiB) | Max upload bytes |
   | `SPAM_THRESHOLD` | `100` | Reject score ≥ this (lower = stricter) |
   | `EMAIL_BLOCKLIST` | _(empty)_ | Extra disposable email domains, comma-separated |
   | `COUNTRY_BLOCKLIST` | _(empty)_ | `cf.country` codes to block, comma-separated |
   | `ALLOW_SVG_UPLOADS` | `0` | Set `1` to allow (still rejects active SVG) |

4. **(Optional) Turnstile widget** on the form: add the
   `<div class="cf-turnstile" data-sitekey="…"></div>` and submit the
   `cf-turnstile-response` field. The gate verifies it when `turnstile` is
   `'optional'`/`'required'`.
5. **Mount the example** (optional) in `src/index.ts`:
   `app.route('/api/secure-example', secureExample)`.

## Using it on a route

```ts
import { secureIngest, getClean } from '../middleware/secure-ingest';
import { recordClean } from '../security/ingestion-gate';
import { z, nameField, textField } from '../security/validators';

const Schema = z.object({ name: nameField(120), message: textField(2000) });

app.post('/api/contact',
  secureIngest({
    surface: 'contact', schema: Schema,
    allowedFields: ['name', 'message'],
    nameFields: ['name'], textFields: ['message'],
    honeypotField: 'website', turnstile: 'optional',
    ipLimit: 5, ipWindowSec: 60,
  }),
  async (c) => {
    const { data, correlationId, payloadHash, score } = getClean(c);
    const id = uid('msg');
    await c.env.DB.prepare('INSERT INTO … VALUES (?,?,?)').bind(id, data.name, data.message).run();
    await recordClean(c.env, c, { correlationId, surface: 'contact', destTable: '…', destId: id, score, payloadHash });
    return c.json({ ok: true, ref: correlationId });
  },
);
```

The handler only runs for **passed** requests; rejects return a generic Spanish
message + a `ref` (correlation id) the user can quote to support. The detailed
reason is in `rejected_ingestions` and the structured log, never in the response.

## What passes vs. what is blocked

**PASS** (legitimate SISMO911 data):
- `Zoralda Martinez CI 6092167` — cédula in a name
- `Post en X https://x.com/abogadosvenezu1/status/2070144445811470426` — source link in a description
- `https://maps.app.goo.gl/c3ZYtkwa34AYmjzN7 av la Costanera` — map link in a description
- `Personas atrapadas: 2. Catia la Mar, residencia albacora` — a real distress report

**BLOCKED**:
- `TRUSTEDF57 - infinityhotel.it` — bare-domain link-spam in a name
- `"><svg/onload=("@jofpin");>` — stored-XSS markup
- `simone buratti gay` — known flood phrase
- honeypot field filled / disposable email + bot user-agent
- a `.exe`/ELF/Mach-O, an SVG with `<script>`, or a JPEG with embedded `<script>` (polyglot)
- a MIME that disagrees with the magic bytes
- malformed JSON, > size, > 8 levels deep, unknown fields
- the exact same payload resubmitted within 24h (replay)

## Audit tables

- **`rejected_ingestions`** — every block: reason code, score, ip/asn/country, UA, payload hash, truncated sample.
- **`clean_ingestions`** — every accept: correlation id ↔ `dest_table`/`dest_id`/`r2_key`.
- **`ingest_dedupe`** — content hashes (payload + file) with hit counts, for replay + dedupe.

Triage queries:

```sql
-- top rejection reasons in the last day
SELECT reason, COUNT(*) n FROM rejected_ingestions
 WHERE created_ms > (unixepoch()*1000 - 86400000) GROUP BY reason ORDER BY n DESC;

-- repeat offenders by IP
SELECT ip, COUNT(*) n FROM rejected_ingestions GROUP BY ip ORDER BY n DESC LIMIT 20;

-- most-resubmitted content
SELECT hash, kind, hits FROM ingest_dedupe ORDER BY hits DESC LIMIT 20;
```

## Notes / limits

- **EXIF**: the Workers runtime has no native re-encoder, so EXIF is not stripped
  in-Worker. The gate's posture: store raw bytes under a content-hash key and
  **never persist client metadata** (geotags/camera/timestamps) into D1 — only
  gate-validated fields are written. For full scrubbing, route through Cloudflare
  Images and store that variant (`TODO: env.IMAGES`).
- **Fail-open vs fail-closed**: validation fails **closed** (reject on any error),
  but rate-limit/replay infra errors fail **open** — a dropped throttle is
  recoverable; a dropped life-safety report is not. Never put the gate in front of
  the SOS / "estoy a salvo" endpoints with a hard rate limit.
- **The cron ingests** (`rav-cron`, `familia-cron`) are where most data — and most
  duplicates — actually enter. `runGate()` is callable from them directly; adopting
  the payload-hash dedupe there is the highest-leverage follow-up.
