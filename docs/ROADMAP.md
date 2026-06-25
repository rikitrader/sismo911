# SISMO911 — Roadmap to 100% Working

**Last updated:** 2026-06-25
**Live:** https://app.sismo911.com · https://sismo911.com · https://sismo911.rikitrader.workers.dev
**Repo:** github.com/rikitrader/sismo911 · **Stack:** Cloudflare Workers + Hono + D1 + KV

---

## What "100% working" means (definition of done)

The app is 100% when **every feature either (a) works end-to-end on live data with a passing verify command, or (b) is a typed adapter that is honestly flagged as needing a credential/partnership that does not yet exist** — with no fabricated data and no silent failures. Concretely:

1. Every API endpoint returns real data (HTTP 200 + expected shape) — verified by `curl`.
2. Every UI surface renders that data and degrades gracefully offline.
3. All PII (missing persons, location, check-ins) is access-controlled + privacy-compliant.
4. Security: admin + writes behind Access; rate limiting; input validation at boundaries.
5. Production hardening: real test suite green in CI, Tailwind built (not CDN), observability on, performance budget met, PWA installable.
6. A coverage/accuracy disclaimer is shown wherever data is provisional or geographically limited.

---

## Honesty constraints (do not violate)

- **USGS** = real, global, live. ✅
- **NOAA/NWS** tsunami + weather = real, free; **Caribbean** tsunami covers Venezuela's coast. ✅
- **OpenFEMA / ShakeAlert** = **US-only**. They do **not** cover Venezuela. Build as data sources but label "EE.UU. solamente — sin cobertura en Venezuela."
- **Closed government systems** (Protección Civil / FUNVISIS / Defensa operational DBs) have **no public API**. We hold this data via admin entry + typed adapters; we never fake a live link.
- **Licensed/paid** feeds (ShakeAlert license, commercial satellite, power-utility APIs, state 511 traffic) stay **stubbed + flagged** until credentials/partnerships exist.

---

## Phase 0 — Foundation ✅ DONE

| Item | Status | Proof |
|---|---|---|
| CF Workers + Hono + D1 + KV scaffold | ✅ | deployed, `Worker Startup 5ms` |
| Live USGS ingestion (cron → KV + D1) | ✅ | `/api/events` returns M7.5 Yumare live |
| Dashboard + PAGER report + admin console | ✅ | render on real data |
| Missing-persons CRUD + emergency directory | ✅ | `/api/persons`, `/api/contacts` |
| Custom domains (apex + www + app) | ✅ | HTTP 200 globally |
| Brand emblem (logo.svg) wired everywhere | ✅ | favicon + headers |
| GitHub repo + CI + ADR-0001 | ✅ | green |

---

## Phase 1 — Multi-agency data & alerts  *(free APIs, build now)*

| # | Feature | Source (cost) | Verify |
|---|---|---|---|
| 1.1 | Tsunami + weather alerts | NOAA/NWS `api.weather.gov` CAP (free) | `/api/alerts` → `{alerts:[]}` |
| 1.2 | US disaster declarations (flagged US-only) | OpenFEMA (free) | `/api/fema` 200 |
| 1.3 | Significant-quake highlight + auto-PAGER for M≥5 | USGS (done) | `/api/events/:id` pager |
| 1.4 | Unified `/api/status` health for every source | internal | `gated` + `ingest` keys present |

**DoD:** alerts strip on dashboard; tsunami banner when active Caribbean warning.

---

## Phase 2 — Citizen safety  *(D1 + browser APIs, build now)*

| # | Feature | Notes | Verify |
|---|---|---|---|
| 2.1 | Emergency SOS mode | geolocation + nearest contacts + D1 report | `POST /api/sos` ok |
| 2.2 | Family safety check-ins | "I'm safe / need help" + map | `POST /api/checkins` ok |
| 2.3 | Live location sharing | opt-in, TTL'd, privacy notice | share link resolves |
| 2.4 | Resource & supply tracking | water/food/shelter inventory in D1 | `/api/resources` list |
| 2.5 | Offline emergency guide | service worker + cached first-aid/evac content | `/sw.js` served |

**DoD:** core pages usable offline; SOS works on mobile with one tap.

---

