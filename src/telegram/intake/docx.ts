// SISMO911 — Telegram/console intake: native DOCX text extraction.
// ---------------------------------------------------------------------------
// Workers AI toMarkdown does not reliably cover Word documents, and a silently
// dropped DOCX already cost us a real desaparecidos roster (2026-07-05: a DOCX
// sent to the bot was ignored at pickMedia and unrecoverable — Telegram never
// re-delivers a consumed webhook update). So DOCX is parsed natively: a .docx
// is a ZIP whose word/document.xml holds the text. We read the ZIP central
// directory, inflate the entry with DecompressionStream('deflate-raw') — no
// dependencies — and strip the WordprocessingML tags.
//
// Never throws — returns '' on any structural failure (caller falls back to
// toMarkdown, then to the "no pude leer" reply).

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** Locate the End-Of-Central-Directory record (scan back over the comment). */
function findEocd(view: DataView): number {
  const min = Math.max(0, view.byteLength - 22 - 65535);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

interface ZipEntry {
  method: number;
  compSize: number;
  localOffset: number;
}

/** Find one entry by exact name via the central directory. */
function findEntry(bytes: Uint8Array, view: DataView, wanted: string): ZipEntry | null {
  const eocd = findEocd(view);
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true); // central directory offset
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (p + 46 > view.byteLength || view.getUint32(p, true) !== CENTRAL_SIG) return null;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (name === wanted) return { method, compSize, localOffset };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** Slice an entry's (possibly compressed) data using its LOCAL header lengths. */
function entryData(bytes: Uint8Array, view: DataView, e: ZipEntry): Uint8Array | null {
  const p = e.localOffset;
  if (p + 30 > view.byteLength || view.getUint32(p, true) !== LOCAL_SIG) return null;
  const nameLen = view.getUint16(p + 26, true);
  const extraLen = view.getUint16(p + 28, true);
  const start = p + 30 + nameLen + extraLen;
  if (start + e.compSize > bytes.byteLength) return null;
  return bytes.subarray(start, start + e.compSize);
}

/** Inflate a raw-deflate buffer via the platform DecompressionStream. */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  try {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    const drained = new Response(ds.readable).arrayBuffer(); // start reading before writing
    await writer.write(data.slice()); // owned copy — never leaks the rest of the zip
    await writer.close();
    return new Uint8Array(await drained);
  } catch {
    return null;
  }
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

/** WordprocessingML → plain text: paragraphs/breaks → newlines, tabs kept, tags stripped. */
function xmlToText(xml: string): string {
  return xml
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract the visible text of a .docx. Returns '' when the buffer is not a
 * readable DOCX (bad zip, missing/undecodable word/document.xml).
 */
export async function extractDocxText(bytes: Uint8Array): Promise<string> {
  try {
    if (bytes.byteLength < 22) return '';
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entry = findEntry(bytes, view, 'word/document.xml');
    if (!entry) return '';
    const data = entryData(bytes, view, entry);
    if (!data) return '';
    let xmlBytes: Uint8Array | null;
    if (entry.method === 0) xmlBytes = data;
    else if (entry.method === 8) xmlBytes = await inflateRaw(data);
    else return '';
    if (!xmlBytes) return '';
    return xmlToText(new TextDecoder().decode(xmlBytes));
  } catch {
    return '';
  }
}
