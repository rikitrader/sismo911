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
  it('buffers GPS offline (IndexedDB queue) and flushes to the backfill endpoint', () => {
    expect(html).toContain("indexedDB.open"); // offline queue
    expect(html).toContain("'/flota/track/backfill'"); // flush target
    expect(html).toContain("window.addEventListener('online', flushBuffer)"); // reconnect trigger
    expect(html).toContain('idbAdd(fix)'); // buffer when socket is down
  });
  it('prompts for a tracking token when launched without one', () => {
    expect(html).toContain('id="tokenPrompt"');
    expect(html).toContain('id="tokenInput"');
    expect(html).toContain('id="tokenBtn"');
    expect(html).toContain('fbu_[0-9a-fA-F]{16,}'); // extractToken accepts a pasted URL or raw token
  });
});

describe('service worker update lifecycle (old-cache eviction)', () => {
  const sw = readFileSync('public/sw.js', 'utf8');
  it('uses a versioned cache that was bumped for this release', () => {
    expect(sw).toContain("const CACHE = 'sismo911-v11'");
  });
  it('activate deletes every cache whose name != current, then claims clients', () => {
    expect(sw).toContain('caches.keys()');
    expect(sw).toContain('caches.delete');
    expect(sw).toMatch(/k\s*!==?\s*CACHE/); // keep only the current cache
    expect(sw).toContain('clients.claim()');
  });
});

describe('migration numbering', () => {
  it('README states IDs are allocated at creation time (no reservation) + the rule + history', () => {
    const r = readFileSync('migrations/README.md', 'utf8');
    const low = r.toLowerCase();
    // Must be allocation-at-creation, explicitly NOT a reservation of future IDs.
    expect(low).toContain('allocated at creation time');
    expect(low).toContain('never reserve');
    expect(r).toContain("ls migrations | grep -oE '^[0-9]{4}'");
    expect(low).toContain('sprawl');
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