## Phase 3 — Maps & intelligence  *(free tiles + computed, build now)*

| # | Feature | Source | Verify |
|---|---|---|---|
| 3.1 | Risk heat map | event density + magnitude (Leaflet.heat) | `/api/heatmap` points |
| 3.2 | Nearby shelters + hospitals | OSM Overpass (free) | `/api/facilities?lat&lon` list |
| 3.3 | Satellite/imagery overlays | NASA GIBS + Esri World Imagery (free tiles) | layer toggle on map |
| 3.4 | Shaking-intensity (MMI) overlay | USGS ShakeMap where available | contour renders |

**DoD:** map has layer switcher (street / satellite / heat / shelters / MMI).

---

## Phase 4 — Notifications & comms  *(build now; push needs VAPID keygen only)*

| # | Feature | Notes | Verify |
|---|---|---|---|
| 4.1 | Web Push by magnitude + distance | VAPID (self-generated), subscribe → cron dispatch | `/api/push/vapid` publicKey |
| 4.2 | Per-user alert thresholds | min magnitude + radius in D1 | settings persist |
| 4.3 | HAM radio + emergency frequencies directory | curated static + D1 | `/api/comms` channels |

**DoD:** subscribing, then a new M≥threshold event in radius → push received.

---

## Phase 5 — AI features  *(Cloudflare Workers AI = free tier; or bring a key)*

| # | Feature | Model | Verify |
|---|---|---|---|
| 5.1 | AI situation reports | Workers AI (Llama) or Claude API | `/api/sitrep/:eventId` text |
| 5.2 | Damage-photo upload + AI assessment | Workers AI vision / Claude vision; R2 for storage | upload → severity score |

**Needs:** enable Workers AI binding (free) **or** an `ANTHROPIC_API_KEY`. R2 bucket for photos.
**DoD:** upload a photo → structured damage estimate; generate a sit-rep per major event.

---

## Phase 6 — Gated integrations  *(STUBBED + FLAGGED until creds/partnership)*

| # | Feature | Blocker |
|---|---|---|
| 6.1 | ShakeAlert (earthquake early warning) | **License required**; US West Coast only — no VE coverage |
| 6.2 | Power-outage integration | Utility APIs are proprietary/regional; no VE public feed |
| 6.3 | Road closures + traffic | US state 511 feeds (free, US-only); no VE equivalent |
| 6.4 | Social ingestion (X/FB/IG/TikTok) | Paid API / Apify token (`X_BEARER_TOKEN`, `APIFY_TOKEN`…) |
| 6.5 | Official gov data (Protección Civil/FUNVISIS/Defensa) | No public API — admin entry / data-sharing agreement |

**DoD:** each appears in `/api/status` as `configured:false` with a one-line reason; admin UI ready to receive data; flips live the moment a credential is set — zero code change to consumers.

---

## Phase 7 — Security & compliance

| # | Item | Verify |
|---|---|---|
| 7.1 | Cloudflare Access on `/admin` + writes | unauth → 401; auth → 200 (needs AUD+team — **your step**) |
| 7.2 | Rate limiting (CF Rate Limiting / WAF) on write + SOS | flood → 429 |
| 7.3 | Input validation at every boundary (zod) | bad payload → 400, never 500 |
| 7.4 | PII handling: missing persons + location | retention policy, consent text, no public exposure |
| 7.5 | Privacy policy + terms (Spanish) | pages live |
| 7.6 | Audit log for admin actions | D1 audit table |

**DoD:** an unauthenticated user cannot read or write any PII; abuse is rate-limited.

---

## Phase 8 — Production hardening

| # | Item | Verify |
|---|---|---|
| 8.1 | Tailwind: CDN → built CSS (no prod-CDN warning) | no console warning; smaller bundle |
| 8.2 | Real test suite (Vitest + Miniflare) for every route | `pnpm test` green |
| 8.3 | Error handling + structured logging + alerting | errors surfaced, not swallowed |
| 8.4 | Observability dashboards (Workers Analytics / Logpush) | metrics visible |
| 8.5 | PWA: installable, app icon (logo), offline shell | Lighthouse PWA pass |
| 8.6 | Performance budget (LCP < 2.5s, JS < 200KB) | Lighthouse/CWV pass |
| 8.7 | i18n pass (ES primary, EN optional) | strings centralized |
| 8.8 | Accessibility (WCAG AA) | axe clean |
| 8.9 | Branch protection + auto code-review on PRs | enforced on `main` |

