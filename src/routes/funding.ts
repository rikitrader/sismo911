import { Hono } from 'hono';
import type { Env } from '../types';
import { googleAccessToken } from '../lib/sheets-sync';

/**
 * GET /api/funding — live funder pipeline for the supply dashboard.
 *
 * Reads the "09_Funding" tab of the business-plan spreadsheet via the Worker's
 * Google OAuth refresh token (same creds as the monitor-sheet sync), so the
 * private sheet is never exposed publicly. Result is cached in KV for 10 min;
 * on any upstream failure we serve the last good cache so the dashboard never
 * goes blank. Columns: A Funder | B Type | C What | D Target$ | E Prob | F EV | G Status.
 */
export const funding = new Hono<{ Bindings: Env }>();

const DEFAULT_SHEET = '1Z-BhwUxo6fM1eXBUkjr7hfL50swAf_8tFtZArFnu464';
const RANGE = '09_Funding!A4:H17';
const YEAR1_ASK = 497901; // from 08_Financial_Model (Year-1 funding ask)
const CACHE_KEY = 'funding:v1';
const TTL = 600; // seconds

interface Funder { name: string; type: string; target: number; prob: number; ev: number; status: string }
interface Payload { ok: boolean; funders: Funder[]; totals: { target: number; expected: number }; ask: number; gap: number; updated_ms: number }

async function fetchFunding(env: Env): Promise<Payload | null> {
  const token = await googleAccessToken(env);
  if (!token) return null;
  const sheet = env.FUNDING_SHEET_ID || DEFAULT_SHEET;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheet}/values/${encodeURIComponent(RANGE)}?valueRenderOption=UNFORMATTED_VALUE`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) { console.error('[funding] sheet read', res.status); return null; }
  const j = await res.json<{ values?: any[][] }>();
  const rows = j.values ?? [];
  const funders: Funder[] = [];
  for (const r of rows) {
    const name = String(r[0] ?? '').trim();
    if (!name) continue;
    const target = Number(r[3]) || 0;
    const prob = Number(r[4]) || 0;
    const ev = r[5] != null && r[5] !== '' ? Number(r[5]) : Math.round(target * prob);
    funders.push({ name, type: String(r[1] ?? '').trim(), target, prob, ev: Number(ev) || 0, status: String(r[6] ?? '').trim() });
  }
  funders.sort((a, b) => b.ev - a.ev);
  const target = funders.reduce((s, f) => s + f.target, 0);
  const expected = funders.reduce((s, f) => s + f.ev, 0);
  return { ok: true, funders, totals: { target, expected }, ask: YEAR1_ASK, gap: Math.max(0, YEAR1_ASK - expected), updated_ms: Date.now() };
}

/**
 * Live money actually in the door — paid donations from the crowdfunding
 * platform (/donar). Computed fresh on every request (cheap) and guarded, so a
 * missing `donations` table (migration not applied) just yields zeros.
 */
async function liveDonations(env: Env): Promise<{ raisedTotal: number; raisedCrypto: number; donors: number }> {
  try {
    const row = await env.DB.prepare(
      `SELECT COALESCE(SUM(amount_usd),0) AS total,
              COUNT(*) AS donors,
              COALESCE(SUM(CASE WHEN provider='crossmint' OR currency IN ('USDC','USDC.e','ETH','BTC') THEN amount_usd ELSE 0 END),0) AS crypto
         FROM donations WHERE status='paid'`
    ).first<any>();
    return { raisedTotal: Number(row?.total ?? 0), raisedCrypto: Number(row?.crypto ?? 0), donors: Number(row?.donors ?? 0) };
  } catch {
    return { raisedTotal: 0, raisedCrypto: 0, donors: 0 };
  }
}

funding.get('/', async (c) => {
  const fresh = c.req.query('fresh') === '1';
  const live = await liveDonations(c.env); // always fresh
  let payload: Payload | null = null;

  if (!fresh) {
    const cached = await c.env.CACHE.get(CACHE_KEY);
    if (cached) { try { payload = JSON.parse(cached); } catch { /* refetch below */ } }
  }
  if (!payload) {
    payload = await fetchFunding(c.env).catch((e: any) => { console.error('[funding]', e?.message ?? e); return null; });
    if (payload && payload.funders.length) {
      await c.env.CACHE.put(CACHE_KEY, JSON.stringify(payload), { expirationTtl: TTL }).catch(() => {});
    } else {
      const stale = await c.env.CACHE.get(CACHE_KEY);
      if (stale) { try { payload = JSON.parse(stale); } catch { /* unavailable */ } }
    }
  }
  if (!payload || !payload.funders.length) {
    return c.json({ ok: false, funders: [], live, reason: 'unavailable' }, 200, { 'Cache-Control': 'no-store' });
  }
  return c.json({ ...payload, live }, 200, { 'Cache-Control': 'no-store' });
});
