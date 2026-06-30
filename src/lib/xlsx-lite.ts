// Minimal, dependency-free .xlsx reader for the Worker cron. An .xlsx is a ZIP of
// XML; we read the central directory, inflate `sharedStrings.xml` +
// `worksheets/sheet1.xml` with the Web `DecompressionStream('deflate-raw')` (present
// in both Cloudflare Workers and Node 18+, so the unit test exercises the same code),
// and extract cell text per row. No SheetJS in the bundle.

const td = new TextDecoder();

function u16(b: Uint8Array, o: number) { return b[o] | (b[o + 1] << 8); }
function u32(b: Uint8Array, o: number) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Response(bytes).body!.pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface ZipEntry { name: string; method: number; compSize: number; localOffset: number; }

/** Parse the ZIP central directory → entry list. */
function readCentralDirectory(buf: Uint8Array): ZipEntry[] {
  // Find End Of Central Directory record (sig 0x06054b50), scanning from the tail.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 0x10000; i--) {
    if (u32(buf, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('xlsx: EOCD not found');
  const count = u16(buf, eocd + 10);
  let off = u32(buf, eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (u32(buf, off) !== 0x02014b50) break;
    const method = u16(buf, off + 10);
    const compSize = u32(buf, off + 20);
    const nameLen = u16(buf, off + 28);
    const extraLen = u16(buf, off + 30);
    const commentLen = u16(buf, off + 32);
    const localOffset = u32(buf, off + 42);
    const name = td.decode(buf.subarray(off + 46, off + 46 + nameLen));
    entries.push({ name, method, compSize, localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readEntry(buf: Uint8Array, e: ZipEntry): Promise<string> {
  // Local file header: 30 bytes fixed + name + extra, then the data.
  const lo = e.localOffset;
  if (u32(buf, lo) !== 0x04034b50) throw new Error('xlsx: bad local header for ' + e.name);
  const nameLen = u16(buf, lo + 26);
  const extraLen = u16(buf, lo + 28);
  const dataStart = lo + 30 + nameLen + extraLen;
  const comp = buf.subarray(dataStart, dataStart + e.compSize);
  const raw = e.method === 0 ? comp : await inflateRaw(comp);
  return td.decode(raw);
}

const ENT: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
function unesc(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENT[m]).replace(/&#x?([0-9a-fA-F]+);/g, (_m, c) =>
    String.fromCodePoint(parseInt(c, /[xX]/.test(_m) ? 16 : 10)));
}

/** sharedStrings.xml → array of strings (concatenate the <t> runs inside each <si>). */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g; let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml))) {
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g; let t: RegExpExecArray | null; let s = '';
    while ((t = tRe.exec(m[1]))) s += unesc(t[1]);
    out.push(s);
  }
  return out;
}

function colIndex(ref: string): number {
  const m = /^([A-Z]+)/.exec(ref); if (!m) return 0;
  let n = 0; for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Parse the first worksheet → rows of cell text (shared strings resolved). */
function parseSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g; let r: RegExpExecArray | null;
  while ((r = rowRe.exec(xml))) {
    const cells: string[] = [];
    // One regex per cell. `[^>]*?` is non-greedy and the `(?:/>|>…</c>)` alternation
    // matches a SELF-CLOSING empty cell (`<c r="F5"/>`) before the open/close form —
    // otherwise a greedy open-tag branch swallows the next cell and misaligns columns.
    const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let c: RegExpExecArray | null;
    while ((c = cRe.exec(r[1]))) {
      const attrs = c[1] || '';
      const body = c[2] || '';
      const ref = (/r="([A-Z]+\d+)"/.exec(attrs) || [])[1] || '';
      const t = (/t="([^"]+)"/.exec(attrs) || [])[1] || 'n';
      let val = '';
      if (t === 's') { const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1]; val = shared[Number(v)] ?? ''; }
      else if (t === 'inlineStr') { const v = (/<t[^>]*>([\s\S]*?)<\/t>/.exec(body) || [])[1] || ''; val = unesc(v); }
      else { const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1] || ''; val = unesc(v); }
      const idx = ref ? colIndex(ref) : cells.length;
      cells[idx] = val;
    }
    rows.push(Array.from(cells, (x) => x ?? ''));
  }
  return rows;
}

/** Read the first sheet of an .xlsx buffer → rows of cell text. */
export async function parseXlsxRows(buf: ArrayBuffer): Promise<string[][]> {
  const bytes = new Uint8Array(buf);
  const entries = readCentralDirectory(bytes);
  const ssEntry = entries.find((e) => e.name === 'xl/sharedStrings.xml');
  const shared = ssEntry ? parseSharedStrings(await readEntry(bytes, ssEntry)) : [];
  // First sheet by path (sheet1.xml) or the first worksheets/* entry.
  const sheetEntry = entries.find((e) => e.name === 'xl/worksheets/sheet1.xml')
    || entries.find((e) => /^xl\/worksheets\/.*\.xml$/.test(e.name));
  if (!sheetEntry) throw new Error('xlsx: no worksheet found');
  return parseSheet(await readEntry(bytes, sheetEntry), shared);
}
