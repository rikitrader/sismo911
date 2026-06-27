#!/usr/bin/env node
// cf-protect.mjs — Cloudflare edge protection for sismo911 (idempotent).
//
// Edge-level defenses that run BEFORE the Worker, so a bot/scrape flood is
// blocked/challenged without ever costing a Worker invocation:
//   • rate-limit  — Rate Limiting Rule on /api/* (managed challenge over a threshold)
//   • bot-fight   — enable Bot Fight Mode (best-effort; plan-dependent)
//   • all         — run every subcommand (default)
//
// (PR2 adds `cache-rules`; PR4 adds `usage-alert` — same CLI shape.)
//
// Usage:
//   CLOUDFLARE_API_TOKEN=<token> node scripts/cf-protect.mjs [all|rate-limit|bot-fight]
//
// The token needs zone scopes: "Zone WAF: Edit" (rate-limit) and, for bot-fight,
// "Zone Settings: Edit" / Bot Management. The script NEVER reads token files; pass
// it explicitly. It reports clearly if the zone plan doesn't allow a rule.
//
// Env: CLOUDFLARE_API_TOKEN (required), CF_ZONE (default sismo911.com),
//      CF_API_THRESHOLD (default 300 req / 60s per IP).

const API = 'https://api.cloudflare.com/client/v4';
const ZONE_NAME = process.env.CF_ZONE || 'sismo911.com';
const THRESHOLD = Number(process.env.CF_API_THRESHOLD || 300);
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const RULE_DESC = 'sismo911 API flood guard (managed by cf-protect.mjs)';

if (!TOKEN) {
  console.error('✖ CLOUDFLARE_API_TOKEN is required. Create a token (Zone WAF: Edit) and:');
  console.error('  CLOUDFLARE_API_TOKEN=<token> node scripts/cf-protect.mjs');
  process.exit(2);
}

async function cf(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!body.success) {
    const msg = (body.errors || []).map((e) => `${e.code} ${e.message}`).join('; ') || res.status;
    const err = new Error(msg);
    err.cfErrors = body.errors || [];
    throw err;
  }
  return body.result;
}

async function zoneId() {
  const zones = await cf(`/zones?name=${encodeURIComponent(ZONE_NAME)}`);
  if (!zones.length) throw new Error(`zone ${ZONE_NAME} not found on this token`);
  return zones[0].id;
}

// --- rate-limit: one Rate Limiting Rule on /api/* (idempotent by description) ---
async function rateLimit(zid) {
  const rule = {
    description: RULE_DESC,
    expression: 'starts_with(http.request.uri.path, "/api/")',
    action: 'managed_challenge',
    ratelimit: {
      characteristics: ['ip.src'],
      period: 60,
      requests_per_period: THRESHOLD,
      mitigation_timeout: 60,
    },
    enabled: true,
  };

  // Read the http_ratelimit entrypoint ruleset (404 → none yet).
  let existing = null;
  try {
    existing = await cf(`/zones/${zid}/rulesets/phases/http_ratelimit/entrypoint`);
  } catch (e) {
    if (!/10000|not found|does not exist/i.test(e.message)) throw e;
  }
  const others = (existing?.rules || []).filter((r) => r.description !== RULE_DESC);
  const rules = [...others, rule];
  try {
    await cf(`/zones/${zid}/rulesets/phases/http_ratelimit/entrypoint`, {
      method: 'PUT',
      body: JSON.stringify({ rules }),
    });
    console.log(`✓ rate-limit: /api/* → managed challenge above ${THRESHOLD} req/60s per IP`);
  } catch (e) {
    console.error(`✖ rate-limit rule NOT created: ${e.message}`);
    console.error('  (Likely the zone plan caps rate-limiting rules. In-Worker limits still apply.)');
  }
}

// --- bot-fight: enable Bot Fight Mode (best-effort; plan-dependent) ---
async function botFight(zid) {
  try {
    await cf(`/zones/${zid}/bot_management`, {
      method: 'PUT',
      body: JSON.stringify({ fight_mode: true }),
    });
    console.log('✓ bot-fight: Bot Fight Mode enabled');
  } catch (e) {
    console.error(`• bot-fight: could not toggle via API (${e.message}). Enable it in the dash: Security → Bots.`);
  }
}

const cmd = process.argv[2] || 'all';
const zid = await zoneId();
console.log(`zone ${ZONE_NAME} (${zid})`);
if (cmd === 'rate-limit' || cmd === 'all') await rateLimit(zid);
if (cmd === 'bot-fight' || cmd === 'all') await botFight(zid);
console.log('done.');
