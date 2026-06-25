/* SISMO911 app shell — injects the duotone-chip sidebar on every page.
   One file, included via <script src="/app-shell.js" defer>. Highlights the
   active item, renders the auth-aware account menu, and handles mobile. */
(function () {
  // PWA manifest (inject once for every sub-page)
  if (!document.querySelector('link[rel=manifest]')) {
    var ml = document.createElement('link'); ml.rel = 'manifest'; ml.href = '/manifest.webmanifest'; document.head.appendChild(ml);
  }
  const NAV = [
    { label: 'Feed en Tiempo Real', href: '/', m: ['/'], d: 'M3 12h4l2 7 4-14 2 7h6' },
    { label: 'Mapa de Capas', href: '/mapa', m: ['/mapa'], d: 'M9 20l-5.4 2.7A1 1 0 012 21.8V6.6a1 1 0 01.55-.9L9 2.5m0 17.5l6 3m-6-3V2.5m6 20.5l5.45-2.72a1 1 0 00.55-.9V4.2a1 1 0 00-1.45-.9L15 5.5m0 17.5V5.5m0 0L9 2.5' },
    { label: 'Alertas', href: '/alertas', m: ['/alertas'], d: 'M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L14.7 3.9a2 2 0 00-3.4 0z' },
    { label: 'Blog', href: '/blog', m: ['/blog'], d: 'M4 4h16v16H4z M8 8h8M8 12h8M8 16h5' },
    { label: 'Alerta PAGER', href: '/pager', m: ['/pager'], d: 'M12 3l8 4v5c0 4.5-3.1 7.9-8 9-4.9-1.1-8-4.5-8-9V7l8-4z' },
    { label: 'Familia / Check-in', href: '/familia', m: ['/familia'], d: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zm14 10v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75' },
    { label: 'Recursos', href: '/recursos', m: ['/recursos'], d: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-14L4 7m8 4v14M4 7v10l8 4' },
    { label: 'Daños (IA)', href: '/danos', m: ['/danos'], d: 'M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z M9 22V12h6v10' },
    { label: 'Daños Estructurales', href: '/danos-estructurales', m: ['/danos-estructurales'], d: 'M4 21V8l8-5 8 5v13M9 21v-5h6v5M8 11h2m4 0h2m-7 8 5-5' },
    { label: 'Radio', href: '/comms', m: ['/comms'], d: 'M4 11a16 16 0 0116 0M7 14a10 10 0 0110 0M10 17a5 5 0 014 0M12 20h.01' },
    { label: 'Guía', href: '/guia', m: ['/guia'], d: 'M12 6.25C10.5 5 8.5 4.5 4 4.5v13c4.5 0 6.5.5 8 1.75M12 6.25C13.5 5 15.5 4.5 20 4.5v13c-4.5 0-6.5.5-8 1.75M12 6.25v13' },
    { label: 'Consola', href: '/admin', m: ['/admin'], d: 'M12 3l8 3.5v5c0 4-3 7-8 9-5-2-8-5-8-9v-5z M9.5 12l2 2 3.5-4' },
  ];

  const NAVY = '#00173a', SECONDARY = '#bb0027', VARIANT = '#44474f', LINE = '#c4c6d0';
  const path = (location.pathname.replace(/\.html$/, '') || '/');
  const active = (it) => it.m.some((x) => x === '/' ? path === '/' : (path === x || path.startsWith(x + '/')));

  const icon = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" style="width:17px;height:17px"><path stroke-linecap="round" stroke-linejoin="round" d="${d}"/></svg>`;

  const item = (it) => {
    const on = active(it);
    return `<a href="${it.href}" style="display:flex;align-items:center;gap:12px;padding:8px 10px;border-radius:10px;font:600 13.5px Inter,sans-serif;text-decoration:none;${on ? 'background:rgba(0,23,58,.06);color:' + NAVY : 'color:' + VARIANT}" onmouseover="if(!${on})this.style.background='#eeeef0'" onmouseout="if(!${on})this.style.background='transparent'">
      <span class="chip" style="width:32px;height:32px;display:grid;place-items:center;border-radius:10px;flex:0 0 auto;${on ? 'background:' + NAVY + ';color:#fff;box-shadow:0 1px 2px rgba(0,0,0,.12)' : 'background:rgba(0,23,58,.10);color:' + NAVY}">${icon(it.d)}</span>
      ${it.label}</a>`;
  };

  const css = `
    @media(min-width:1024px){ body{ padding-left:16rem !important } #s911-burger{display:none!important} #s911-map-shift{left:16rem!important} }
    #s911-shell{position:fixed;top:0;left:0;bottom:0;width:16rem;background:#fff;border-right:1px solid ${LINE};display:flex;flex-direction:column;z-index:1200;transform:translateX(-100%);transition:transform .2s ease}
    #s911-shell.open{transform:none}
    @media(min-width:1024px){ #s911-shell{transform:none} }
    #s911-back{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1199;display:none}
    #s911-back.open{display:block}
    #s911-burger{position:fixed;top:12px;left:12px;z-index:1100;width:42px;height:42px;border-radius:10px;background:${NAVY};color:#fff;display:grid;place-items:center;border:none;box-shadow:0 2px 8px rgba(0,0,0,.2)}
    #s911-shell a.acct{text-decoration:none}
  `;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  // Hide the page's own top header (the old horizontal nav)
  document.querySelectorAll('body > header').forEach((h) => { h.style.display = 'none'; });
  // Full-screen map page: shift the map right of the sidebar on desktop
  const map = document.getElementById('map');
  if (map) { map.id = 'map'; map.style.top = '0'; map.style.left = '0'; map.style.setProperty('left', '0'); map.classList.add('s911-mapfix'); const s = document.createElement('style'); s.textContent = '@media(min-width:1024px){#map{left:16rem!important;top:0!important}}'; document.head.appendChild(s); }

  const shell = document.createElement('aside');
  shell.id = 's911-shell';
  shell.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;padding:0 18px;height:72px;border-bottom:1px solid ${LINE}">
      <img src="/logo.svg" alt="SISMO911" style="width:46px;height:46px">
      <div style="line-height:1"><div style="font:800 30px 'Public Sans',sans-serif;color:${NAVY};letter-spacing:-.01em">SISMO911</div></div>
    </div>
    <nav style="flex:1;overflow-y:auto;padding:14px 12px;display:flex;flex-direction:column;gap:2px">${NAV.map(item).join('')}</nav>
    <div style="padding:12px;border-top:1px solid ${LINE};display:flex;flex-direction:column;gap:8px">
      <a href="/sos" style="display:flex;align-items:center;justify-content:center;gap:8px;background:${SECONDARY};color:#fff;font:800 13.5px 'Public Sans',sans-serif;padding:11px;border-radius:10px;text-decoration:none">⚠ Emergencia / SOS</a>
      <div id="s911-acct"></div>
    </div>`;
  document.body.appendChild(shell);

  const back = document.createElement('div'); back.id = 's911-back'; document.body.appendChild(back);
  const burger = document.createElement('button'); burger.id = 's911-burger'; burger.setAttribute('aria-label', 'Menú');
  burger.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:22px;height:22px"><path stroke-linecap="round" d="M4 6h16M4 12h16M4 18h16"/></svg>';
  document.body.appendChild(burger);
  const toggle = (open) => { shell.classList.toggle('open', open); back.classList.toggle('open', open); };
  burger.onclick = () => toggle(!shell.classList.contains('open'));
  back.onclick = () => toggle(false);

  // Auth-aware account block
  const ROLE = { citizen: 'Ciudadano', operator: 'Operador', admin: 'Administrador' };
  const esc = (s) => (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  fetch('/api/auth/me').then((r) => r.json()).then((d) => {
    const box = document.getElementById('s911-acct');
    if (!d.authenticated) {
      box.innerHTML = `<a href="/login" class="acct" style="display:flex;align-items:center;justify-content:center;gap:8px;background:${NAVY};color:#fff;font:600 13px Inter,sans-serif;padding:10px;border-radius:10px">Iniciar sesión</a>`;
      return;
    }
    const u = d.user, ini = esc((u.name || '?').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase());
    const isOp = u.role === 'operator' || u.role === 'admin';
    box.innerHTML = `<div style="display:flex;align-items:center;gap:10px;padding:6px 4px">
        <div style="width:36px;height:36px;border-radius:50%;background:${NAVY};color:#fff;display:grid;place-items:center;font:700 13px 'Public Sans'">${ini}</div>
        <div style="line-height:1.1;min-width:0"><div style="font:700 13px Inter;color:${NAVY};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(u.name)}</div><div style="font:500 11px Inter;color:${VARIANT}">${esc(ROLE[u.role] || ROLE.citizen)}</div></div>
      </div>
      <div style="display:flex;gap:6px">
        <a href="/cuenta" style="flex:1;text-align:center;font:600 12px Inter;color:${NAVY};border:1px solid ${LINE};border-radius:8px;padding:6px;text-decoration:none">Mi cuenta</a>
        ${isOp ? `<a href="/admin" style="flex:1;text-align:center;font:600 12px Inter;color:#fff;background:${NAVY};border-radius:8px;padding:6px;text-decoration:none">Consola</a>` : ''}
        <button id="s911-logout" style="font:600 12px Inter;color:${SECONDARY};border:1px solid ${LINE};border-radius:8px;padding:6px 10px;background:#fff">Salir</button>
      </div>`;
    document.getElementById('s911-logout').onclick = async () => { await fetch('/api/auth/logout', { method: 'POST' }); location.href = '/login'; };
  }).catch(() => {});
})();
