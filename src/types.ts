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
  RAV_INGEST_TOKEN?: string;
  RAV_VISION_MODEL?: string;
  // Social/web disaster monitor (all optional — features gate on their presence).
  PUBLIC_BASE_URL?: string;
  TELEGRAM_CHANNELS?: string;      // comma-separated public channel handles
  APIFY_TOKEN?: string;
  APIFY_TIKTOK_ACTOR?: string;
  APIFY_IG_ACTOR?: string;
  MONITOR_WEBHOOK_SECRET?: string; // shared secret for the Apify webhook
  MONITOR_SHEET_ID?: string;       // Google Sheet to mirror into
  FUNDING_SHEET_ID?: string;       // Business-plan sheet for the live /api/funding feed
  GOOGLE_REFRESH_TOKEN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
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
