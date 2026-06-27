import { describe, expect, it } from 'vitest';
import { adapterStatus, adapters } from '../src/adapters/social';

describe('social adapter readiness', () => {
  it('does not report credential-only adapters as live connectors', async () => {
    const env = { X_BEARER_TOKEN: 'x-token', META_GRAPH_TOKEN: 'meta-token' };
    const status = adapterStatus(env);

    expect(status.find((s) => s.platform === 'x')).toMatchObject({
      configured: true,
      live: false,
      status: 'connector_not_enabled',
    });
    expect(status.find((s) => s.platform === 'tiktok')).toMatchObject({
      configured: false,
      live: false,
      status: 'connector_not_enabled',
    });

    await expect(adapters.x.search({ terms: ['sismo'] }, env)).resolves.toEqual([]);
  });
});
