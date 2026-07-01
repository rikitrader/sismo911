// Unit tests for the bulk roster extractor (OCR → chunk → list → dedupe).
import { describe, it, expect } from 'vitest';
import { chunkText, extractRoster } from '../src/telegram/intake/roster';
import type { Env } from '../src/types';
import type { IntakeMedia } from '../src/telegram/intake/types';

const media: IntakeMedia = { fileId: 'bulk:x', mime: 'application/pdf', fileName: 'padron.pdf', bytes: new Uint8Array([1, 2, 3]) };

/** Mock Workers AI: toMarkdown returns fixed markdown; run returns a JSON array reply. */
function fakeAI(markdown: string, arrays: string[]): Env {
  let call = 0;
  const AI = {
    async toMarkdown() {
      return [{ format: 'markdown', data: markdown }];
    },
    async run() {
      const reply = arrays[Math.min(call, arrays.length - 1)];
      call++;
      return { response: reply };
    },
  };
  return { AI } as unknown as Env;
}

describe('chunkText', () => {
  it('keeps short text as a single chunk', () => {
    expect(chunkText('a\nb\nc')).toEqual(['a\nb\nc']);
  });
  it('splits long text on line boundaries', () => {
    const long = Array.from({ length: 400 }, (_, i) => 'linea numero ' + i).join('\n');
    const chunks = chunkText(long);
    expect(chunks.length).toBeGreaterThan(1);
    // No chunk should be absurdly large (bounded near CHUNK_CHARS).
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(3600);
  });
});

describe('extractRoster', () => {
  it('extracts a list of people from a roster', async () => {
    const env = fakeAI(
      'Padrón de desaparecidos\nJuan Perez\nMaria Gomez',
      ['[{"nombre":"Juan Perez","cedula":"12345678"},{"nombre":"Maria Gomez","cedula":null}]'],
    );
    const out = await extractRoster(env, media);
    expect(out.length).toBe(2);
    expect(out[0].nombre).toBe('Juan Perez');
    expect(out[0].cedula).toBe('12345678');
    expect(out[1].nombre).toBe('Maria Gomez');
  });

  it('dedupes by cédula and by normalized name', async () => {
    const env = fakeAI('x', [
      '[{"nombre":"Juan Perez","cedula":"12345678"},{"nombre":"JUAN  PEREZ","cedula":"12345678"},{"nombre":"Ana Ruiz","cedula":null},{"nombre":"ana ruiz","cedula":null}]',
    ]);
    const out = await extractRoster(env, media);
    expect(out.length).toBe(2); // duplicate cédula + duplicate normalized name collapsed
  });

  it('skips rows with neither name nor cédula', async () => {
    const env = fakeAI('x', ['[{"nombre":null,"cedula":null},{"nombre":"Solo Nombre","cedula":null}]']);
    const out = await extractRoster(env, media);
    expect(out.length).toBe(1);
    expect(out[0].nombre).toBe('Solo Nombre');
  });

  it('returns [] when OCR yields nothing', async () => {
    const env = fakeAI('', ['[]']);
    expect(await extractRoster(env, media)).toEqual([]);
  });

  it('returns [] when AI binding is absent', async () => {
    expect(await extractRoster({} as Env, media)).toEqual([]);
  });

  it('survives a malformed chunk reply', async () => {
    const env = fakeAI('x', ['not json at all']);
    expect(await extractRoster(env, media)).toEqual([]);
  });
});
