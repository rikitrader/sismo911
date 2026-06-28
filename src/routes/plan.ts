import { Hono } from 'hono';
import type { Env } from '../types';
import { cspNonce } from '../lib/security';

/**
 * /plan — invitation-only business-plan slide deck.
 *
 * A self-contained, PowerPoint-style presentation of the SISMO911 emergency
 * medical-supply import plan. Access is gated behind an invite code: a valid
 * code sets a signed (HMAC) cookie, so the deck is only reachable by invitees.
 *
 * Config (wrangler [vars] or secrets):
 *   PLAN_INVITE_CODES  comma-separated list of valid invite codes
 *   PLAN_SECRET        HMAC signing secret for the access cookie
 * Both are required for live access. The route fails closed if PLAN_SECRET is
 * missing and only accepts invite codes from env/KV.
 */
export const plan = new Hono<{ Bindings: Env }>();

const COOKIE = 'plan_access';
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const secretOf = (env: Env) => env.PLAN_SECRET?.trim() || '';
const codesOf = (env: Env) =>
  (env.PLAN_INVITE_CODES || '')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

const KV_PREFIX = 'plan:invite:';

/**
 * A code is valid if it's one of the master env codes OR exists as a KV invite
 * (key `plan:invite:<CODE>`). The 100 batch codes live in KV — see the deploy
 * script / Google Sheet. On first redemption we stamp the KV record.
 */
