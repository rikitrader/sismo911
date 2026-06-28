import { describe, it, expect } from 'vitest';
import { makeDb, makeEnv } from './helpers/d1';
import { app } from '../src/index';

describe('security.txt (RFC 9116)', () => {
  const env = makeEnv(makeDb());

  it('serves /.well-known/security.txt as plain text with required fields', async () => {
    const res = await app.request('/.well-known/security.txt', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('Contact: mailto:');
    expect(body).toMatch(/Expires: \d{4}-\d{2}-\d{2}T/);
    expect(body).toContain('Canonical: https://sismo911.com/.well-known/security.txt');
  });

  it('Expires is in the future', async () => {
    const res = await app.request('/.well-known/security.txt', {}, env);
    const expires = (await res.text()).match(/Expires: (.+)/)?.[1]?.trim();
    expect(new Date(expires!).getTime()).toBeGreaterThan(Date.now());
  });

  it('redirects /security.txt to the canonical location', async () => {
    const res = await app.request('/security.txt', {}, env);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/.well-known/security.txt');
  });
});
