export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  CACHE: KVNamespace;
  PHOTOS: KVNamespace;
  PERSON_PHOTOS: R2Bucket;
  DESAP: D1Database;
  DESAP_FOTOS: R2Bucket;
  USGS_MINLAT: string;
  USGS_MAXLAT: string;
  USGS_MINLON: string;
  USGS_MAXLON: string;
  USGS_WINDOW_DAYS: string;
  // Cloudflare Access (defense-in-depth). Enforcement is active only when both set.
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ALLOWED_ORIGINS?: string;
  ADMIN_BOOTSTRAP_TOKEN?: string;
  // Web Push
  VAPID_PUBLIC_KEY?: string;
  // Cloudflare Workers AI (situation reports). Optional binding.
  AI?: Ai;
  // Google Maps Platform key for satellite imagery (Map Tiles + Static API). Optional.
  GOOGLE_MAPS_API_KEY?: string;
  // Social/web disaster monitor (all optional — features gate on their presence).
  PUBLIC_BASE_URL?: string;
  TELEGRAM_CHANNELS?: string;      // comma-separated public channel handles
  APIFY_TOKEN?: string;
  APIFY_TIKTOK_ACTOR?: string;
  APIFY_IG_ACTOR?: string;
  MONITOR_WEBHOOK_SECRET?: string; // shared secret for the Apify webhook
  MONITOR_SHEET_ID?: string;       // Google Sheet to mirror into
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
