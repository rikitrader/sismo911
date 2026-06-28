import { describe, expect, it } from 'vitest';
import { evidence, evidenceShare } from '../src/routes/evidence';
import { persons } from '../src/routes/persons';
import { evaluateGate } from '../src/rbac/route-policy';
import { sha256Hex, imageDimensions, mintShareToken, tokenHash } from '../src/lib/evidence';

// ── Configurable mock D1 + R2 that records every prepared SQL + bind values. ──
function makeEnv(opts: { item?: any; share?: any; user?: any } = {}) {
  const runs: { sql: string; binds: any[] }[] = [];
  const r2: Record<string, Uint8Array> = {};
  const stmt = (sql: string, binds: any[] = []): any => ({
    bind: (...n: any[]) => stmt(sql, n),
    first: async () => {
      if (/FROM sessions s JOIN users u/.test(sql)) return opts.user ?? null;
      if (/FROM case_attachments WHERE id = \? AND person_id = \? AND deleted_ms IS NULL/.test(sql)) return opts.item ?? null;
      if (/FROM evidence_share_links WHERE token_hash/.test(sql)) return opts.share ?? null;
      if (/FROM evidence_share_links WHERE id = \?/.test(sql)) return opts.share ?? null;
      return null;
    },
    all: async () => ({ results: [] }),
    run: async () => { runs.push({ sql, binds }); return { meta: { changes: 1 } }; },
  });
  const env: any = {
    DB: { prepare: (sql: string) => stmt(sql) },
    PERSON_PHOTOS: {
      put: async (k: string, v: Uint8Array) => { r2[k] = v; },
      get: async (k: string) => (r2[k] ? { body: r2[k] } : null),
      delete: async (k: string) => { delete r2[k]; },
    },
  };
  return { env, runs, r2 };
}
const OP = { id: 'u1', email: 'op@sismo911.test', name: 'Op', role: 'operator', expires_ms: Date.now() + 60_000 };

describe('evidence integrity helpers', () => {
  it('sha256Hex is the canonical 64-hex SHA-256', async () => {
    const h = await sha256Hex(new TextEncoder().encode('abc'));
    expect(h).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('imageDimensions reads a PNG header', () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47], 0);
    new DataView(png.buffer).setUint32(16, 800); new DataView(png.buffer).setUint32(20, 600);
    expect(imageDimensions(png)).toEqual({ width: 800, height: 600 });
  });
  it('imageDimensions returns null for unknown bytes', () => {
    expect(imageDimensions(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
  it('share token: only the hash is derivable; round-trips', async () => {
    const { secret, hash } = await mintShareToken();
    expect(secret).toMatch(/^[0-9a-f]{48}$/);
    expect(await tokenHash(secret)).toBe(hash);
    expect(secret).not.toBe(hash);
  });
});

describe('evidence access control (the global gate contract)', () => {
  it('operator evidence routes require persons:moderate', () => {
    expect(evaluateGate('/api/persons/abc/evidence', 'GET')).toEqual({ kind: 'perm', perm: 'persons:moderate' });
    expect(evaluateGate('/api/persons/abc/evidence/e1', 'PATCH')).toEqual({ kind: 'perm', perm: 'persons:moderate' });
    expect(evaluateGate('/api/persons/abc/evidence/e1/share', 'POST')).toEqual({ kind: 'perm', perm: 'persons:moderate' });
    expect(evaluateGate('/api/persons/abc/evidence/shares/s1', 'DELETE')).toEqual({ kind: 'perm', perm: 'persons:moderate' });
  });
  it('the public signed-share view is open (token is the only credential)', () => {
    expect(evaluateGate('/api/e/:token', 'GET').kind).toBe('open');
    expect(evaluateGate('/api/e/sometoken/file', 'GET').kind).toBe('open');
  });
});

describe('evidence item lifecycle', () => {
  it('404s on a missing/deleted item', async () => {
    const { env } = makeEnv({ item: null });
    const res = await evidence.request('/abc/evidence/e1', {}, env);
    expect(res.status).toBe(404);
  });

  it('soft-deletes (UPDATE deleted_ms) — never a hard DELETE — and logs custody', async () => {
    const { env, runs } = makeEnv({ item: { id: 'e1', person_id: 'abc', status: 'draft' }, user: OP });
    const res = await evidence.request('/abc/evidence/e1', { method: 'DELETE' }, env);
    expect(res.status).toBe(200);
    expect((await res.json() as any).soft_deleted).toBe(true);
    const del = runs.find((r) => /case_attachments SET deleted_ms/.test(r.sql));
    expect(del, 'soft delete sets deleted_ms via UPDATE').toBeTruthy();
    expect(runs.some((r) => /^DELETE FROM case_attachments/.test(r.sql.trim()))).toBe(false);
    expect(runs.some((r) => /INSERT INTO evidence_chain_of_custody/.test(r.sql) && r.binds.includes('deleted'))).toBe(true);
  });

  it('rejects an invalid status on PATCH', async () => {
    const { env } = makeEnv({ item: { id: 'e1', person_id: 'abc', status: 'draft' } });
    const res = await evidence.request('/abc/evidence/e1', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'bogus' }),
    }, env);
    expect(res.status).toBe(400);
  });

  it('a status change writes a status_change custody event', async () => {
    const { env, runs } = makeEnv({ item: { id: 'e1', person_id: 'abc', status: 'draft' }, user: OP });
    const res = await evidence.request('/abc/evidence/e1', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'verified' }),
    }, env);
    expect(res.status).toBe(200);
    expect(runs.some((r) => /INSERT INTO evidence_chain_of_custody/.test(r.sql) && r.binds.includes('status_change'))).toBe(true);
  });
});

