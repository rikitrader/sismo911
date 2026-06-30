import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { caseSubscribePages } from '../src/routes/case-subscribe-pages';

// Minimal env: the unsub/verify pages call the DB; for unknown tokens every read
// returns null, so the pages render their "no match / cancelled" branches.
const nullEnv = { DB: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({}), all: async () => ({ results: [] }) }) }) } } as any;

describe('public subscribe widget on casos.html', () => {
  const html = readFileSync(new URL('../public/casos.html', import.meta.url), 'utf8');
  it('renders the subscribe card with an email input + subscribe action', () => {
    expect(html).toContain('id="subscribeCard"');
    expect(html).toContain('id="subEmail"');
    expect(html).toContain('data-act="subscribe"');
  });
  it('posts to the public subscribe API with the case id', () => {
    expect(html).toContain("'/api/persons/'+encodeURIComponent(caseId)+'/subscribe'");
    expect(html).toContain('function subscribeCase');
    expect(html).toContain('ACTIONS={'); // wired through the CSP-safe dispatcher
  });
});

describe('public /s landing pages render HTML', () => {
  it('GET /s/verify/<bad> → 404 with a clear "no válido" page', async () => {
    const res = await caseSubscribePages.request('/verify/bogus', {}, nullEnv);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain('Enlace no válido');
    expect(res.headers.get('content-type') || '').toContain('text/html');
  });
  it('GET /s/unsub/<token> → 200 with an "unsubscribed" page', async () => {
    const res = await caseSubscribePages.request('/unsub/anytoken', {}, nullEnv);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Suscripción cancelada');
  });
});
