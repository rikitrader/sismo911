/**
 * Cloudflare Access JWT verification (defense-in-depth).
 *
 * Cloudflare Access, configured at the edge, sits in FRONT of the Worker and
 * blocks unauthenticated users before they reach it — that is the real lock.
 * This module re-verifies the `Cf-Access-Jwt-Assertion` token inside the Worker
 * so the API write paths can't be reached even if someone bypasses the edge
 * (e.g. via the raw workers.dev hostname).
 *
 * Enforcement is gated on ACCESS_TEAM_DOMAIN + ACCESS_AUD being set, so the app
 * stays reachable until the Access application is actually created.
 */

interface Jwk { kid: string; kty: string; alg: string; n: string; e: string }
interface CertCache { keys: Jwk[]; team: string; exp: number }

let certCache: CertCache | null = null;

async function getKeys(team: string): Promise<Jwk[]> {
  const now = Date.now();
  if (certCache && certCache.team === team && certCache.exp > now) return certCache.keys;
  const res = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`access certs ${res.status}`);
  const json: any = await res.json();
  certCache = { keys: json.keys ?? [], team, exp: now + 3_600_000 };
  return certCache.keys;
}

function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  s += '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const decodeJson = (seg: string) => JSON.parse(new TextDecoder().decode(b64urlToBytes(seg)));

export interface AccessIdentity { email?: string; sub?: string }

/** Verify a CF Access JWT (RS256). Returns identity, or null if invalid. */
export async function verifyAccessJwt(token: string, team: string, aud: string): Promise<AccessIdentity | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;

  let header: any, payload: any;
  try { header = decodeJson(h); payload = decodeJson(p); } catch { return null; }

  const auds: string[] = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return null;
  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  if (payload.iss && payload.iss !== `https://${team}.cloudflareaccess.com`) return null;

  const jwk = (await getKeys(team)).find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(sig),
    new TextEncoder().encode(`${h}.${p}`)
  );
  if (!ok) return null;
  return { email: payload.email, sub: payload.sub };
}