describe('annotations are non-destructive', () => {
  it('an annotation writes ONLY evidence_annotations — never the original file/row', async () => {
    const { env, runs } = makeEnv({ item: { id: 'e1', person_id: 'abc' }, user: OP });
    const res = await evidence.request('/abc/evidence/e1/annotations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shape: 'redact', data: { x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.4, color: '#000' } }),
    }, env);
    expect(res.status).toBe(201);
    expect(runs.some((r) => /INSERT INTO evidence_annotations/.test(r.sql))).toBe(true);
    // The original attachment row / R2 object is never mutated by annotating.
    expect(runs.some((r) => /UPDATE case_attachments/.test(r.sql))).toBe(false);
  });
  it('rejects an unknown shape', async () => {
    const { env } = makeEnv({ item: { id: 'e1', person_id: 'abc' } });
    const res = await evidence.request('/abc/evidence/e1/annotations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shape: 'wormhole', data: {} }),
    }, env);
    expect(res.status).toBe(400);
  });
});

describe('comments require a body', () => {
  it('400 when body is empty', async () => {
    const { env } = makeEnv({ item: { id: 'e1', person_id: 'abc' } });
    const res = await evidence.request('/abc/evidence/e1/comments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: '' }),
    }, env);
    expect(res.status).toBe(400);
  });
});

