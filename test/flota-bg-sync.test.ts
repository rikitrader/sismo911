import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Guards the Background Sync wiring: the phone PWA persists the token + queue in
// IndexedDB and asks the SW to flush; the SW flushes to the backfill endpoint even
// when the page is closed. (The ingest itself is covered by flota-backfill.int.test.ts.)
const html = readFileSync('public/flota-track.html', 'utf8');
const sw = readFileSync('public/sw.js', 'utf8');

describe('phone PWA — Background Sync wiring', () => {
  it('upgrades the IndexedDB to v2 with a meta store and persists the token there', () => {
    expect(html).toContain("indexedDB.open(DB_NAME, 2)");
    expect(html).toContain("createObjectStore(META");
    expect(html).toContain("idbSetMeta('token', token)");
  });
  it('registers the flota-flush background sync when buffering offline', () => {
    expect(html).toContain("'SyncManager' in window");
    expect(html).toContain("reg.sync.register('flota-flush')");
    expect(html).toMatch(/\.then\(registerBgSync\)/); // chained off idbAdd
  });
});

describe('service worker — flota-flush sync handler', () => {
  it('handles the flota-flush sync tag', () => {
    expect(sw).toContain("addEventListener('sync'");
    expect(sw).toContain("e.tag === 'flota-flush'");
  });
  it('reads the token from IndexedDB and uploads to the backfill endpoint', () => {
    expect(sw).toContain("flotaMeta(db, 'token')");
    expect(sw).toContain("'/flota/track/backfill'");
    expect(sw).toContain("'Bearer ' + token");
  });
  it('throws on a failed upload so the browser retries (no data loss)', () => {
    expect(sw).toMatch(/if \(!r\.ok\) throw/);
  });
});
