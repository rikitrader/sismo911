import { describe, it, expect } from 'vitest';
import { sanitizeHtml, isSafePublicUrl } from '../src/lib/sanitize';
import { gateUpload, gateUrl, gateRichText, looksExecutable, safeAuditDetail, gateRecord, citizenRecordSchema } from '../scripts/ingestion-gatekeeper';

describe('sanitizeHtml (stored-XSS defense)', () => {
  it('strips <script> and event handlers, keeps allowlisted tags', () => {
    const out = sanitizeHtml('<p>hola</p><script>alert(1)</script><img src=x onerror=alert(1)>');
    expect(out).toContain('<p>hola</p>');
    expect(out.toLowerCase()).not.toContain('<script');
    expect(out.toLowerCase()).not.toContain('onerror');
    expect(out.toLowerCase()).not.toContain('<img');
  });
  it('neutralizes javascript: hrefs and keeps safe links', () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:');
    expect(sanitizeHtml('<a href="https://x.com">x</a>')).toContain('href="https://x.com"');
  });
  it('drops iframes/svg entirely', () => {
    const out = sanitizeHtml('<iframe src="//evil"></iframe><svg/onload=alert(1)><p>ok</p>');
    expect(out.toLowerCase()).not.toContain('<iframe');
    expect(out.toLowerCase()).not.toContain('<svg');
    expect(out).toContain('<p>ok</p>');
  });
});

describe('isSafePublicUrl (SSRF guard)', () => {
  it('allows public http(s)', () => {
    expect(isSafePublicUrl('https://example.com/a.jpg')).toBe(true);
    expect(gateUrl('http://cdn.site.org/x.png')).toBe(true);
  });
  it('rejects non-http schemes + internal hosts/IPs', () => {
    for (const u of ['file:///etc/passwd', 'gopher://x', 'http://localhost/x', 'http://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data', 'http://10.0.0.5/x', 'http://192.168.1.1/x', 'http://service.internal/x', 'not a url']) {
      expect(isSafePublicUrl(u), u).toBe(false);
    }
  });
});

describe('gateUpload (file ingestion)', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
  const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]);
  const ELF = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]);
  it('accepts a valid PNG and PDF', () => {
    expect(gateUpload(PNG, 'image/png').ok).toBe(true);
    expect(gateUpload(PDF, 'application/pdf').ok).toBe(true);
  });
  it('blocks executables even with a spoofed image MIME', () => {
    expect(looksExecutable(EXE)).toBe(true);
    expect(looksExecutable(ELF)).toBe(true);
    expect(gateUpload(EXE, 'image/png')).toEqual({ ok: false, reason: 'executable_blocked' });
  });
  it('rejects content/MIME mismatch, bad type, oversize, empty', () => {
    expect(gateUpload(PNG, 'image/jpeg')).toEqual({ ok: false, reason: 'content_mismatch' });
    expect(gateUpload(PNG, 'text/html')).toEqual({ ok: false, reason: 'bad_type' });
    expect(gateUpload(new Uint8Array(9_000_000), 'image/png')).toEqual({ ok: false, reason: 'too_large' });
    expect(gateUpload(new Uint8Array(0), 'image/png')).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('gateRichText + gateRecord + safeAuditDetail', () => {
  it('gateRichText sanitizes', () => { expect(gateRichText('<b>hi</b><script>x</script>').toLowerCase()).not.toContain('script'); });
  it('gateRecord enforces the schema', () => {
    expect(gateRecord(citizenRecordSchema, { name: 'Ana', email: 'a@b.com' }).ok).toBe(true);
    expect(gateRecord(citizenRecordSchema, { name: 'Ana' }).ok).toBe(false); // no contact
    expect(gateRecord(citizenRecordSchema, { name: '' }).ok).toBe(false);
  });
  it('safeAuditDetail redacts PII/secret keys', () => {
    const r = safeAuditDetail({ id: 'apt_1', cedula: 'V-1', email: 'a@b.com', token: 'sekret', type: 'video' });
    expect(r.id).toBe('apt_1'); expect(r.type).toBe('video');
    expect(r.cedula).toBe('[redacted]'); expect(r.email).toBe('[redacted]'); expect(r.token).toBe('[redacted]');
  });
});
