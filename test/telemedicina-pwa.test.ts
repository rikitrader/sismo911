import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

// Guards the dedicated, installable "Telemedicina" PWA wiring. If any of these
// break, the page silently falls back to the site-wide manifest (or fails to
// install on iOS), so assert the whole chain explicitly.

const manifest = JSON.parse(readFileSync('public/telemedicina.webmanifest', 'utf8'));
const PAGES = ['public/telemedicina.html', 'public/telemedicina-panel.html'];

describe('Telemedicina manifest', () => {
  it('is self-contained: scope + start_url under /telemedicina, standalone', () => {
    expect(manifest.scope).toBe('/telemedicina');
    expect(manifest.start_url).toBe('/telemedicina');
    expect(manifest.display).toBe('standalone');
    // start_url must be within scope, and the panel must be too (string-prefix scope match).
    expect('/telemedicina'.startsWith(manifest.scope)).toBe(true);
    expect('/telemedicina-panel'.startsWith(manifest.scope)).toBe(true);
  });

  it('ships both a maskable and an any-purpose icon, and every icon file exists', () => {
    const purposes = manifest.icons.map((i: { purpose: string }) => i.purpose);
    expect(purposes).toContain('maskable');
    expect(purposes).toContain('any');
    for (const icon of manifest.icons) {
      expect(existsSync(`public${icon.src}`), `missing icon ${icon.src}`).toBe(true);
    }
  });
});

describe('Telemedicina pages are wired as the installable app', () => {
  for (const page of PAGES) {
    const html = readFileSync(page, 'utf8');
    it(`${page} links the dedicated manifest + apple-touch icon + PWA script`, () => {
      expect(html).toContain('rel="manifest" href="/telemedicina.webmanifest"');
      expect(html).toContain('rel="apple-touch-icon" href="/icons/telemedicina-180.png"');
      expect(html).toContain('apple-mobile-web-app-capable');
      expect(html).toContain('/telemedicina-pwa.js');
    });
  }
});

describe('Service worker precaches the Telemedicina app shell', () => {
  const sw = readFileSync('public/sw.js', 'utf8');
  for (const asset of ['/telemedicina', '/telemedicina-panel', '/telemedicina.webmanifest', '/telemedicina-pwa.js']) {
    it(`precaches ${asset}`, () => {
      expect(sw).toContain(`'${asset}'`);
    });
  }
});
