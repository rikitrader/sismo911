export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  CACHE: KVNamespace;
  PHOTOS: KVNamespace;
  PERSON_PHOTOS: R2Bucket;
  // FLOTA live-tracking Durable Object (real-time unit positions on the command map).
  FLOTA_TRACKING: DurableObjectNamespace;
  // Live-GPS hub Durable Object (phone units stream GPS; admin consoles subscribe).
  FLEET_LIVE: DurableObjectNamespace;
  DESAP: D1Database;
  DESAP_FOTOS: R2Bucket;
  USGS_MINLAT: string;
  USGS_MAXLAT: string;
  USGS_MINLON: string;
  USGS_MAXLON: string;
  USGS_WINDOW_DAYS: string;
  // FUNVISIS national seismic feed (Venezuela). Optional override; defaults to
  // http://www.funvisis.gob.ve/maravilla.json in src/lib/funvisis.ts.
  FUNVISIS_URL?: string;
  // Cloudflare Access (defense-in-depth). Enforcement is active only when both set.
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ALLOWED_ORIGINS?: string;
  ADMIN_BOOTSTRAP_TOKEN?: string;
  // Shared secret the local every-3h blog cron uses to POST new posts to
  // /api/blog/ingest (and read GET /api/blog/sources). Set via
  // `wrangler secret put BLOG_INGEST_TOKEN`.
  BLOG_INGEST_TOKEN?: string;
  // YouTube Data API v3 key (free) for the blog source fetcher's video search.
  // Optional: GDELT + VE-news still work without it. `wrangler secret put YOUTUBE_API_KEY`.
  YOUTUBE_API_KEY?: string;
  // Workers AI text model the always-on blog cron writes articles with.
  // Optional override; defaults to llama-3.3-70b-instruct-fp8-fast.
  BLOG_AI_MODEL?: string;
  // Workers AI model the casualty poller extracts live tolls with.
  // Optional override; defaults to llama-3.3-70b-instruct-fp8-fast.
  CASUALTY_AI_MODEL?: string;
  // Web Push
  VAPID_PUBLIC_KEY?: string;
  // Cloudflare Workers AI (situation reports). Optional binding.
  AI?: Ai;
  // Google Maps Platform key for satellite imagery (Map Tiles + Static API). Optional.
  GOOGLE_MAPS_API_KEY?: string;
  // External missing-persons (Familia) source for hourly re-ingest. Optional.
  FAMILIA_SOURCE_URL?: string;
  // redayudavenezuela.com (RAV) — public Supabase REST source (2nd missing-persons
  // aggregator + verified news + casualty stats). URL/KEY have in-code fallbacks
  // (the anon key is public); RAV_INGEST_TOKEN gates POST /api/rav/run (falls back
  // to BLOG_INGEST_TOKEN). RAV_VISION_MODEL overrides the photo-analysis model.
  RAV_SUPABASE_URL?: string;
  RAV_SUPABASE_KEY?: string;
  TV_SUPABASE_URL?: string;
  TV_SUPABASE_KEY?: string;
  RAV_INGEST_TOKEN?: string;
  RAV_VISION_MODEL?: string;
  // Identity-verification resolver (external Chrome service for CNE padrón lookup).
  // The Worker can't drive a browser; when set, cédula verification POSTs here.
  CNE_RESOLVER_URL?: string;
  CNE_RESOLVER_TOKEN?: string; // bearer token for the resolver service
  // Familia registry resolver (external real-Chrome service for the theempire feed,
  // which now sits behind a reCAPTCHA wall a server-side fetch can't pass). When set,
  // the hourly familia ingest pulls pages THROUGH this service instead of hitting
  // theempire directly; unset ⇒ direct fetch (which currently degrades to reCAPTCHA).
  FAMILIA_RESOLVER_URL?: string;
  FAMILIA_RESOLVER_TOKEN?: string; // bearer token for the resolver service
  // Social/web disaster monitor (all optional — features gate on their presence).
  PUBLIC_BASE_URL?: string;
  TELEGRAM_CHANNELS?: string;      // comma-separated public channel handles
  APIFY_TOKEN?: string;
  APIFY_TIKTOK_ACTOR?: string;
  APIFY_IG_ACTOR?: string;
  MONITOR_WEBHOOK_SECRET?: string; // shared secret for the Apify webhook
  MONITOR_SHEET_ID?: string;       // Google Sheet to mirror into
  CASES_SHEET_ID?: string;         // "Casos CRM" sheet that is the source of truth (Sheet → D1 sync)
  SHEET_SYNC_ENABLED?: string;     // '1' arms the hourly cron to APPLY sheet→D1 (fail-closed; endpoints work regardless)
  FUNDING_SHEET_ID?: string;       // Business-plan sheet for the live /api/funding feed
  GOOGLE_REFRESH_TOKEN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // Social login (OAuth) — DEDICATED client, separate from the Drive integration
  // above. Public client id lives in wrangler.toml [vars]; the secret is a Worker
  // Secret (`wrangler secret put OAUTH_GOOGLE_CLIENT_SECRET`). Social buttons only
  // appear when BOTH are set, so the feature is inert until configured.
  OAUTH_GOOGLE_CLIENT_ID?: string;
  OAUTH_GOOGLE_CLIENT_SECRET?: string;
  // Cloudflare Email Sending binding (transactional email). Optional until the
  // sismo911.com domain is onboarded to Email Sending.
  EMAIL?: { send(message: {
    to: string;
    from: { email: string; name?: string };
    subject: string;
    html?: string;
    text?: string;
    reply_to?: { email: string; name?: string };
  }): Promise<unknown> };
  EMAIL_FROM?: string;
  // Support inbox From/Reply-To address. Inbound replies to this address are
  // routed to the Worker's email() handler and threaded back to the ticket by
  // its [#REF]. Defaults to soporte@sismo911.com.
  SUPPORT_EMAIL?: string;
  // Gates the transactional-email preview/test route (/api/notify) — set as a
  // Worker secret (wrangler secret put NOTIFY_TOKEN). Absent ⇒ route disabled.
  NOTIFY_TOKEN?: string;
  // Ops distribution address for operational alerts (e.g. SYS-02 cron-failure).
  // Plain address (not a secret) — configured in wrangler.toml [vars].
  OPS_ALERT_EMAIL?: string;
  // Twilio text messaging (SMS + WhatsApp) for appointment confirmations/reminders.
  // Optional: when absent, text sends no-op gracefully (see src/lib/sms.ts).
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_SMS_FROM?: string;       // E.164, e.g. +15551234567
  TWILIO_WHATSAPP_FROM?: string;  // E.164 of the approved WhatsApp sender
  // Invitation-only business-plan deck (/plan). Access fails closed if the
  // secret is missing; invite codes are sourced from env/KV only.
  PLAN_INVITE_CODES?: string; // comma-separated valid invite codes
  PLAN_SECRET?: string;       // HMAC signing secret for the access cookie
  // --- Crossmint donations (card → USDC on Base) ---
  // All optional: campaigns + the public ledger work without them; only the
  // "pay now" step is gated on these being present.
  CROSSMINT_SERVER_KEY?: string;     // sk_<env>_…   (server-side, secret)
  CROSSMINT_CLIENT_KEY?: string;     // ck_<env>_…   (browser embed, public-safe)
  CROSSMINT_COLLECTION_ID?: string;  // donation Collection id (from setup script)
  CROSSMINT_WEBHOOK_SECRET?: string; // whsec_…      (Svix HMAC signing secret)
  CROSSMINT_ENV?: string;            // 'production' (default) | 'staging'
  CROSSMINT_CHAIN?: string;          // 'base' (default)

  // --- x402 payment receiving (https://github.com/xpaysh/awesome-x402) -------
  // Each user's Crossmint wallet (above) doubles as an x402 `payTo` receiver.
  // All optional: the schema + ledger work without them, but the live
  // verify/settle step is gated on a reachable facilitator.
  X402_FACILITATOR_URL?: string;     // facilitator base URL (verify+settle). Public testnet: https://x402.org/facilitator
  X402_NETWORK?: string;             // CAIP-2 override, e.g. 'eip155:8453' (Base). Default derives from CROSSMINT_CHAIN.
  X402_ASSET?: string;               // token contract override; default = USDC for the network
  X402_FACILITATOR_API_KEY?: string; // optional bearer for facilitators that require auth (e.g. CDP mainnet)
  X402_PAYMENTS_ENABLED?: string;    // feature flag: 'true' + a facilitator → payments go LIVE (advertise + accept). Default off.

  // --- Stripe Checkout (receiving) + Connect (payouts) ----------------------
  // All optional + gated (isStripeLive = key present AND flag on), like x402.
  // Inert by design until a supported-country Stripe account + keys exist
  // (Stripe does not onboard Venezuela-based entities).
  STRIPE_SECRET_KEY?: string;        // sk_live_… / sk_test_…  (server-side secret)
  STRIPE_WEBHOOK_SECRET?: string;    // whsec_…  (endpoint signing secret for /api/stripe/webhook)
  STRIPE_PAYMENTS_ENABLED?: string;  // feature flag: 'true' + a secret key → Stripe goes LIVE. Default off. (in [vars])
  STRIPE_CONNECT_COUNTRY?: string;   // default country for new Express accounts (e.g. 'US'). (in [vars])

  // Hospital patient registry feed (.xlsx direct-download). The pull cron fetches +
  // parses + re-ingests it; configurable so the source can change without a redeploy. (in [vars])
  HOSPITAL_FEED_URL?: string;

  // --- DB Ingestion Gatekeeper (src/security/*) -----------------------------
  // All optional: the gate has safe built-in defaults and degrades gracefully.
  // Cloudflare Turnstile server secret (verify the public widget token). When
  // unset, Turnstile checks are SKIPPED (not failed) so existing routes keep
  // working; set it to enforce. `wrangler secret put TURNSTILE_SECRET_KEY`.
  TURNSTILE_SECRET_KEY?: string;
  // Max upload size in bytes (default 8 MiB). e.g. "8388608".
  MAX_FILE_SIZE?: string;
  // Spam score at/above which a submission is rejected (default 100). Lower =
  // stricter. e.g. "100".
  SPAM_THRESHOLD?: string;
  // Comma-separated extra email domains to block outright (joins the built-in
  // disposable list), e.g. "spam.com,bad.net".
  EMAIL_BLOCKLIST?: string;
  // Comma-separated ISO country codes to BLOCK (cf.country). Empty = allow all.
  COUNTRY_BLOCKLIST?: string;
  // Allow SVG uploads (default off — SVG can carry script). "1"/"true" to enable.
  ALLOW_SVG_UPLOADS?: string;
  // Optional Durable Object namespace backing the abuse counter (rate-limit.ts).
  // Falls back to the D1 burst limiter when unbound, so it is NOT required.
  ABUSE_COUNTER?: DurableObjectNamespace;

  // --- Telegram case-status bot (src/telegram/*) ----------------------------
  // The bot is INERT until TELEGRAM_BOT_TOKEN + TELEGRAM_WEBHOOK_SECRET are set
  // (both Worker Secrets). The allow-lists are non-secret [vars]; an empty
  // allow-list rejects every chat (fail closed), never opens access.
  TELEGRAM_BOT_TOKEN?: string;        // BotFather token (Worker Secret)
  TELEGRAM_WEBHOOK_SECRET?: string;   // secret echoed in X-Telegram-Bot-Api-Secret-Token (Worker Secret)
  ALLOWED_TELEGRAM_GROUP_IDS?: string; // comma-separated approved chat ids (negative) — [vars]
  ADMIN_TELEGRAM_USER_IDS?: string;    // comma-separated admin user ids — [vars]
  ALLOWED_TELEGRAM_USER_IDS?: string;  // optional extra authorized (non-admin) user ids — [vars]
  TELEGRAM_AI_MODEL?: string;          // optional Workers-AI model override for intent parsing — [vars]

  // --- Live-seismic Telegram bot (src/telegram-sismos/*) --------------------
  // A SEPARATE, PUBLIC bot: latest quakes / recent list / threat status +
  // opt-in auto-alerts on significant new quakes. No allow-list (public,
  // non-PII data); gated only by its webhook secret. Both are Worker Secrets.
  // Inert until both are set.
  SISMOS_BOT_TOKEN?: string;      // BotFather token for the live-seismic bot
  SISMOS_WEBHOOK_SECRET?: string; // echoed in X-Telegram-Bot-Api-Secret-Token
}

export interface SeismicEvent {
  id: string;
  source: string;
  mag: number | null;
  place: string | null;
  time_ms: number;
  updated_ms: number | null;
  lat: number;
  lon: number;
  depth_km: number | null;
  mmi: number | null;
  alert: string | null;
  tsunami: number;
  felt: number | null;
  url: string | null;
}
