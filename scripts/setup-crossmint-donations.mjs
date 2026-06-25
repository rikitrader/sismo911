#!/usr/bin/env node
// One-time Crossmint setup for SISMO911 donations (card → USDC on Base).
//
// Creates ONE donation Collection + Template. Each donation is an Order whose
// amount is set per-order via callData.totalPrice — we do NOT pre-create prices.
// If no recipient (merchant) wallet is given, one is created on Crossmint and
// used as the USDC settlement address.
//
// Usage:
//   CROSSMINT_API_KEY=sk_production_... \
//   [CROSSMINT_ENV=production|staging] [CROSSMINT_CHAIN=base] \
//   [SISMO_RECIPIENT_WALLET=0x...] [SISMO_COLLECTION_IMAGE_URL=https://...] \
//     node scripts/setup-crossmint-donations.mjs
//
// Idempotent: if .crossmint-donations.json has a collectionId that resolves,
// it exits early and reprints the config + next steps.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CONFIG_PATH = resolve(REPO_ROOT, '.crossmint-donations.json');

const API_KEY = process.env.CROSSMINT_API_KEY;
const CHAIN = (process.env.CROSSMINT_CHAIN ?? 'base').toLowerCase();
const ENV = process.env.CROSSMINT_ENV ?? 'production';
const BASE_URL = ENV === 'production' ? 'https://www.crossmint.com' : 'https://staging.crossmint.com';
let RECIPIENT = process.env.SISMO_RECIPIENT_WALLET || '';
const IMAGE = process.env.SISMO_COLLECTION_IMAGE_URL || 'https://sismo911.com/og/og-default.png';

const EVM_CHAINS = new Set(['base', 'polygon', 'ethereum', 'arbitrum', 'optimism']);
const EVM_ADDR = /^0x[a-fA-F0-9]{40}$/;

if (!API_KEY) {
  console.error('✗ CROSSMINT_API_KEY env var is required (sk_production_… or sk_staging_…)');
  process.exit(1);
}
if (!EVM_CHAINS.has(CHAIN)) {
  console.error(`✗ CROSSMINT_CHAIN '${CHAIN}' unsupported by this script (use base/polygon/ethereum/…)`);
  process.exit(1);
}

async function api(path, init = {}) {
  const res = await fetch(`${BASE_URL}/api${path}`, {
    ...init,
    headers: { 'X-API-KEY': API_KEY, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`Crossmint ${init.method ?? 'GET'} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  return json;
}

async function ensureRecipient() {
  if (RECIPIENT) {
    if (!EVM_ADDR.test(RECIPIENT)) { console.error(`✗ SISMO_RECIPIENT_WALLET '${RECIPIENT}' is not a valid EVM address`); process.exit(1); }
    console.log(`◇ Using provided merchant wallet: ${RECIPIENT}`);
    return RECIPIENT;
  }
  console.log('→ No recipient given — creating a Crossmint merchant wallet for settlement…');
  const w = await api('/2025-06-09/wallets', {
    method: 'POST',
    body: JSON.stringify({ chainType: 'evm', type: 'smart', config: { adminSigner: { type: 'api-key' } }, owner: 'email:ayuda@sismo911.com' }),
  });
  if (!w.address) throw new Error(`Wallet create returned no address: ${JSON.stringify(w).slice(0, 300)}`);
  RECIPIENT = w.address;
  console.log(`✓ Created merchant wallet: ${RECIPIENT}`);
  return RECIPIENT;
}

async function ensureCollection() {
  if (existsSync(CONFIG_PATH)) {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    if (cfg.collectionId) {
      try {
        await api(`/2022-06-09/collections/${cfg.collectionId}`);
        console.log(`◇ Existing collection verified: ${cfg.collectionId}`);
        return cfg;
      } catch (err) { console.warn(`! Existing collectionId did not resolve — creating a new one. (${err.message})`); }
    }
  }

  // Gotcha 1: Crossmint fetches imageUrl server-side; a non-image (404/HTML) → 502.
  const head = await fetch(IMAGE, { method: 'HEAD' }).catch(() => null);
  const ct = head?.headers.get('content-type') || '';
  if (!head?.ok || !ct.startsWith('image/')) {
    console.error(`✗ image ${IMAGE} not reachable as an image (status=${head?.status} content-type=${ct}). Set SISMO_COLLECTION_IMAGE_URL to a static PNG/JPG that 200s.`);
    process.exit(1);
  }

  const recipient = await ensureRecipient();

  console.log(`→ Creating Collection on ${ENV} (chain=${CHAIN}, currency=usdc, recipient=${recipient})…`);
  const created = await api('/2022-06-09/collections/', {
    method: 'POST',
    body: JSON.stringify({
      chain: CHAIN,
      metadata: { name: 'Donativos SISMO911', description: 'Recibos de donación para la respuesta sísmica de SISMO911. Cada NFT es una constancia no transferible de tu aporte.', imageUrl: IMAGE, symbol: 'S911' },
      payments: { price: '1', recipientAddress: recipient, currency: 'usdc' },
    }),
  });
  if (!created.id) throw new Error(`No collectionId returned: ${JSON.stringify(created).slice(0, 400)}`);

  // Gotcha 2: a Template (not a minted NFT) activates headless checkout.
  console.log('→ Creating donation Template…');
  const template = await api(`/2022-06-09/collections/${created.id}/templates`, {
    method: 'POST',
    body: JSON.stringify({
      metadata: { name: 'Recibo de donación SISMO911', description: 'Constancia no transferible de un donativo a SISMO911.', image: IMAGE, symbol: 'S911' },
      supply: { limit: 1_000_000 },
    }),
  });

  const cfg = {
    collectionId: created.id, templateId: template.templateId ?? null,
    chain: CHAIN, currency: 'USDC', recipientAddress: recipient,
    actionId: created.actionId ?? null, env: ENV, createdAt: new Date().toISOString(),
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`✓ Wrote ${CONFIG_PATH}`);
  console.log(`✓ collectionId: ${cfg.collectionId}  templateId: ${cfg.templateId}`);
  return cfg;
}

ensureCollection()
  .then((cfg) => {
    const clientKey = (API_KEY || '').replace(/^sk_/, 'ck_');
    console.log('\n──────────── NEXT STEPS ────────────');
    console.log('1) In the Crossmint console, open the new Collection → Checkout/Payment settings →');
    console.log('   ENABLE credit-card payments (this toggle is console-only; no API).');
    console.log('2) Set the Worker secrets/vars (run from the repo root):\n');
    console.log(`   echo "${API_KEY}" | npx wrangler secret put CROSSMINT_SERVER_KEY`);
    console.log(`   echo "${clientKey}  # verify in console — client key" | npx wrangler secret put CROSSMINT_CLIENT_KEY`);
    console.log(`   echo "${cfg.collectionId}" | npx wrangler secret put CROSSMINT_COLLECTION_ID`);
    console.log('   # create a webhook in the console pointing to:');
    console.log('   #   https://sismo911.com/api/donations/webhook');
    console.log('   # then store its signing secret:');
    console.log('   echo "whsec_…" | npx wrangler secret put CROSSMINT_WEBHOOK_SECRET');
    console.log(`\n   # vars (wrangler.toml [vars] or secrets): CROSSMINT_ENV=${cfg.env}  CROSSMINT_CHAIN=${cfg.chain}`);
    console.log('\n3) Redeploy:  npm run deploy');
    console.log('\nDonations settle as USDC to:', cfg.recipientAddress);
  })
  .catch((err) => { console.error('✗ Setup failed:', err.message); process.exit(1); });
