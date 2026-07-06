// Unit tests for native DOCX intake: zip parsing, text extraction, and the
// pickMedia / markdownFromMedia wiring. A DOCX silently dropped by the bot cost
// us a real roster (2026-07-05) — these tests pin the fix.
import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { DOCX_MIME, extractDocxText } from '../src/telegram/intake/docx';
import { pickMedia } from '../src/telegram/intake/download';
import { markdownFromMedia } from '../src/telegram/intake/extract';
import type { Env } from '../src/types';
import type { TelegramMessage } from '../src/telegram/types';
import type { IntakeMedia } from '../src/telegram/intake/types';

// --- Minimal in-memory ZIP builder (local headers + central directory + EOCD) ---

interface RawEntry {
  name: string;
  data: Uint8Array; // already compressed when method=8
  method: 0 | 8;
  uncompressedSize: number;
}

function u16(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff];
}
function u32(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
}

function buildZip(entries: RawEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: number[] = [];
  const central: number[] = [];
  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const offset = parts.length;
    // Local file header (crc left 0 — the extractor never checks it).
    parts.push(...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(e.method), ...u16(0), ...u16(0), ...u32(0), ...u32(e.data.length), ...u32(e.uncompressedSize), ...u16(nameBytes.length), ...u16(0));
    parts.push(...nameBytes, ...e.data);
    // Central directory record.
    central.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(e.method), ...u16(0), ...u16(0), ...u32(0), ...u32(e.data.length), ...u32(e.uncompressedSize), ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset));
    central.push(...nameBytes);
  }
  const cdOffset = parts.length;
  parts.push(...central);
  parts.push(...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(central.length), ...u32(cdOffset), ...u16(0));
  return new Uint8Array(parts);
}

const DOC_XML = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>` +
  `<w:p><w:r><w:t>Niños / Adolescentes</w:t></w:r></w:p>` +
  `<w:p><w:r><w:t>1 ALEXIS RODRÍGUEZ</w:t></w:r><w:tab/><w:r><w:t>9 años</w:t></w:r></w:p>` +
  `<w:p><w:r><w:t>2 BEYLA RAMÍREZ &amp; familia</w:t></w:r></w:p>` +
  `</w:body></w:document>`;

function storedDocx(): Uint8Array {
  const xml = new TextEncoder().encode(DOC_XML);
  return buildZip([
    { name: '[Content_Types].xml', data: new TextEncoder().encode('<Types/>'), method: 0, uncompressedSize: 8 },
    { name: 'word/document.xml', data: xml, method: 0, uncompressedSize: xml.length },
  ]);
}

function deflatedDocx(): Uint8Array {
  const xml = new TextEncoder().encode(DOC_XML);
  const comp = new Uint8Array(deflateRawSync(xml));
  return buildZip([
    { name: 'word/document.xml', data: comp, method: 8, uncompressedSize: xml.length },
  ]);
}

describe('extractDocxText', () => {
  it('extracts paragraphs from a stored-entry docx', async () => {
    const text = await extractDocxText(storedDocx());
    expect(text).toContain('Niños / Adolescentes');
    expect(text).toContain('1 ALEXIS RODRÍGUEZ\t9 años');
    expect(text).toContain('BEYLA RAMÍREZ & familia'); // entity decoded
    expect(text.split('\n').length).toBeGreaterThanOrEqual(3); // one line per w:p
  });

  it('extracts from a deflate-compressed docx', async () => {
    const text = await extractDocxText(deflatedDocx());
    expect(text).toContain('ALEXIS RODRÍGUEZ');
  });

  it('returns empty string on non-zip garbage', async () => {
    expect(await extractDocxText(new Uint8Array([1, 2, 3, 4]))).toBe('');
    expect(await extractDocxText(new Uint8Array(0))).toBe('');
  });

  it('returns empty string when word/document.xml is missing', async () => {
    const zip = buildZip([{ name: 'other.txt', data: new TextEncoder().encode('x'), method: 0, uncompressedSize: 1 }]);
    expect(await extractDocxText(zip)).toBe('');
  });
});

describe('pickMedia (DOCX)', () => {
  const msgWith = (mime: string): TelegramMessage =>
    ({ chat: { id: 1, type: 'private' }, document: { file_id: 'f1', mime_type: mime, file_name: 'lista.docx' } }) as unknown as TelegramMessage;

  it('accepts a DOCX document', () => {
    const picked = pickMedia(msgWith(DOCX_MIME));
    expect(picked).not.toBeNull();
    expect(picked?.mime).toBe(DOCX_MIME);
  });

  it('still rejects unrelated documents', () => {
    expect(pickMedia(msgWith('application/zip'))).toBeNull();
    expect(pickMedia(msgWith('text/plain'))).toBeNull();
  });
});

describe('markdownFromMedia (DOCX)', () => {
  it('reads DOCX natively without any AI call', async () => {
    const media: IntakeMedia = { fileId: 'x', mime: DOCX_MIME, fileName: 'lista.docx', bytes: storedDocx() };
    // env.AI absent on purpose: the native path must not need it.
    const env = { AI: undefined } as unknown as Env;
    const text = await markdownFromMedia(env, media, 40000);
    expect(text).toContain('ALEXIS RODRÍGUEZ');
  });

  it('falls back to toMarkdown when the DOCX is unreadable', async () => {
    const media: IntakeMedia = { fileId: 'x', mime: DOCX_MIME, fileName: 'lista.docx', bytes: new Uint8Array([9, 9, 9]) };
    const env = {
      AI: { async toMarkdown() { return [{ format: 'markdown', data: 'fallback text' }]; } },
    } as unknown as Env;
    expect(await markdownFromMedia(env, media)).toBe('fallback text');
  });
});
