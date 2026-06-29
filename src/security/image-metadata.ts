// Server-side image metadata stripping for user uploads (avatars/profile photos).
//
// The Workers runtime has no native image re-encoder, so we CANNOT re-compress an
// image to drop metadata. Instead we strip LOSSLESSLY: parse the container and
// remove the metadata-bearing segments/chunks while keeping the pixel data (and
// the rendering-critical segments) byte-for-byte. This removes EXIF — and with it
// GPS coordinates, camera/serial, timestamps — plus XMP/IPTC/text, without
// touching the actual image, so the result stays a valid, decodable image.
//
// Covered formats are exactly the ones the upload gate (scanFile) admits:
//   • JPEG — drop every APPn (0xE0–0xEF, incl. APP1=EXIF/XMP, APP13=IPTC) + COM.
//   • PNG  — drop ancillary metadata chunks (eXIf, tEXt, zTXt, iTXt, tIME).
//   • WebP — drop EXIF/XMP RIFF chunks and clear the VP8X metadata flag bits.
//
// Best-effort: if the bytes don't parse as the declared type, the ORIGINAL bytes
// are returned so a valid-but-unexpected image still uploads (the gate already
// validated magic bytes). For the supported, well-formed inputs, metadata is removed.

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function fourcc(b: Uint8Array, i: number): string {
  return String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
}

// ── JPEG ──────────────────────────────────────────────────────────────────────
// JFIF/EXIF JPEGs are a stream of marker segments. Metadata (EXIF GPS, XMP, IPTC,
// comments) lives in APPn (0xFFE0–0xFFEF) and COM (0xFFFE) segments, always BEFORE
// the start-of-scan. We rebuild the stream omitting those; everything from the
// first SOS marker onward (the entropy-coded image data + any further scans + EOI)
// is copied verbatim.
function stripJpeg(b: Uint8Array): Uint8Array {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return b; // not a JPEG (no SOI)
  const parts: Uint8Array[] = [b.subarray(0, 2)]; // SOI
  let i = 2;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) { parts.push(b.subarray(i)); break; } // desync → keep remainder
    let marker = b[i + 1];
    while (marker === 0xff && i + 2 < b.length) { i++; marker = b[i + 1]; } // skip fill bytes
    if (marker === 0xd9) { parts.push(b.subarray(i, i + 2)); break; }        // EOI
    if (marker === 0xda) { parts.push(b.subarray(i)); break; }               // SOS → copy rest
    // Standalone markers (no length payload): RSTn, TEM.
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { parts.push(b.subarray(i, i + 2)); i += 2; continue; }
    if (i + 4 > b.length) { parts.push(b.subarray(i)); break; }
    const len = (b[i + 2] << 8) | b[i + 3];               // length INCLUDES the 2 length bytes
    const segEnd = Math.min(i + 2 + len, b.length);
    const drop = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe; // APPn or COM
    if (!drop) parts.push(b.subarray(i, segEnd));
    i = segEnd;
  }
  return concat(parts);
}

// ── PNG ───────────────────────────────────────────────────────────────────────
// PNG is an 8-byte signature followed by length-prefixed chunks. Metadata lives in
// ancillary chunks; we drop the ones that can carry EXIF/GPS/XMP/free text and keep
// everything rendering-relevant verbatim (their CRCs stay valid since we don't edit).
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);
function stripPng(b: Uint8Array): Uint8Array {
  if (b.length < 8 || !PNG_SIG.every((v, k) => b[k] === v)) return b;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const parts: Uint8Array[] = [b.subarray(0, 8)]; // signature
  let i = 8;
  while (i + 8 <= b.length) {
    const len = dv.getUint32(i);            // big-endian chunk data length
    const type = fourcc(b, i + 4);
    const chunkEnd = i + 12 + len;          // len(4) + type(4) + data(len) + crc(4)
    if (chunkEnd > b.length) { parts.push(b.subarray(i)); break; } // malformed → keep remainder
    if (!PNG_DROP.has(type)) parts.push(b.subarray(i, chunkEnd));
    i = chunkEnd;
    if (type === 'IEND') break;
  }
  return concat(parts);
}

// ── WebP ──────────────────────────────────────────────────────────────────────
// RIFF container: "RIFF"<size>"WEBP" then chunks. Metadata is in "EXIF"/"XMP "
// chunks (only present in the extended VP8X form). Drop those chunks and clear the
// EXIF/XMP flag bits in the VP8X header, then fix the RIFF size.
function stripWebp(b: Uint8Array): Uint8Array {
  if (b.length < 12 || fourcc(b, 0) !== 'RIFF' || fourcc(b, 8) !== 'WEBP') return b;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const header = b.subarray(0, 12).slice(); // mutable copy ("RIFF"<size>"WEBP")
  const kept: Uint8Array[] = [];
  let i = 12;
  let dropped = false;
  while (i + 8 <= b.length) {
    const cc = fourcc(b, i);
    const size = dv.getUint32(i + 4, true);     // little-endian
    const padded = size + (size & 1);           // chunks are padded to even length
    const chunkEnd = i + 8 + padded;
    if (chunkEnd > b.length) { kept.push(b.subarray(i)); i = b.length; break; }
    if (cc === 'EXIF' || cc === 'XMP ') {
      dropped = true;                           // drop the metadata chunk
    } else if (cc === 'VP8X') {
      const chunk = b.subarray(i, chunkEnd).slice();
      chunk[8] &= ~0x08;                        // clear EXIF flag
      chunk[8] &= ~0x04;                        // clear XMP flag
      kept.push(chunk);
    } else {
      kept.push(b.subarray(i, chunkEnd));
    }
    i = chunkEnd;
  }
  if (!dropped) return b; // nothing to strip → return original untouched
  const out = concat([header, ...kept]);
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(4, out.length - 8, true); // RIFF size
  return out;
}

/**
 * Remove EXIF/GPS/XMP/IPTC/text metadata from an image, losslessly (pixel data is
 * preserved). `type` is the magic-byte-detected type from scanFile ('jpeg'|'png'|
 * 'webp'). Returns the original bytes for any other/unparseable input.
 */
export function stripImageMetadata(bytes: Uint8Array, type: string): Uint8Array {
  try {
    if (type === 'jpeg') return stripJpeg(bytes);
    if (type === 'png') return stripPng(bytes);
    if (type === 'webp') return stripWebp(bytes);
  } catch {
    // Any parsing surprise → keep the original (the gate already validated it).
  }
  return bytes;
}
