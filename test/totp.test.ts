import { describe, it, expect } from 'vitest';
import {
  base32Encode,
  base32Decode,
  generateSecret,
  totpUri,
  generateTotp,
  verifyTotp,
  generateBackupCodes,
  hashBackupCode,
  matchBackupCode,
} from '../src/lib/totp';

// RFC 6238 Appendix B test seed: ASCII "12345678901234567890" (20 bytes).
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('base32 (RFC 4648)', () => {
  it('encodes the RFC seed to the canonical secret', () => {
    expect(base32Encode(new TextEncoder().encode('12345678901234567890'))).toBe(RFC_SECRET);
  });
  it('round-trips encode→decode', () => {
    const bytes = base32Decode(RFC_SECRET);
    expect(new TextDecoder().decode(bytes)).toBe('12345678901234567890');
  });
});

describe('TOTP — RFC 6238 SHA1 known vectors (6-digit)', () => {
  // 6-digit truncations of the 8-digit Appendix-B values.
  const vectors: Array<[number, string]> = [
    [59_000, '287082'],
    [1_111_111_109_000, '081804'],
    [1_111_111_111_000, '050471'],
    [1_234_567_890_000, '005924'],
    [2_000_000_000_000, '279037'],
    [20_000_000_000_000, '353130'],
  ];
  for (const [atMs, expected] of vectors) {
    it(`t=${atMs}ms → ${expected}`, async () => {
      expect(await generateTotp(RFC_SECRET, atMs)).toBe(expected);
      expect(await verifyTotp(RFC_SECRET, expected, 0, atMs)).toBe(true);
    });
  }
});

describe('verifyTotp', () => {
  it('accepts a code one step away within the window', async () => {
    const at = 1_234_567_890_000;
    const prev = await generateTotp(RFC_SECRET, at - 30_000);
    expect(await verifyTotp(RFC_SECRET, prev, 1, at)).toBe(true);
    expect(await verifyTotp(RFC_SECRET, prev, 0, at)).toBe(false);
  });
  it('rejects a wrong code', async () => {
    expect(await verifyTotp(RFC_SECRET, '000000', 1, 59_000)).toBe(false);
  });
  it('rejects malformed input', async () => {
    expect(await verifyTotp(RFC_SECRET, 'abc', 1, 59_000)).toBe(false);
    expect(await verifyTotp('', '287082', 1, 59_000)).toBe(false);
  });
  it('round-trips a freshly generated secret', async () => {
    const secret = generateSecret();
    const code = await generateTotp(secret);
    expect(await verifyTotp(secret, code)).toBe(true);
  });
});

describe('otpauth URI', () => {
  it('builds a Google-Authenticator-compatible URI', () => {
    const uri = totpUri(RFC_SECRET, 'user@s.com', 'SISMO911');
    expect(uri).toContain('otpauth://totp/SISMO911%3Auser%40s.com');
    expect(uri).toContain(`secret=${RFC_SECRET}`);
    expect(uri).toContain('issuer=SISMO911');
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});

describe('backup codes', () => {
  it('generates 10 unique codes that hash + match (dash-insensitive)', async () => {
    const codes = generateBackupCodes(10);
    expect(codes.length).toBe(10);
    expect(new Set(codes).size).toBe(10);
    const hashes = await Promise.all(codes.map(hashBackupCode));
    // Exact, lowercased, and dash-stripped forms all match.
    expect(await matchBackupCode(codes[3], hashes)).toBe(3);
    expect(await matchBackupCode(codes[3].toLowerCase(), hashes)).toBe(3);
    expect(await matchBackupCode(codes[3].replace('-', ''), hashes)).toBe(3);
    expect(await matchBackupCode('ZZZZ-ZZZZ', hashes)).toBe(-1);
    expect(await matchBackupCode('', hashes)).toBe(-1);
  });
});