async function codeIsValid(env: Env, code: string): Promise<boolean> {
  if (!code) return false;
  if (codesOf(env).includes(code)) return true;
  try {
    const v = await env.CACHE.get(KV_PREFIX + code);
    if (v === null) return false;
    // Record first redemption (best-effort; never blocks access).
    try {
      const meta = JSON.parse(v || '{}');
      if (!meta.redeemed_ms) {
        meta.redeemed_ms = Date.now();
        await env.CACHE.put(KV_PREFIX + code, JSON.stringify(meta));
      }
    } catch { /* opaque value — still valid */ }
    return true;
  } catch {
    return false;
  }
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function requireSecret(c: any): string | Response {
  const secret = secretOf(c.env);
  if (!secret) {
    return c.html('<p>PLAN_SECRET no está definido. Configura el secreto para habilitar /plan.</p>', 503);
  }
  return secret;
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function mintToken(env: Env): Promise<string> {
  const exp = String(Date.now() + TTL_MS);
  return exp + '.' + (await hmacHex(secretOf(env), exp));
}

async function tokenValid(env: Env, tok: string | undefined): Promise<boolean> {
  if (!tok) return false;
  const [exp, sig] = tok.split('.');
  if (!exp || !sig) return false;
  if (Number(exp) < Date.now()) return false;
  return timingSafeEq(await hmacHex(secretOf(env), exp), sig);
}

function readCookie(c: any, name: string): string | undefined {
  const raw = c.req.header('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

// ---- GET /plan — deck if unlocked, otherwise the gate ----
plan.get('/', async (c) => {
  const secret = requireSecret(c);
  if (secret instanceof Response) return secret;
  if (await tokenValid(c.env, readCookie(c, COOKIE))) {
    const nonce = cspNonce(c);
    return c.html(deckHtml(nonce));
  }
  return c.html(gateHtml(), 401);
});

async function grant(c: any) {
  const secret = secretOf(c.env);
  if (!secret) {
    return c.html('<p>PLAN_SECRET no está definido. Configura el secreto para habilitar /plan.</p>', 503);
  }
  const tok = await mintToken(c.env);
  c.header('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(tok)}; HttpOnly; Secure; SameSite=Lax; Path=/plan; Max-Age=${TTL_MS / 1000}`);
  return c.redirect('/plan', 302);
}

// ---- POST /plan/unlock — validate invite code, set cookie ----
plan.post('/unlock', async (c) => {
  const secret = requireSecret(c);
  if (secret instanceof Response) return secret;
  const body = await c.req.parseBody().catch(() => ({} as any));
  const code = String((body as any).code || '').trim().toUpperCase();
  if (!(await codeIsValid(c.env, code))) {
    return c.html(gateHtml('Código no válido. Verifica tu invitación.'), 401);
  }
  return grant(c);
});

// ---- GET /plan/i/:code — one-click magic invite link (used in the Sheet) ----
plan.get('/i/:code', async (c) => {
  const secret = requireSecret(c);
  if (secret instanceof Response) return secret;
  const code = String(c.req.param('code') || '').trim().toUpperCase();
  if (!(await codeIsValid(c.env, code))) {
    return c.html(gateHtml('Enlace de invitación no válido o expirado.'), 401);
  }
  return grant(c);
});

// ---- GET /plan/logout — clear access ----
plan.get('/logout', (c) => {
  c.header('Set-Cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/plan; Max-Age=0`);
  return c.redirect('/plan', 302);
});

// =====================================================================
// Views
// =====================================================================

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="es"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<meta name="robots" content="noindex, nofollow"/>
<meta name="theme-color" content="#13284f"/>
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Public+Sans:ital,wght@0,400;0,600;0,700;0,800;0,900;1,400&display=swap" rel="stylesheet"/>
</head><body>${body}</body></html>`;
}

function gateHtml(error?: string): string {
  const err = error ? `<p class="err">${error}</p>` : '';
  const body = `<style>
  :root{--navy:#13284f;--red:#dc2626;--amber:#ea580c;--cream:#f9f9fc;}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Public Sans',system-ui,sans-serif;min-height:100vh;display:grid;place-items:center;
    background:radial-gradient(120% 120% at 50% 0%,#1c3a6e 0%,var(--navy) 55%,#0c1a36 100%);color:#fff;padding:24px}
  .card{width:100%;max-width:420px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);
    border-radius:18px;padding:40px 32px;backdrop-filter:blur(8px);box-shadow:0 30px 80px rgba(0,0,0,.45);text-align:center}
  .lock{width:56px;height:56px;border-radius:14px;background:var(--red);display:grid;place-items:center;margin:0 auto 20px;
    font-size:26px;box-shadow:0 8px 24px rgba(220,38,38,.5)}
  .brand{font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:#9fb4d6;font-weight:700;margin-bottom:6px}
  h1{font-size:23px;font-weight:800;line-height:1.2;margin-bottom:8px}
  .sub{font-size:14px;color:#b9c6df;line-height:1.5;margin-bottom:24px}
  form{display:flex;flex-direction:column;gap:12px}
  input{width:100%;padding:14px 16px;border-radius:11px;border:1px solid rgba(255,255,255,.18);
    background:rgba(0,0,0,.25);color:#fff;font-size:16px;letter-spacing:.08em;text-align:center;text-transform:uppercase;font-family:inherit}
  input:focus{outline:none;border-color:var(--amber);box-shadow:0 0 0 3px rgba(234,88,12,.3)}
  button{padding:14px;border:none;border-radius:11px;background:var(--red);color:#fff;font-size:15px;font-weight:800;
    letter-spacing:.04em;cursor:pointer;transition:transform .12s,background .2s;font-family:inherit}
  button:hover{background:#b91c1c;transform:translateY(-1px)}
  .err{background:rgba(220,38,38,.18);border:1px solid rgba(220,38,38,.5);color:#ffd5d5;
    padding:10px;border-radius:10px;font-size:13px;margin-bottom:16px}
  .foot{margin-top:22px;font-size:11px;color:#7e90b3;letter-spacing:.04em}
  </style>
  <div class="card">
    <div class="lock">🔒</div>
    <div class="brand">SISMO911 · Confidencial</div>
    <h1>Plan de Negocio — Acceso por Invitación</h1>
    <p class="sub">Stockpile médico de emergencia para Venezuela. Este documento es solo para invitados. Ingresa tu código de acceso.</p>
    ${err}
    <form method="POST" action="/plan/unlock" autocomplete="off">
      <input name="code" placeholder="CÓDIGO DE INVITACIÓN" aria-label="Código de invitación" autofocus required/>
      <button type="submit">Acceder al plan →</button>
    </form>
    <div class="foot">¿Sin código? Solicítalo en sismo911.com</div>
  </div>`;
  return shell('Acceso · SISMO911 Plan', body);
}

function deckHtml(nonce: string): string {
  const css = `
  :root{--navy:#13284f;--navy2:#0c1a36;--red:#dc2626;--amber:#ea580c;--gold:#d97706;--green:#16a34a;--cream:#f9f9fc;--ink:#13284f;--mut:#5b6884;--line:#e6e9f1;}
  *{box-sizing:border-box;margin:0;padding:0}
  html{scroll-behavior:smooth}
  /* White background to match the main SISMO911 page (body bg #f9f9fc). */
  body{font-family:'Public Sans',system-ui,sans-serif;color:var(--ink);background:#f9f9fc}
  .progress{position:fixed;top:0;left:0;height:4px;background:linear-gradient(90deg,var(--red),var(--amber));width:0;z-index:50;transition:width .2s}
  .topbar{position:fixed;top:0;right:0;z-index:40;display:flex;gap:10px;align-items:center;padding:14px 18px;font-size:12px;color:var(--navy);font-weight:700;letter-spacing:.1em}
  .topbar .pill{background:var(--red);color:#fff;padding:5px 11px;border-radius:999px;text-transform:uppercase}
  .topbar a{color:var(--navy);text-decoration:none;border:1px solid var(--line);background:#fff;padding:5px 11px;border-radius:999px}
  .deck{scroll-snap-type:y mandatory;overflow-y:scroll;height:100vh}
  .slide{scroll-snap-align:start;min-height:100vh;display:flex;flex-direction:column;justify-content:center;
    padding:84px 7vw 72px;position:relative;color:var(--ink)}
  /* All slides on white/cream — alternating for visual rhythm, never dark. */
  .slide.dark{background:#ffffff;border-top:3px solid var(--red)}
  .slide.light{background:#f9f9fc}
  .slide.band{background:linear-gradient(180deg,#ffffff,#eef1f7)}
  .eyebrow{font-size:13px;font-weight:800;letter-spacing:.22em;text-transform:uppercase;color:var(--red);margin-bottom:16px}
  h1.title{font-size:clamp(34px,6vw,72px);font-weight:900;line-height:1.02;letter-spacing:-.02em;color:var(--navy)}
  h2{font-size:clamp(26px,4.2vw,46px);font-weight:900;line-height:1.06;letter-spacing:-.01em;margin-bottom:10px;color:var(--navy)}
  p.lead{font-size:clamp(16px,2vw,21px);line-height:1.55;color:var(--mut);max-width:60ch;margin-top:14px}
  .snum{position:absolute;right:6vw;bottom:30px;font-size:13px;font-weight:800;color:#9aa6bd;letter-spacing:.1em}
  .grid{display:grid;gap:18px;margin-top:30px}
  .g2{grid-template-columns:repeat(2,1fr)}.g3{grid-template-columns:repeat(3,1fr)}.g4{grid-template-columns:repeat(4,1fr)}
  .card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:22px;box-shadow:0 10px 30px rgba(19,40,79,.06)}
  .card .k{font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--red);margin-bottom:8px}
  .card h3{font-size:19px;font-weight:800;margin-bottom:6px;color:var(--navy)}
  .card p{font-size:14.5px;line-height:1.5;color:var(--mut)}
  .stat{font-size:clamp(28px,3.6vw,42px);font-weight:900;letter-spacing:-.02em;color:var(--navy)}
  .stat .u{font-size:15px;font-weight:700;color:var(--mut);margin-left:4px}
  .pricecard{position:relative;overflow:hidden}
  .pricecard::before{content:"";position:absolute;left:0;top:0;bottom:0;width:5px;background:var(--red)}
  .pricecard.amber::before{background:var(--amber)}.pricecard.green::before{background:var(--green)}.pricecard.gold::before{background:var(--gold)}
  .tiers .card h3 .tag{display:inline-block;font-size:11px;font-weight:800;padding:3px 9px;border-radius:999px;
    background:var(--navy);color:#fff;margin-left:8px;vertical-align:middle;letter-spacing:.06em}
  ul.kit{list-style:none;margin-top:10px;display:flex;flex-direction:column;gap:7px}
  ul.kit li{font-size:13.5px;color:var(--mut);padding-left:18px;position:relative;line-height:1.4}
  ul.kit li::before{content:"▸";position:absolute;left:0;color:var(--red);font-weight:900}
  .timeline{margin-top:26px;display:flex;flex-direction:column;gap:0}
  .ph{display:grid;grid-template-columns:130px 1fr;gap:20px;padding:16px 0;border-top:1px solid var(--line)}
  .ph:last-child{border-bottom:1px solid var(--line)}
  .ph .when{font-weight:900;font-size:15px;color:var(--amber)}
  .ph .when small{display:block;font-weight:700;color:#9aa6bd;font-size:12px;letter-spacing:.05em;margin-top:3px}
  .ph .what b{font-size:17px;font-weight:800;display:block;margin-bottom:3px;color:var(--navy)}
  .ph .what span{font-size:14px;color:var(--mut);line-height:1.45}
  .bars{margin-top:24px;display:flex;flex-direction:column;gap:13px}
  .bar{display:grid;grid-template-columns:240px 1fr 92px;align-items:center;gap:14px}
  .bar .lab{font-size:14px;font-weight:700;color:var(--navy)}
  .track{height:22px;border-radius:7px;background:#e6e9f1;overflow:hidden}
  .fill{height:100%;border-radius:7px;background:linear-gradient(90deg,var(--red),var(--amber))}
  .bar .val{font-size:14px;font-weight:800;text-align:right;color:var(--navy)}
  .ask{display:flex;flex-wrap:wrap;gap:14px;margin-top:28px}
  .ask .big{flex:1;min-width:240px;background:#fff;border:1px solid var(--line);border-left:5px solid var(--red);border-radius:16px;padding:26px;box-shadow:0 10px 30px rgba(19,40,79,.06)}
  .ask .big .n{font-size:clamp(30px,4vw,46px);font-weight:900;color:var(--navy)}
  .ask .big .l{font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:var(--red);font-weight:800;margin-bottom:8px}
  .cta{margin-top:30px;display:flex;gap:14px;flex-wrap:wrap}
  .cta a,.cta button{text-decoration:none;font-weight:800;font-size:15px;padding:14px 24px;border-radius:12px;border:none;cursor:pointer;font-family:inherit}
  .cta .pri{background:var(--red);color:#fff}
  .cta .sec{background:#fff;color:var(--navy);border:1px solid var(--line)}
  .cta .pdf{background:var(--navy);color:#fff;display:inline-flex;align-items:center;gap:8px}
  .cta .pdf:hover{background:#0e2042}
  .dots{position:fixed;right:18px;top:50%;transform:translateY(-50%);z-index:40;display:flex;flex-direction:column;gap:10px}
  .dots a{width:10px;height:10px;border-radius:999px;background:#c7cedd;display:block;transition:.2s}
  .dots a.on{background:var(--red);transform:scale(1.35)}
  .note{margin-top:22px;font-size:12.5px;color:#7a8092;max-width:70ch;line-height:1.5}
  .kbd{font-size:12px;color:#9aa6bd}
  @media(max-width:820px){.g2,.g3,.g4{grid-template-columns:1fr}.bar{grid-template-columns:1fr;gap:5px}.bar .val{text-align:left}
    .ph{grid-template-columns:1fr;gap:5px}.dots{display:none}.slide{padding:90px 22px 70px}}
  @media print{
    @page{margin:14mm}
    html,body{background:#fff!important}
    .deck{height:auto;overflow:visible;scroll-snap-type:none}
    .slide{min-height:auto;page-break-after:always;break-after:page;background:#fff!important;border-top:none!important;padding:24px 0}
    .topbar,.dots,.progress,.cta{display:none!important}
    .card{box-shadow:none;break-inside:avoid}
    .snum{position:static;display:block;margin-top:16px}
  }
  `;

  const dots = (n: number) => {
    let s = '';
    for (let i = 1; i <= n; i++) s += `<a href="#s${i}" data-i="${i}"></a>`;
    return s;
  };

  const body = `<style>${css}</style>
  <div class="progress" id="prog"></div>
  <div class="topbar"><span class="pill">Confidencial</span><a href="/plan/logout">Salir</a></div>
  <div class="dots" id="dots">${dots(11)}</div>
  <main class="deck" id="deck">

    <section class="slide dark" id="s1">
      <div class="eyebrow">SISMO911 · Plan de Negocio Confidencial</div>
      <h1 class="title">Stockpile Médico de Emergencia<br/>para Venezuela</h1>
      <p class="lead">Un inventario médico pre-posicionado en EE.UU., listo para desplegarse por aire a la zona de desastre en 24–72 horas tras un terremoto — activado por la red de alertas SISMO911.</p>
      <p class="note">Modelo humanitario (501(c)(3)) · Importar a un almacén en Miami → desplegar a Venezuela bajo licencia OFAC GL 39. Preparado 2026-06-25.</p>
      <div class="snum">01 / 11</div>
    </section>

    <section class="slide light" id="s2">
      <div class="eyebrow">El Problema</div>
      <h2>El sistema de salud llega vacío al peor momento.</h2>
      <p class="lead">Venezuela está sobre el límite de placas Caribe–Sudamérica y con un terremoto mayor pendiente. Sus hospitales ya carecen de insumos de trauma, antibióticos, fluidos IV y EPP en un día normal.</p>
      <div class="grid g3">
        <div class="card"><div class="k">Las primeras 72h</div><h3>La ventana que salva vidas</h3><p>El periodo donde la atención de trauma rinde más — y donde hoy no hay insumos en estante.</p></div>
        <div class="card"><div class="k">Plazo de importación</div><h3>5–8 semanas</h3><p>Importar por mar durante la crisis llega demasiado tarde para la emergencia aguda.</p></div>
        <div class="card"><div class="k">SISMO911 ya detecta</div><h3>Falta la respuesta</h3><p>La plataforma ya emite la alerta sísmica en vivo. Lo que falta es poner kits en manos de rescatistas.</p></div>
      </div>
      <div class="snum">02 / 11</div>
    </section>

    <section class="slide dark" id="s3">
      <div class="eyebrow">La Solución</div>
      <h2>Un stockpile pre-posicionado en EE.UU., listo para volar.</h2>
      <p class="lead">Construimos un inventario médico certificado por la FDA en un almacén de Miami, empacado en pallets aéreos y conectado al feed de alertas de SISMO911. Cuando se detecta un sismo M≥6, una ola de despliegue vuela Miami → Caracas en 24–72h bajo OFAC GL 39 y la autorización humanitaria de medicamentos/dispositivos, y avanza por un socio en tierra a la zona afectada.</p>
      <div class="grid g4">
        <div class="card"><div class="k">Origen</div><h3>Sourcing global</h3><p>China · India · Malasia · México · EE.UU.</p></div>
        <div class="card"><div class="k">Importar</div><h3>Almacén Miami</h3><p>Una importación planificada, no de emergencia.</p></div>
        <div class="card"><div class="k">Disparador</div><h3>M≥6 = alerta</h3><p>El feed USGS de SISMO911 activa el despliegue.</p></div>
        <div class="card"><div class="k">Desplegar</div><h3>Aire a Venezuela</h3><p>24–72h hasta la zona de desastre.</p></div>
      </div>
      <div class="snum">03 / 11</div>
    </section>

    <section class="slide light" id="s4">
      <div class="eyebrow">Por qué un stockpile en EE.UU.</div>
      <h2>Más rápido, más simple, más confiable y legal.</h2>
      <div class="grid g4">
        <div class="card pricecard"><div class="k">Velocidad</div><h3>Sin espera</h3><p>Kits pre-posicionados vuelan de inmediato; cero plazo marítimo de 5–8 semanas en plena crisis.</p></div>
        <div class="card pricecard amber"><div class="k">Aduanas</div><h3>Una sola vez</h3><p>Una importación bulk planificada a EE.UU., no una liberación de emergencia SENIAT/INHRR en el peor momento.</p></div>
        <div class="card pricecard green"><div class="k">Confianza</div><h3>501(c)(3)</h3><p>Donaciones deducibles en EE.UU., auditoría y trazabilidad de lote/vencimiento conforme a FDA.</p></div>
        <div class="card pricecard gold"><div class="k">Sanciones</div><h3>OFAC GL 39</h3><p>El carve-out humanitario médico hace legal cada entrega, con memo de cumplimiento por ola.</p></div>
      </div>
      <div class="snum">04 / 11</div>
    </section>

    <section class="slide band" id="s5">
      <div class="eyebrow">El Kit</div>
      <h2>Kit médico de terremoto — 40 SKUs, 3 niveles.</h2>
      <div class="grid g3 tiers">
        <div class="card"><h3>T1 IFAK <span class="tag">Primera respuesta</span></h3><ul class="kit">
          <li>Torniquetes (CAT Gen-7)</li><li>Gasa hemostática</li><li>Sellos de tórax ventilados</li><li>Vendaje israelí 6"</li><li>Guantes nitrilo · mascarillas</li><li>Mantas mylar · tabletas potabilizadoras</li></ul></div>
        <div class="card"><h3>T2 Trauma <span class="tag">Estabilización</span></h3><ul class="kit">
          <li>Férulas SAM</li><li>Apósitos estériles y de quemadura</li><li>Sales de rehidratación oral</li><li>Paracetamol · ibuprofeno</li><li>Oxímetros · N95</li></ul></div>
        <div class="card"><h3>T3 Clínica de campo <span class="tag">Atención</span></h3><ul class="kit">
          <li>Suturas · sets IV · solución salina</li><li>Antibióticos · lidocaína</li><li>Povidona yodada</li><li>Diagnóstico (PA · glucómetro)</li><li>Bolsas para cadáveres</li></ul></div>
      </div>
      <p class="note">Dimensionado para capacidad ~5,000 personas / multi-ola. BOM completo, códigos HTS y costos unitarios en el modelo en vivo.</p>
      <div class="snum">05 / 11</div>
    </section>

    <section class="slide dark" id="s6">
      <div class="eyebrow">Los Números</div>
      <h2>Costo total del programa.</h2>
      <div class="grid g4">
        <div class="card"><div class="k">Setup (una vez)</div><div class="stat">$58.4<span class="u">K</span></div><p>Entidad, FDA, OFAC, almacén</p></div>
        <div class="card"><div class="k">Primer stockpile</div><div class="stat">$214.8<span class="u">K</span></div><p>Costo en almacén (landed)</p></div>
        <div class="card"><div class="k">Operación / año</div><div class="stat">$176.5<span class="u">K</span></div><p>Almacén, equipo, rotación</p></div>
        <div class="card"><div class="k">Por ola a Venezuela</div><div class="stat">$48.2<span class="u">K</span></div><p>~$8 por beneficiario</p></div>
      </div>
      <div class="grid g2" style="margin-top:18px">
        <div class="card pricecard"><div class="k">Solicitud Año 1</div><div class="stat">$497,901</div><p>Levantar primero (setup + stockpile + 1 año + 1 despliegue)</p></div>
        <div class="card pricecard amber"><div class="k">Programa a 3 años</div><div class="stat">$1.19<span class="u">M</span></div><p>Costo total del programa completo</p></div>
      </div>
      <div class="snum">06 / 11</div>
    </section>

    <section class="slide light" id="s7">
      <div class="eyebrow">Economía Unitaria</div>
      <h2>Del precio FOB al costo en almacén (+25%).</h2>
      <p class="lead">La mayoría de insumos médicos entran a EE.UU. libres de arancel; la exposición principal es Section 301 sobre EPP/dispositivos de origen chino.</p>
      <div class="bars">
        <div class="bar"><div class="lab">Valor FOB de la mercancía</div><div class="track"><div class="fill" style="width:80%"></div></div><div class="val">$171.8K</div></div>
        <div class="bar"><div class="lab">Flete + seguro inbound</div><div class="track"><div class="fill" style="width:4.6%"></div></div><div class="val">$9.9K</div></div>
        <div class="bar"><div class="lab">Arancel + tarifas aduana (301)</div><div class="track"><div class="fill" style="width:3.2%"></div></div><div class="val">$6.8K</div></div>
        <div class="bar"><div class="lab">Broker · FDA · drayage · manejo</div><div class="track"><div class="fill" style="width:2.3%"></div></div><div class="val">$4.9K</div></div>
        <div class="bar"><div class="lab">Reserva (QC · merma · FX · contingencia)</div><div class="track"><div class="fill" style="width:9.9%"></div></div><div class="val">$21.4K</div></div>
        <div class="bar"><div class="lab"><b>Costo total en almacén</b></div><div class="track"><div class="fill" style="width:100%"></div></div><div class="val"><b>$214.8K</b></div></div>
      </div>
      <div class="snum">07 / 11</div>
    </section>

    <section class="slide dark" id="s8">
      <div class="eyebrow">Hoja de Ruta · 18 meses</div>
      <h2>De la entidad al despliegue.</h2>
      <div class="timeline">
        <div class="ph"><div class="when">Fase 0<small>Mes 0–2</small></div><div class="what"><b>Fundación</b><span>501(c)(3), broker aduanal, bono CBP, opinión OFAC, registro FDA.</span></div></div>
        <div class="ph"><div class="when">Fase 1<small>Mes 2–5</small></div><div class="what"><b>Sourcing y diseño</b><span>Cerrar BOM, RFQ a proveedores, QC de muestras, fijar modelo de costo landed.</span></div></div>
        <div class="ph"><div class="when">Fase 2<small>Mes 5–9</small></div><div class="what"><b>Construir stockpile</b><span>Arrendar almacén, PO #1, liberar aduana, inventario con trazabilidad de lote.</span></div></div>
        <div class="ph"><div class="when">Fase 3<small>Mes 9–12</small></div><div class="what"><b>Listos para desplegar</b><span>MOU con socio en Venezuela, tarifas aéreas standby, conectar disparador M≥6, simulacro.</span></div></div>
        <div class="ph"><div class="when">Fase 4<small>Mes 12–18</small></div><div class="what"><b>Operar y escalar</b><span>Rotar stock, levantar fondos Ola-2, añadir hub en Panamá para alcance LATAM.</span></div></div>
      </div>
      <div class="snum">08 / 11</div>
    </section>

    <section class="slide light" id="s9">
      <div class="eyebrow">Cumplimiento y Riesgo</div>
      <h2>Compuertas Go / No-Go en cada paso.</h2>
      <div class="grid g3">
        <div class="card pricecard"><div class="k">Import (entrada EE.UU.)</div><h3>CBP + FDA verdes</h3><p>Clasificación HTS, registro FDA y bono antes de pagar inventario.</p></div>
        <div class="card pricecard amber"><div class="k">Export (salida a VE)</div><h3>OFAC + SDN</h3><p>GL 39, screening del consignatario y filing AES antes de cada ola.</p></div>
        <div class="card pricecard green"><div class="k">Riesgo clave</div><h3>Rx fuera del stockpile</h3><p>Antibióticos/lidocaína: comprar en EE.UU. o enviar directo a VE en donación. Cero sustancias controladas.</p></div>
      </div>
      <p class="note">Cada línea con trazabilidad de lote y vencimiento para auditorías de FDA y donantes. Alcance OFAC confirmado por asesor legal antes de comprometer capital.</p>
      <div class="snum">09 / 11</div>
    </section>

    <section class="slide dark" id="s10">
      <div class="eyebrow">Financiamiento</div>
      <h2>Pipeline ajustado por riesgo: ~$421.5K.</h2>
      <p class="lead">Clave: gran parte del stockpile puede asegurarse como donación en especie (Direct Relief, MedShare, Americares, fundaciones farma) — eso reduce el efectivo a levantar.</p>
      <div class="bars">
        <div class="bar"><div class="lab">En especie (GIK médico)</div><div class="track"><div class="fill" style="width:55%;background:linear-gradient(90deg,#16a34a,#65d08a)"></div></div><div class="val">↓ stockpile</div></div>
        <div class="bar"><div class="lab">Grant institucional ancla (OSF)</div><div class="track"><div class="fill" style="width:30%"></div></div><div class="val">$30K esp.</div></div>
        <div class="bar"><div class="lab">Diáspora + audiencia SISMO911</div><div class="track"><div class="fill" style="width:18%"></div></div><div class="val">Recurrente</div></div>
        <div class="bar"><div class="lab">Surge post-evento (GoFundMe)</div><div class="track"><div class="fill" style="width:12%"></div></div><div class="val">On-trigger</div></div>
      </div>
      <p class="note">Pipeline esperado ~$421.5K vs. solicitud Año-1 $497.9K → brecha ~$76K, cerrable con stretch en top funders + giving post-evento.</p>
      <div class="snum">10 / 11</div>
    </section>

    <section class="slide dark" id="s11">
      <div class="eyebrow">La Solicitud</div>
      <h1 class="title">Levantemos $497,901<br/>para el Año 1.</h1>
      <div class="ask">
        <div class="big"><div class="l">Efectivo · Año 1</div><div class="n">$497,901</div></div>
        <div class="big"><div class="l">En especie bienvenido</div><div class="n">GIK médico</div></div>
        <div class="big"><div class="l">Socio en tierra</div><div class="n">Venezuela</div></div>
      </div>
      <p class="lead">Buscamos grants en efectivo, producto médico donado (gift-in-kind) y socios de distribución en Venezuela. El modelo de costos en vivo (10 pestañas) está disponible a solicitud.</p>
      <div class="cta">
        <button class="pdf" id="pdfBtn" type="button">⬇ Descargar PDF</button>
        <a class="pri" href="mailto:contacto@sismo911.com?subject=SISMO911%20Plan%20M%C3%A9dico%20de%20Emergencia">Hablemos →</a>
        <a class="sec" href="/">Volver a SISMO911</a>
      </div>
      <p class="note">Aviso: aranceles, fletes y reglas FDA/OFAC cambian. Cifras son estimaciones de planificación a junio 2026; HTS a confirmar con broker aduanal y alcance OFAC con asesor legal antes de comprometer capital. <span class="kbd">· Usa ← → o rueda para navegar</span></p>
      <div class="snum">11 / 11</div>
    </section>

  </main>
  <script nonce="${nonce}">
  (function(){
    var deck=document.getElementById('deck'),prog=document.getElementById('prog');
    var slides=Array.prototype.slice.call(document.querySelectorAll('.slide'));
    var dots=Array.prototype.slice.call(document.querySelectorAll('#dots a'));
    function cur(){var st=deck.scrollTop,h=window.innerHeight,i=Math.round(st/h);return Math.max(0,Math.min(slides.length-1,i));}
    function paint(){var st=deck.scrollTop,max=deck.scrollHeight-deck.clientHeight;prog.style.width=(max>0?(st/max*100):0)+'%';
      var i=cur();dots.forEach(function(d,j){d.className=(j===i?'on':'');});}
    deck.addEventListener('scroll',paint,{passive:true});window.addEventListener('resize',paint);paint();
    function go(i){i=Math.max(0,Math.min(slides.length-1,i));slides[i].scrollIntoView({behavior:'smooth'});}
    document.addEventListener('keydown',function(e){
      if(e.key==='ArrowRight'||e.key==='ArrowDown'||e.key==='PageDown'||e.key===' '){e.preventDefault();go(cur()+1);}
      else if(e.key==='ArrowLeft'||e.key==='ArrowUp'||e.key==='PageUp'){e.preventDefault();go(cur()-1);}
      else if(e.key==='Home'){go(0);}else if(e.key==='End'){go(slides.length-1);}
    });
    dots.forEach(function(d){d.addEventListener('click',function(e){e.preventDefault();go(parseInt(d.getAttribute('data-i'),10)-1);});});
    var pdf=document.getElementById('pdfBtn');
    if(pdf){pdf.addEventListener('click',function(){window.print();});}
  })();
  </script>`;
  return shell('SISMO911 · Plan Médico de Emergencia', body);
}
