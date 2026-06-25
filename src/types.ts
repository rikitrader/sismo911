export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  CACHE: KVNamespace;
  USGS_MINLAT: string;
  USGS_MAXLAT: string;
  USGS_MINLON: string;
  USGS_MAXLON: string;
  USGS_WINDOW_DAYS: string;
  // Cloudflare Access (defense-in-depth). Enforcement is active only when both set.
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
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
