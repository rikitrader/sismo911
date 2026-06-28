import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { isSafePublicUrl, safeFetch } from '../src/lib/sanitize';

// REGRESSION GUARDS for the 2026-06-27 security assessment (PR #312).
// Each critical fix has a guard here so a future edit that silently removes it
// fails CI. C1/C2/C3 are source-marker guards (the fix is a specific code shape);
// H1 (safeFetch SSRF) is a behavioral test against a mocked fetch.

describe('C1 — telemedicine doctor approval gate', () => {
  const tele = readFileSync('src/routes/telemedicina.ts', 'utf8');
  const sched = readFileSync('src/routes/telemedicina-scheduling.ts', 'utf8');

  it('self-registration inserts moderation=pending (NOT auto-approved)', () => {
    expect(tele).toContain("0, 'pending', 'activo'");
    expect(tele).not.toContain("0, 'approved', 'activo'");
  });
  it('verifyDoctor requires verified=1 in BOTH telemed routers', () => {
    expect(tele).toContain("moderation='approved' AND verified = 1");
    expect(sched).toContain("moderation='approved' AND verified = 1");
  });
  it('exposes operator approve/reject + pending-queue endpoints', () => {
    expect(tele).toContain("telemedicina.post('/doctors/:id/approve'");
    expect(tele).toContain("telemedicina.post('/doctors/:id/reject'");
    expect(tele).toContain("telemedicina.get('/doctors/pending'");
  });
  it('approve sets verified=1; pending queue lists only pending', () => {
    expect(tele).toContain("moderation='approved', verified=1");
    expect(tele).toContain("WHERE moderation='pending'");
  });
});

describe('C2 — /familia stored-XSS defense (photo_url)', () => {
  it('familia.html escapes photo_url at every img render site', () => {
    const html = readFileSync('public/familia.html', 'utf8');
    // all photo_url interpolations go through esc(); none raw
    expect((html.match(/esc\(p\.photo_url\)/g) || []).length).toBe(3);
    expect(html).not.toMatch(/src="\$\{p\.photo_url\}"/);
  });
  it('familia.ts only emits an external foto URL when it passes isSafePublicUrl', () => {
    const ts = readFileSync('src/routes/familia.ts', 'utf8');
    expect(ts).toContain('isSafePublicUrl(p.foto) ? p.foto : null');
  });
  it('familia-cron validates the foto scheme at ingest', () => {
    const cron = readFileSync('src/ingest/familia-cron.ts', 'utf8');
    expect(cron).toContain('isSafePublicUrl(fotoRaw)');
  });
});

describe('C3 — FleetOps reads require an operator session', () => {
  const idx = readFileSync('src/index.ts', 'utf8');
  it('the auth gate covers ALL /api/flota methods (not just writes)', () => {
    expect(idx).toContain("const isFlotaApi = path.startsWith('/api/flota')");
    // the bypass (return next()) must exclude flota requests (additional gate
    // terms like !isFlotaAdminApi may follow, but !isFlotaApi must be in the chain)
    expect(idx).toMatch(/&& !isFlotaApi(?: && ![A-Za-z]+)*\) return next\(\)/);
  });
  it('the live-GPS admin surface is also fully gated', () => {
    expect(idx).toContain("const isFlotaAdminApi = path.startsWith('/api/admin/flota')");
    expect(idx).toMatch(/&& !isFlotaAdminApi\) return next\(\)/);
  });
});

describe('H1 — safeFetch is SSRF-safe (no redirect bypass)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const fakeRes = (status: number, location?: string) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h: string) => (h.toLowerCase() === 'location' ? location ?? null : null) },
  });

  it('isSafePublicUrl rejects internal / link-local / loopback / non-http', () => {
    expect(isSafePublicUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isSafePublicUrl('http://127.0.0.1/')).toBe(false);
    expect(isSafePublicUrl('http://10.0.0.5/')).toBe(false);
    expect(isSafePublicUrl('http://localhost/')).toBe(false);
    expect(isSafePublicUrl('file:///etc/passwd')).toBe(false);
    expect(isSafePublicUrl('https://example.com/photo.jpg')).toBe(true);
  });

  it('never even fetches an initially-unsafe URL', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await safeFetch('http://169.254.169.254/');
    expect(res).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses redirect:manual and does NOT follow a 302 to an internal host', async () => {
    const fetchMock = vi.fn(async () => fakeRes(302, 'http://169.254.169.254/'));
    vi.stubGlobal('fetch', fetchMock);
    const res = await safeFetch('https://safe.example.com/img');
    expect(res).toBeNull(); // redirect target is unsafe → refused
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('returns the response for a safe URL with no redirect', async () => {
    const fetchMock = vi.fn(async () => fakeRes(200));
    vi.stubGlobal('fetch', fetchMock);
    const res = await safeFetch('https://safe.example.com/img');
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
  });
});
