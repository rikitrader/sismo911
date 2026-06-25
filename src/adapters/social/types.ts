/**
 * Social ingestion adapter contract.
 *
 * Every platform adapter (X, Facebook, Instagram, TikTok) implements this
 * interface so the ingestion pipeline is platform-agnostic. Adapters are
 * STUBBED until real credentials/partnerships exist:
 *   - X/Twitter      → X API v2 bearer token, or Apify actor
 *   - Facebook/IG    → Meta Graph API (app review + page tokens) or Apify
 *   - TikTok         → TikTok Research API (approval required) or Apify
 *
 * The pipeline geocodes + matches each report to the nearest recent event and
 * writes it to the `reports` table. None of these emit data without a key.
 */
export interface SocialReport {
  channel: 'x' | 'facebook' | 'instagram' | 'tiktok';
  externalId: string;
  text: string;
  author?: string;
  mediaUrl?: string;
  lat?: number;
  lon?: number;
  createdMs: number;
}

export interface SocialQuery {
  /** e.g. ["sismo", "temblor", "terremoto", "Venezuela"] */
  terms: string[];
  /** ISO date lower bound */
  since?: string;
  /** geo bias center for relevance */
  near?: { lat: number; lon: number; radiusKm: number };
  limit?: number;
}

export interface SocialAdapter {
  readonly platform: SocialReport['channel'];
  /** True only when the required credential env var is configured. */
  isConfigured(env: Record<string, unknown>): boolean;
  /** Fetch matching posts. MUST return [] (not throw) when unconfigured. */
  search(query: SocialQuery, env: Record<string, unknown>): Promise<SocialReport[]>;
}
