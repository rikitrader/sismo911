import type { SocialAdapter, SocialReport, SocialQuery } from './types';

/**
 * Factory for a stub adapter. Each platform gets one of these until real
 * credentials are wired. `isConfigured` checks the documented env var; until
 * it is present, `search` returns [] so the pipeline degrades gracefully.
 *
 * To make a platform live: replace the `search` body with a real API/Apify
 * call and keep the same return shape. See types.ts for the credential map.
 */
function makeStub(platform: SocialReport['channel'], credEnvVar: string): SocialAdapter {
  return {
    platform,
    isConfigured: (env) => Boolean(env[credEnvVar]),
    async search(_query: SocialQuery, env): Promise<SocialReport[]> {
      if (!env[credEnvVar]) {
        console.warn(`[social:${platform}] not configured — set ${credEnvVar}. Returning [].`);
        return [];
      }
      // TODO: real call. e.g. X API v2 /tweets/search/recent, Apify actor run, etc.
      console.warn(`[social:${platform}] configured but live call not yet implemented.`);
      return [];
    },
  };
}

export const adapters: Record<SocialReport['channel'], SocialAdapter> = {
  x: makeStub('x', 'X_BEARER_TOKEN'),
  facebook: makeStub('facebook', 'META_GRAPH_TOKEN'),
  instagram: makeStub('instagram', 'META_GRAPH_TOKEN'),
  tiktok: makeStub('tiktok', 'TIKTOK_RESEARCH_TOKEN'),
};

export function adapterStatus(env: Record<string, unknown>) {
  return Object.values(adapters).map((a) => ({
    platform: a.platform,
    configured: a.isConfigured(env),
    live: false,
    status: 'connector_not_enabled',
  }));
}
