import { describe, it, expect } from 'vitest';
import { classifyIngestHealth, type IngestLogRow } from '../src/lib/db';
import { isRecaptchaBlock, RECAPTCHA_DEGRADED, chooseFamiliaEndpoint } from '../src/ingest/familia-cron';

// Bug 2 / Phase 1: a feed that started failing (e.g. theempire put up a reCAPTCHA
// wall) must surface as DOWN in /api/status, not fail silently every hour. These
// lock the two pure helpers behind that behavior.

const NOW = Date.UTC(2026, 5, 28, 20, 0, 0);
const HOUR = 3600_000;
const row = (over: Partial<IngestLogRow>): IngestLogRow => ({
  source: 'familia', last_run_ms: NOW, last_ok_ms: NOW, last_count: 0, last_error: null, ...over,
});

describe('classifyIngestHealth', () => {
  it('healthy when there is no error', () => {
    expect(classifyIngestHealth(row({ last_error: null }), NOW)).toBe('ok');
  });

  it('DOWN immediately on a structured degraded:* error (no waiting for staleness)', () => {
    expect(classifyIngestHealth(row({ last_error: RECAPTCHA_DEGRADED, last_ok_ms: NOW - HOUR }), NOW)).toBe('down');
    expect(classifyIngestHealth(row({ last_error: 'degraded:whatever' }), NOW)).toBe('down');
  });

  it('STALE when erroring and no success for >3h', () => {
    expect(classifyIngestHealth(row({ last_error: 'HTTP 500', last_ok_ms: NOW - 4 * HOUR }), NOW)).toBe('stale');
  });

  it('still OK on a transient error if a success was recent (<3h)', () => {
    expect(classifyIngestHealth(row({ last_error: 'HTTP 429', last_ok_ms: NOW - HOUR }), NOW)).toBe('ok');
  });

  it('STALE when erroring and there has never been a success', () => {
    expect(classifyIngestHealth(row({ last_error: 'HTTP 403', last_ok_ms: null }), NOW)).toBe('stale');
  });
});

describe('isRecaptchaBlock', () => {
  it('matches the real theempire 403 body', () => {
    expect(isRecaptchaBlock(403, '{"error":"ForbiddenError","message":"Verificación reCAPTCHA requerida"}')).toBe(true);
  });
  it('matches a 401 captcha challenge too', () => {
    expect(isRecaptchaBlock(401, 'please complete the captcha')).toBe(true);
  });
  it('ignores non-4xx-auth statuses even if the body mentions captcha', () => {
    expect(isRecaptchaBlock(200, 'recaptcha')).toBe(false);
    expect(isRecaptchaBlock(500, 'recaptcha site key')).toBe(false);
  });
  it('does not misfire on an unrelated 403', () => {
    expect(isRecaptchaBlock(403, '{"error":"rate_limited"}')).toBe(false);
  });
});

describe('chooseFamiliaEndpoint (Phase 2 resolver routing)', () => {
  const BASE = 'https://desaparecidos-terremoto-api.theempire.tech/api/personas';
  it('uses the direct base when no resolver is configured', () => {
    expect(chooseFamiliaEndpoint(BASE)).toEqual({ endpoint: BASE, viaResolver: false });
    expect(chooseFamiliaEndpoint(BASE, '')).toEqual({ endpoint: BASE, viaResolver: false });
    expect(chooseFamiliaEndpoint(BASE, '   ')).toEqual({ endpoint: BASE, viaResolver: false });
  });
  it('routes through the resolver when FAMILIA_RESOLVER_URL is set', () => {
    const R = 'https://abc.trycloudflare.com/familia';
    expect(chooseFamiliaEndpoint(BASE, R)).toEqual({ endpoint: R, viaResolver: true });
  });
});
