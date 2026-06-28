// x402 testnet payer harness — drives the full receive flow against a live
// SISMO911 pay link on Base Sepolia. Signs an EIP-3009 TransferWithAuthorization
// (gasless: the facilitator submits on-chain), builds the x402 v2 PaymentPayload,
// and POSTs it back with the PAYMENT-SIGNATURE header.
//
// Manual dev / regression tool — NOT part of the Worker bundle (viem is a
// devDependency; nothing in src/ imports it). A real settlement was proven with
// it (see sismo911-vault 2026-06-27-x402-testnet-e2e-proof).
//
// Modes:
//   node scripts/x402-testnet-payer.mjs gen                         → fresh payer key + address
//   node scripts/x402-testnet-payer.mjs balance <address>           → Base Sepolia USDC balance
//   node scripts/x402-testnet-payer.mjs pay <PAY_URL> <PRIVATE_KEY> → 402 → sign → settle flow
//
// Fund the payer first: https://faucet.circle.com (USDC + Base Sepolia + the gen'd address).
import { createPublicClient, http, parseAbi } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const RPC = process.env.SEPOLIA_RPC || 'https://sepolia.base.org';
const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
const chainIdOf = (net) => Number(/eip155:(\d+)/.exec(net)?.[1]);
const randNonce = () => '0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');

async function usdcBalance(asset, addr) {
  const bal = await pub.readContract({
    address: asset, abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
    functionName: 'balanceOf', args: [addr],
  });
  return bal;
}

async function pay(payUrl, pk) {
  const account = privateKeyToAccount(pk.startsWith('0x') ? pk : '0x' + pk);
  console.log('payer address:', account.address);

  // 1. Probe → 402 + PAYMENT-REQUIRED.
  const r1 = await fetch(payUrl, { method: 'GET' });
  console.log('probe status:', r1.status);
  if (r1.status !== 402) { console.log('expected 402, got', r1.status, await r1.text()); process.exit(1); }
  const reqHeader = r1.headers.get('payment-required') || r1.headers.get('PAYMENT-REQUIRED');
  const body = reqHeader ? unb64(reqHeader) : await r1.json();
  const req = body.accepts[0];
  console.log('requirements:', JSON.stringify(req));

  const chainId = chainIdOf(req.network);
  const value = BigInt(req.amount);
  const asset = req.asset;

  // 2. Check funding up front (settle needs balance).
  const bal = await usdcBalance(asset, account.address);
  console.log(`payer USDC balance: ${bal} (need ${value})`);
  if (bal < value) console.log('⚠️  underfunded — /settle will fail until the payer is funded with Sepolia USDC.');

  // 3. Build + sign the EIP-3009 authorization.
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address,
    to: req.payTo,
    value: value.toString(),
    validAfter: '0',
    validBefore: String(now + 3600),
    nonce: randNonce(),
  };
  const domain = { name: req.extra?.name || 'USDC', version: req.extra?.version || '2', chainId, verifyingContract: asset };
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ],
  };
  const signature = await account.signTypedData({
    domain, types, primaryType: 'TransferWithAuthorization',
    message: {
      from: authorization.from, to: authorization.to, value, validAfter: 0n,
      validBefore: BigInt(authorization.validBefore), nonce: authorization.nonce,
    },
  });
  console.log('signed authorization nonce:', authorization.nonce);

  // x402 v2 PaymentPayload: the facilitator reads `accepted` (the chosen
  // requirements) for scheme/network routing — omitting it 500s in verify.
  const paymentPayload = {
    x402Version: 2,
    resource: { url: payUrl, description: body.resource?.description, mimeType: body.resource?.mimeType || 'application/json' },
    accepted: req,
    payload: { signature, authorization },
  };

  // 4. Retry with the signed payload.
  const r2 = await fetch(payUrl, {
    method: 'GET',
    headers: { 'PAYMENT-SIGNATURE': b64(paymentPayload) },
  });
  const txt = await r2.text();
  console.log('\n=== settle attempt ===');
  console.log('status:', r2.status);
  const payResp = r2.headers.get('payment-response');
  if (payResp) console.log('PAYMENT-RESPONSE:', JSON.stringify(unb64(payResp)));
  console.log('body:', txt);

  if (r2.status === 200) {
    const newBal = await usdcBalance(asset, req.payTo);
    console.log(`\n✅ SETTLED. Receiver (${req.payTo}) USDC balance now: ${newBal}`);
  }
}

const [mode, a, b] = process.argv.slice(2);
if (mode === 'gen') {
  const pk = generatePrivateKey();
  console.log('PRIVATE_KEY:', pk);
  console.log('ADDRESS    :', privateKeyToAccount(pk).address);
} else if (mode === 'balance') {
  const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
  console.log(`USDC balance of ${a}:`, await usdcBalance(USDC, a));
} else if (mode === 'pay') {
  await pay(a, b);
} else {
  console.log('usage: node scripts/x402-testnet-payer.mjs [gen | balance <addr> | pay <PAY_URL> <PRIVATE_KEY>]');
}