describe('signed share links expire and revoke', () => {
  it('a live link returns the share-safe metadata (no original, no PII)', async () => {
    const { secret, hash } = await mintShareToken();
    const { env } = makeEnv({ share: { id: 's1', token_hash: hash, attachment_id: 'e1', person_id: 'abc', scope: 'item', share_r2_key: 'shares/abc/s1', content_type: 'image/jpeg', title: 'Evidencia', caption: null, redacted: 1, watermark: 1, expires_ms: Date.now() + 60_000, revoked_ms: null } });
    const res = await evidenceShare.request('/' + secret, {}, env);
    expect(res.status).toBe(200);
    const j = await res.json() as any;
    expect(j.ok).toBe(true);
    expect(j.watermark).toBe(true);
    expect(j.file_url).toBe('/api/e/' + secret + '/file');
    // The payload must not leak the private R2 key or person id.
    expect(JSON.stringify(j)).not.toContain('shares/abc/s1');
    expect(JSON.stringify(j)).not.toContain('"abc"');
  });

  it('an expired link returns 410', async () => {
    const { secret, hash } = await mintShareToken();
    const { env } = makeEnv({ share: { id: 's1', token_hash: hash, expires_ms: Date.now() - 1000, revoked_ms: null, person_id: 'abc', attachment_id: 'e1' } });
    const res = await evidenceShare.request('/' + secret, {}, env);
    expect(res.status).toBe(410);
  });

  it('a revoked link returns 410', async () => {
    const { secret, hash } = await mintShareToken();
    const { env } = makeEnv({ share: { id: 's1', token_hash: hash, expires_ms: Date.now() + 60_000, revoked_ms: Date.now(), person_id: 'abc', attachment_id: 'e1' } });
    const res = await evidenceShare.request('/' + secret, {}, env);
    expect(res.status).toBe(410);
  });

  it('an unknown token returns 404', async () => {
    const { env } = makeEnv({ share: null });
    const res = await evidenceShare.request('/' + 'f'.repeat(48), {}, env);
    expect(res.status).toBe(404);
  });
});

describe('upload records the original SHA-256 + draft status', () => {
  it('POST /:id/attachments hashes the immutable original and seeds status=draft', async () => {
    // person exists (caseExists → first() on persons), capture the INSERT bind row.
    const runs: { sql: string; binds: any[] }[] = [];
    const stmt = (sql: string, binds: any[] = []): any => ({
      bind: (...n: any[]) => stmt(sql, n),
      first: async () => (/FROM persons WHERE id = \?/.test(sql) ? { id: 'abc' } : (/sessions s JOIN users u/.test(sql) ? OP : null)),
      all: async () => ({ results: [] }),
      run: async () => { runs.push({ sql, binds }); return { meta: { changes: 1 } }; },
    });
    const env: any = { DB: { prepare: (s: string) => stmt(s) }, PERSON_PHOTOS: { put: async () => {}, get: async () => null } };
    const fd = new FormData();
    fd.append('kind', 'photo');
    // Valid 8-byte PNG signature + trailing bytes so the magic-byte check passes (audit H1).
    fd.append('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])], 'x.png', { type: 'image/png' }));
    const res = await persons.request('/abc/attachments', { method: 'POST', body: fd }, env);
    expect(res.status).toBe(201);
    const j = await res.json() as any;
    expect(j.sha256).toMatch(/^[0-9a-f]{64}$/);
    const insert = runs.find((r) => /INSERT INTO case_attachments/.test(r.sql));
    expect(insert, 'attachment INSERT happened').toBeTruthy();
    expect(insert!.binds).toContain(j.sha256);   // original_sha256 persisted
    expect(insert!.binds).toContain('draft');     // status seeded
    // chain of custody 'uploaded' event recorded
    expect(runs.some((r) => /INSERT INTO evidence_chain_of_custody/.test(r.sql) && r.binds.includes('uploaded'))).toBe(true);
  });

  it('POST /:id/attachments refuses a scriptable type (audit H1 stored-XSS guard)', async () => {
    const stmt = (sql: string): any => ({
      bind: () => stmt(sql),
      first: async () => (/FROM persons WHERE id = \?/.test(sql) ? { id: 'abc' } : (/sessions s JOIN users u/.test(sql) ? OP : null)),
      all: async () => ({ results: [] }),
      run: async () => ({ meta: { changes: 1 } }),
    });
    const env: any = { DB: { prepare: (s: string) => stmt(s) }, PERSON_PHOTOS: { put: async () => {}, get: async () => null } };
    const fd = new FormData();
    fd.append('kind', 'document');
    fd.append('file', new File([new TextEncoder().encode('<script>alert(1)</script>')], 'x.html', { type: 'text/html' }));
    const res = await persons.request('/abc/attachments', { method: 'POST', body: fd }, env);
    expect(res.status).toBe(415);
  });
});
