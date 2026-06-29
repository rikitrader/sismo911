import { describe, it, expect } from 'vitest';
import { stripImageMetadata } from '../src/security/image-metadata';

// ── byte helpers ──────────────────────────────────────────────────────────────
const u8 = (...n: number[]) => Uint8Array.from(n);
const ascii = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
function cat(...parts: Uint8Array[]): Uint8Array {
  let len = 0; for (const p of parts) len += p.length;
  const out = new Uint8Array(len); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const be16 = (n: number) => u8((n >> 8) & 0xff, n & 0xff);
const be32 = (n: number) => u8((n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
const le32 = (n: number) => u8(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
const contains = (hay: Uint8Array, needle: string) => {
  const n = ascii(needle);
  outer: for (let i = 0; i + n.length <= hay.length; i++) {
    for (let j = 0; j < n.length; j++) if (hay[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
};

// The GPS/secret payloads we plant in metadata — they MUST be gone after stripping.
const GPS = 'GPSLatitude:9.99999;GPSLongitude:-67.77777';
const SECRET = 'SECRET-CAMERA-SERIAL-Z123';

// ── JPEG fixture: SOI + APP1(EXIF w/ GPS) + DQT + SOF0 + SOS + scan + EOI ──────
function jpegWithExif(): Uint8Array {
  const exifPayload = cat(ascii('Exif'), u8(0, 0), ascii(GPS + ' ' + SECRET));
  const app1 = cat(u8(0xff, 0xe1), be16(exifPayload.length + 2), exifPayload);
  const dqt = cat(u8(0xff, 0xdb), be16(3), u8(0x00));
  const sof0 = cat(u8(0xff, 0xc0), be16(11), u8(0x08, 0x00, 0x10, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00));
  const sos = cat(u8(0xff, 0xda), be16(8), u8(0x01, 0x01, 0x00, 0x00, 0x3f, 0x00));
  const scan = u8(0xaa, 0xbb, 0xcc); // entropy-coded data (no 0xFF to keep it simple)
  const eoi = u8(0xff, 0xd9);
  return cat(u8(0xff, 0xd8), app1, dqt, sof0, sos, scan, eoi);
}

// ── PNG fixture: sig + IHDR + eXIf + tEXt + IDAT + IEND ────────────────────────
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  return cat(be32(data.length), ascii(type), data, u8(0, 0, 0, 0)); // CRC placeholder (parser skips it)
}
function pngWithMetadata(): Uint8Array {
  const sig = u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const ihdr = pngChunk('IHDR', u8(0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0)); // 1x1, 8-bit RGB
  const exif = pngChunk('eXIf', cat(ascii('II*\0'), ascii(GPS)));
  const text = pngChunk('tEXt', cat(ascii('Comment\0'), ascii(SECRET)));
  const idat = pngChunk('IDAT', u8(0x78, 0x9c, 0x62, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01));
  const iend = pngChunk('IEND', new Uint8Array(0));
  return cat(sig, ihdr, exif, text, idat, iend);
}

// ── WebP fixture (extended VP8X): RIFF/WEBP + VP8X + VP8 + EXIF + XMP ──────────
function webpChunk(fourcc: string, data: Uint8Array): Uint8Array {
  const pad = data.length & 1 ? u8(0) : new Uint8Array(0);
  return cat(ascii(fourcc), le32(data.length), data, pad);
}
function webpWithMetadata(): Uint8Array {
  const vp8x = webpChunk('VP8X', u8(0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0)); // flags 0x0C = EXIF|XMP set
  const vp8 = webpChunk('VP8 ', u8(0x10, 0x20, 0x30, 0x40));
  const exif = webpChunk('EXIF', cat(ascii('II*\0'), ascii(GPS)));
  const xmp = webpChunk('XMP ', ascii('<x:xmpmeta>' + SECRET + '</x:xmpmeta>'));
  const body = cat(vp8x, vp8, exif, xmp);
  return cat(ascii('RIFF'), le32(body.length + 4), ascii('WEBP'), body);
}

describe('stripImageMetadata — JPEG', () => {
  const orig = jpegWithExif();
  const out = stripImageMetadata(orig, 'jpeg');

  it('removes the EXIF/APP1 segment and its GPS + secret payload', () => {
    expect(contains(orig, GPS)).toBe(true);            // sanity: fixture HAS the GPS
    expect(contains(out, GPS)).toBe(false);            // …and it is gone
    expect(contains(out, SECRET)).toBe(false);
    expect(contains(out, 'Exif')).toBe(false);
    // No APP1 marker (0xFFE1) remains.
    let hasApp1 = false;
    for (let i = 0; i + 1 < out.length; i++) if (out[i] === 0xff && out[i + 1] === 0xe1) hasApp1 = true;
    expect(hasApp1).toBe(false);
    expect(out.length).toBeLessThan(orig.length);
  });

  it('preserves image validity (SOI/EOI + frame + scan intact)', () => {
    expect(out[0]).toBe(0xff); expect(out[1]).toBe(0xd8);              // SOI
    expect(out[out.length - 2]).toBe(0xff); expect(out[out.length - 1]).toBe(0xd9); // EOI
    // SOF0 (dimensions) preserved byte-for-byte.
    const sof = cat(u8(0xff, 0xc0), be16(11), u8(0x08, 0x00, 0x10, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00));
    expect(contains(out, String.fromCharCode(...sof))).toBe(true);
    // SOS marker + entropy scan + the scan bytes survived.
    let hasSos = false;
    for (let i = 0; i + 1 < out.length; i++) if (out[i] === 0xff && out[i + 1] === 0xda) hasSos = true;
    expect(hasSos).toBe(true);
    expect(contains(out, String.fromCharCode(0xaa, 0xbb, 0xcc))).toBe(true);
  });
});

describe('stripImageMetadata — PNG', () => {
  const orig = pngWithMetadata();
  const out = stripImageMetadata(orig, 'png');

  it('drops eXIf + tEXt chunks (GPS/secret gone), keeps IHDR/IDAT/IEND', () => {
    expect(contains(orig, GPS)).toBe(true);
    expect(contains(out, GPS)).toBe(false);
    expect(contains(out, SECRET)).toBe(false);
    expect(contains(out, 'eXIf')).toBe(false);
    expect(contains(out, 'tEXt')).toBe(false);
    expect(contains(out, 'IHDR')).toBe(true);
    expect(contains(out, 'IDAT')).toBe(true);
    expect(contains(out, 'IEND')).toBe(true);
    // PNG signature intact.
    expect([...out.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });
});

describe('stripImageMetadata — WebP', () => {
  const orig = webpWithMetadata();
  const out = stripImageMetadata(orig, 'webp');

  it('drops EXIF + XMP chunks and clears the VP8X metadata flags', () => {
    expect(contains(orig, GPS)).toBe(true);
    expect(contains(out, GPS)).toBe(false);
    expect(contains(out, SECRET)).toBe(false);
    // VP8X chunk kept but flags byte (offset: 12 header + 8 chunk-hdr) cleared.
    const vp8xFlagsIdx = 12 + 8;
    expect(out[vp8xFlagsIdx]).toBe(0x00);
    // No standalone EXIF/XMP chunk headers remain in the chunk area.
    expect(contains(out.subarray(12), 'EXIF')).toBe(false);
    expect(contains(out.subarray(12), 'XMP ')).toBe(false);
    // Still a valid RIFF/WEBP container with a correct size field.
    expect(contains(out.subarray(0, 4), 'RIFF')).toBe(true);
    expect(contains(out.subarray(8, 12), 'WEBP')).toBe(true);
    const sizeField = out[4] | (out[5] << 8) | (out[6] << 16) | (out[7] << 24);
    expect(sizeField).toBe(out.length - 8);
    expect(contains(out, 'VP8 ')).toBe(true); // image data preserved
  });
});

describe('stripImageMetadata — safety / no-op cases', () => {
  it('leaves a real metadata-free PNG byte-identical', () => {
    // A genuine 1×1 PNG (IHDR + IDAT + IEND only — no metadata chunks).
    const png = Uint8Array.from(Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ));
    const out = stripImageMetadata(png, 'png');
    expect([...out]).toEqual([...png]); // unchanged — a clean image is never corrupted
  });

  it('is idempotent (stripping twice == stripping once)', () => {
    const once = stripImageMetadata(jpegWithExif(), 'jpeg');
    const twice = stripImageMetadata(once, 'jpeg');
    expect([...twice]).toEqual([...once]);
  });

  it('returns the original bytes for unknown/garbage input', () => {
    const junk = u8(1, 2, 3, 4, 5);
    expect([...stripImageMetadata(junk, 'jpeg')]).toEqual([...junk]); // no SOI → untouched
    expect([...stripImageMetadata(junk, 'gif')]).toEqual([...junk]);  // unsupported type
  });
});