**DoD:** CI green, Lighthouse ≥90 across the board, no prod warnings.

---

## Phase 9 — Launch

- DNS final (apex canonical, www→apex redirect), HSTS, security headers.
- Uptime monitoring + on-call runbook (`cap runbook`).
- Backups: D1 export schedule; R2 lifecycle.
- Load test the cron + read path.
- Coverage disclaimer + data-source attribution footer.
- Announcement + onboarding for Protección Civil operators.

---

## Credentials checklist (what unblocks gated work)

| To unlock | You provide |
|---|---|
| Lock `/admin` (Phase 7.1) | Access app **AUD tag** + **team name** (or a CF token with Access:Edit) |
| AI sit-reps + photo assessment (Phase 5) | Enable **Workers AI** (free) *or* `ANTHROPIC_API_KEY` |
| Social ingestion (Phase 6.4) | `X_BEARER_TOKEN` and/or `APIFY_TOKEN`, Meta Graph token, TikTok Research token |
| ShakeAlert (Phase 6.1) | ShakeAlert **license** (US only — likely N/A for VE) |
| Exact brand logo | save your PNG to `public/logo.png` |
| Official gov data | data-sharing agreement / CSV exports |

---

## Sequencing & effort (realistic)

- **Sprint 1** (Phases 1–2): alerts + citizen safety — the highest life-safety value, all free data.
- **Sprint 2** (Phase 3–4): maps intelligence + notifications.
- **Sprint 3** (Phase 5): AI features (Workers AI).
- **Sprint 4** (Phase 7–8): security + production hardening — **required before real public use**, especially PII.
- **Ongoing** (Phase 6): flip gated integrations live as credentials arrive.
- **Phase 9**: launch.

Driven by the goal loop `20260624-2345-sismo911-full-disaster-response-platform` — one task, one verify, one commit. No task marked done without a passing verify command.

---

## ⚠️ Reality check

This is a **life-safety** application. Phases 7–8 (security, PII, accuracy disclaimers, testing) are **not optional polish** — they are prerequisites before anyone relies on it in a real emergency. The free-data features (Phases 1–4) can ship fast; the responsibility bar for "100%" is the hardening, not the feature count.


---

## Completion status — 2026-06-25

| Phase | Status | Notes |
|---|---|---|
| 0 Foundation | ✅ Done | Workers+Hono+D1+KV, live USGS, custom domains, emblem |
| 1 Multi-agency data/alerts | ✅ Done | USGS + NOAA tsunami + OpenFEMA (US-labeled) |
| 2 Citizen safety | ✅ Done | SOS, check-ins, resources, offline guide (SW) |
| 3 Maps & intelligence | ✅ Done | heatmap, Overpass facilities, GIBS/Esri satellite |
| 4 Notifications & comms | ✅ Done | web-push (VAPID), HAM directory |
| 5 AI features | ✅ Done | sit-reps + damage-photo vision (Workers AI), LIVE |
| 6 Gated integrations | ⛔ Blocked (by design) | ShakeAlert license, social/gov keys, paid feeds — typed stubs flagged in /api/status |
| 7 Security & compliance | ✅ Done | auth/roles, rate limit, CSP/HSTS/XFO, validation, PII coord-blur, CORS+CSRF, privacy policy, 26 tests |
| 8 Production hardening | 🟡 ~90% | PWA ✓, tests+CI ✓, observability on; **Tailwind build deferred** (cosmetic perf); **branch protection needs GitHub Pro/public repo** |
| 9 Launch | 🟡 Mostly | domains ✓, HSTS ✓, privacy ✓, runbook ✓; uptime monitor + backup cron + announcement = ops tasks |

**Cannot be "completed" in code (need your action):** Phase 6 credentials/partnerships; GitHub Pro or public repo for branch protection; Tailwind build (deferred to avoid conflict with the in-flight SEO pass); Cloudflare WAF rate-limit rule for a hard edge cap.
