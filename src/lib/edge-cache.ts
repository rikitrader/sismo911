import type { Context } from 'hono';

// Per-colo read-through cache built on the Cloudflare Cache API (caches.default)
// — free and unlimited, unlike Workers KV whose binding writes were silently
// dropping on this plan (the usgs:latest hot cache never persisted). The trade
// vs KV: the cache is per-data-center, not global, so the FIRST request to each
// colo in a TTL window recomputes from D1 and the rest are served from cache.
// For hot public GETs that's exactly right — it collapses per-request D1 load
// without depending on KV.
//
// Caches the JSON `build()` payload keyed by the full request URL (query
// included). Adds `X-Edge-Cache: hit|miss`. Degrades gracefully where the Cache
// API or executionCtx is absent (e.g. unit tests) — it just builds every time.
export async function edgeCached(
  c: Context,
  ttlSec: number,
  build: () => Promise<unknown>
): Promise<Response> {
  const cache: Cache | undefined = (globalThis as any).caches?.default;
  const key = cache ? new Request(new URL(c.req.url).toString(), { method: 'GET' }) : null;

  if (cache && key) {
    const hit = await cache.match(key).catch(() => null);
    if (hit) {
      const r = new Response(hit.body, hit);
      r.headers.set('X-Edge-Cache', 'hit');
      return r;
    }
  }

  const res = c.json(await build() as any);
  if (cache && key) {
    res.headers.set('Cache-Control', `public, max-age=${ttlSec}`);
    res.headers.set('X-Edge-Cache', 'miss');
    const stored = res.clone();
    try {
      c.executionCtx.waitUntil(cache.put(key, stored)); // non-blocking in prod
    } catch {
      // No executionCtx (tests / some contexts) — best-effort synchronous put.
      try { await cache.put(key, stored); } catch { /* ignore */ }
    }
  }
  return res;
}
