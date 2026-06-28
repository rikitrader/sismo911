import { describe, it, expect } from 'vitest';
import { scanFile, sniffType } from '../src/security/file-scan';

// Core upload-security checker — previously untested. These exercise the accept
// path + every rejection reason, so a regression in the magic-byte / MIME /
// executable / polyglot logic fails CI.

const pad = (n: number) => Array(n).fill(0);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, ...pad(40), 0xff, 0xd9]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...pad(40)]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...pad(20)]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
const SVG_JS = new TextEncoder().encode('<svg onload="alert(1)"></svg>');
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, ...pad(20)]); // "MZ" PE header
const EMPTY = new Uint8Array([]);

describe('sniffType', () => {
  it('detects by magic bytes', () => {
    expect(sniffType(JPEG)).toBe('jpeg');
    expect(sniffType(PNG)).toBe('png');
    expect(sniffType(GIF)).toBe('gif');
    expect(sniffType(SVG)).toBe('svg');
    expect(sniffType(EXE)).toBe('unknown');
  });
});

describe('scanFile — accepts real images', () => {
  it('a JPEG passes and is hashed + given a safe key', async () => {
    const r = await scanFile(JPEG, { declaredMime: 'image/jpeg', filename: 'x.jpg' });
    expect(r.ok).toBe(true);
    expect(r.detectedType).toBe('jpeg');
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.safeKey).toMatch(/\.jpg$/);
  });
  it('a PNG passes', async () => {
    const r = await scanFile(PNG, { declaredMime: 'image/png' });
    expect(r.ok).toBe(true);
    expect(r.detectedType).toBe('png');
  });
});

describe('scanFile — rejects everything dangerous/wrong', () => {
  it('empty → empty_file', async () => expect((await scanFile(EMPTY)).reason).toBe('empty_file'));
  it('over size → too_large', async () => expect((await scanFile(JPEG, { maxSize: 4 })).reason).toBe('too_large'));
  it('executable (MZ) → executable_content', async () => expect((await scanFile(EXE)).reason).toBe('executable_content'));
  it('disallowed type (GIF) → type_not_allowed', async () => expect((await scanFile(GIF)).reason).toBe('type_not_allowed'));
  it('SVG with allowSvg=false → svg_disabled', async () => expect((await scanFile(SVG)).reason).toBe('svg_disabled'));
  it('SVG with active script even when allowed → executable_content', async () =>
    expect((await scanFile(SVG_JS, { allowSvg: true })).reason).toBe('executable_content'));
  it('MIME mismatch (JPEG bytes, declared image/png) → mime_mismatch', async () =>
    expect((await scanFile(JPEG, { declaredMime: 'image/png' })).reason).toBe('mime_mismatch'));
});
