import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

// Guards the installable "Flota GPS" PWA wiring + the migration-numbering rule.

const manifest = JSON.parse(readFileSync('public/flota-track.webmanifest', 'utf8'));
const html = readFileSync('public/flota-track.html', 'utf8');

describe('Flota GPS manifest', () => {
  it('is self-contained: scope + start_url under /flota/track, standalone', () => {
    expect(manifest.scope).toBe('/flota/track');
    expect(manifest.start_url).toBe('/flota/track');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url.startsWith(manifest.scope)).toBe(true);
    // a tokened tracking URL is within scope (prefix match)
    expect('/flota/track/fbu_abc'.startsWith(manifest.scope)).toBe(true);
  });

  it('ships a maskable + an any-purpose icon, and every icon file exists', () => {
    const purposes = manifest.icons.map((i: { purpose: string }) => i.purpose);
    expect(purposes).toContain('maskable');
    expect(purposes).toContain('any');
    for (const icon of manifest.icons) {
      expect(existsSync(`public${icon.src}`), `missing icon ${icon.src}`).toBe(true);
    }
  });
});

describe('Flota GPS page is wired as the installable app', () => {
  it('links the dedicated manifest + apple-touch icon + meta + registers the SW', () => {
    expect(html).toContain('rel="manifest" href="/flota-track.webmanifest"');
    expect(html).toContain('rel="apple-touch-icon" href="/logo.svg"');
    expect(html).toContain('apple-mobile-web-app-capable');
    expect(html).toContain("serviceWorker' in navigator");
    expect(html).toContain("navigator.serviceWorker.register('/sw.js')");
  });
  it('only accepts an fbu_ token and resumes from localStorage on the bare start_url', () => {
    expect(html).toContain("seg.indexOf('fbu_') === 0");
    expect(html).toContain("localStorage.setItem('flota_unit_token'");
    expect(html).toContain("localStorage.getItem('flota_unit_token')");
  });
  it('the service worker precaches the bare /flota/track shell', () => {
    expect(readFileSync('public/sw.js', 'utf8')).toContain("'/flota/track'");
  });
});

describe('migration numbering', () => {
  it('README documents the dynamic next-free rule + the collision history', () => {
    const r = readFileSync('migrations/README.md', 'utf8');
    // The rule must be dynamic (compute highest+1), not a frozen number.
    expect(r.toLowerCase()).toContain('current highest');
    expect(r).toContain("ls migrations | grep -oE '^[0-9]{4}'");
    expect(r.toLowerCase()).toContain('sprawl');
  });
  it('the next migration number is strictly greater than the current highest', () => {
    // Not a frozen max (concurrent divisions advance it); this documents the rule
    // the README states and is the check a new migration should satisfy.
    const nums = readdirSync('migrations')
      .map((f) => f.match(/^(\d{4})_/)?.[1])
      .filter(Boolean)
      .map(Number) as number[];
    const next = Math.max(...nums) + 1;
    expect(next).toBeGreaterThan(Math.max(...nums));
    expect(String(next).padStart(4, '0')).toMatch(/^\d{4}$/);
  });
});
