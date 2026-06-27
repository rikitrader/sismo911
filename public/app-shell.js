/* SISMO911 app shell — injects the duotone-chip sidebar on every page.
   One file, included via <script src="/app-shell.js" defer>. Highlights the
   active item, renders the auth-aware account menu, and handles mobile. */
(function () {
  // PWA manifest (inject once for every sub-page)
  if (!document.querySelector('link[rel=manifest]')) {
    var ml = document.createElement('link'); ml.rel = 'manifest'; ml.href = '/manifest.webmanifest'; document.head.appendChild(ml);
  }
  // Pinned items stay visible at the top of the sidebar (urgent / primary actions).
  const NAV_PINNED = [
    { label: 'DESAPARECIDOS', href: '/personas', m: ['/personas'], alarm: true, d: 'M16 21v-1a4 4 0 00-4-4H6a4 4 0 00-4 4v1M9 11a4 4 0 100-8 4 4 0 000 8zm12.5 1.5L19 15m0 0l-2.5-2.5M19 15l2.5-2.5M19 15l-2.5 2.5' },
    { label: 'EXPEDIENTES', href: '/casos', m: ['/casos'], solid: true, d: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2zM8 13h8M8 16h5' },
    { label: 'TERREMOTOS', href: '/terremotos', m: ['/terremotos'], gold: true, d: 'M3 12h4l2 7 4-14 2 7h6' },
    // Big flashing red CTA pulled out of the "Familia y Reportes" submenu so a
    // damage report is always one tap away — extra top/bottom spacing.
    { label: 'REPORTAR', href: '/reportar', m: ['/reportar'], report: true, d: 'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z' },
    // Big blue "DAÑOS" CTA — same large shape as REPORTAR, navy blue instead of red.
    { label: 'DAÑOS', href: '/danos', m: ['/danos'], damage: true, d: 'M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z M9 22V12h6v10' },
  ];

  // The rest collapse into a few accordion groups so the sidebar stays short.
  // Each group auto-expands when the current page lives inside it.
  const NAV_GROUPS = [
    { label: 'Sismos y Daños', d: 'M9 20l-5.4 2.7A1 1 0 012 21.8V6.6a1 1 0 01.55-.9L9 2.5m0 17.5l6 3m-6-3V2.5m6 20.5l5.45-2.72a1 1 0 00.55-.9V4.2a1 1 0 00-1.45-.9L15 5.5m0 17.5V5.5m0 0L9 2.5', items: [
      { label: 'Mapa de Capas', href: '/mapa', m: ['/mapa'], d: 'M9 20l-5.4 2.7A1 1 0 012 21.8V6.6a1 1 0 01.55-.9L9 2.5m0 17.5l6 3m-6-3V2.5m6 20.5l5.45-2.72a1 1 0 00.55-.9V4.2a1 1 0 00-1.45-.9L15 5.5m0 17.5V5.5m0 0L9 2.5' },
      { label: 'Alertas', href: '/alertas', m: ['/alertas'], d: 'M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L14.7 3.9a2 2 0 00-3.4 0z' },
      { label: 'Alerta PAGER', href: '/pager', m: ['/pager'], d: 'M12 3l8 4v5c0 4.5-3.1 7.9-8 9-4.9-1.1-8-4.5-8-9V7l8-4z' },
      { label: 'Archivo Histórico', href: '/archivo', m: ['/archivo'], d: 'M3 7a2 2 0 012-2h14a2 2 0 012 2v3H3zM3 10h18v7a2 2 0 01-2 2H5a2 2 0 01-2-2zM9 14h6' },
      { label: 'Daños (IA)', href: '/danos', m: ['/danos'], d: 'M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z M9 22V12h6v10' },
      { label: 'Daños Estructurales', href: '/danos-estructurales', m: ['/danos-estructurales'], d: 'M4 21V8l8-5 8 5v13M9 21v-5h6v5M8 11h2m4 0h2m-7 8 5-5' },
    ] },
    { label: 'Ayuda y Suministros', d: 'M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.6l-1-1a5.5 5.5 0 00-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 000-7.8z', items: [
      { label: 'Centros de Acopio', href: '/acopio', m: ['/acopio'], d: 'M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16zM3.27 6.96 12 12.01l8.73-5.05M12 22.08V12' },
      { label: 'Comando Logístico', href: '/logistica', m: ['/logistica'], d: 'M3 13h2l2 5h10l2-5h2M5 13V7a2 2 0 012-2h7l4 4v4M9 21a1 1 0 100-2 1 1 0 000 2zm8 0a1 1 0 100-2 1 1 0 000 2z' },
      { label: 'Suministros Médicos', href: '/suministros-medicos', m: ['/suministros-medicos'], d: 'M12 8v8m-4-4h8M4 7a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2z' },
      { label: 'Panel de Suministros', href: '/suministros-dashboard', m: ['/suministros-dashboard'], d: 'M3 3v18h18M7 16V10m5 6V6m5 10v-3' },
      { label: 'Operaciones Logísticas', href: '/operaciones', m: ['/operaciones'], d: 'M3 11l19-9-9 19-2-8-8-2z' },
      { label: 'Herramientas + Cruz Roja', href: '/herramientas', m: ['/herramientas'], d: 'M14.7 6.3a4 4 0 00-5.4 5.4l-5 5a1.5 1.5 0 002 2l5-5a4 4 0 005.4-5.4l-2.3 2.3-2-2 2.3-2.3z' },
      { label: 'Recursos', href: '/recursos', m: ['/recursos'], d: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-14L4 7m8 4v14M4 7v10l8 4' },
      { label: 'Red Global de Ayuda', href: '/red-ayuda', m: ['/red-ayuda'], d: 'M12 21a9 9 0 100-18 9 9 0 000 18zm0-18c2.6 2.7 2.6 15.3 0 18M3 12h18' },
      { label: 'Donar', href: '/donar', m: ['/donar', '/campana', '/recaudar'], d: 'M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.6l-1-1a5.5 5.5 0 00-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 000-7.8z' },
    ] },
    { label: 'Reportes Ciudadanos', d: 'M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4zm6-3a3 3 0 10-3-3M9 7a3 3 0 11-3 3', items: [
      { label: 'Hospitales — Ingresados', href: '/hospitales', m: ['/hospitales'], d: 'M19 8h-2V6a2 2 0 00-2-2H9a2 2 0 00-2 2v2H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2v-9a2 2 0 00-2-2zM12 11v6m-3-3h6' },
      { label: 'Estoy a Salvo', href: '/estoy-a-salvo', m: ['/estoy-a-salvo'], d: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z' },
      { label: 'Mascotas Perdidas', href: '/mascotas', m: ['/mascotas'], d: 'M4.5 12a2 2 0 100-4 2 2 0 000 4zm15 0a2 2 0 100-4 2 2 0 000 4zM9 8a2 2 0 100-4 2 2 0 000 4zm6 0a2 2 0 100-4 2 2 0 000 4zm-3 3c-2.5 0-4.5 2-4.5 4.5 0 1.5 1.5 2.5 4.5 2.5s4.5-1 4.5-2.5C16.5 13 14.5 11 12 11z' },
      { label: 'Voluntarios', href: '/voluntarios', m: ['/voluntarios'], d: 'M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4z' },
    ] },
    { label: 'Información', d: 'M12 6.25C10.5 5 8.5 4.5 4 4.5v13c4.5 0 6.5.5 8 1.75M12 6.25C13.5 5 15.5 4.5 20 4.5v13c-4.5 0-6.5.5-8 1.75M12 6.25v13', items: [
      { label: 'Noticias', href: '/blog', m: ['/blog'], d: 'M4 4h16v16H4z M8 8h8M8 12h8M8 16h5' },
      { label: 'Información Verificada', href: '/informacion-verificada', m: ['/informacion-verificada'], d: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z' },
      { label: 'Radio', href: '/comms', m: ['/comms'], d: 'M4 11a16 16 0 0116 0M7 14a10 10 0 0110 0M10 17a5 5 0 014 0M12 20h.01' },
      { label: 'Guía', href: '/guia', m: ['/guia'], d: 'M12 6.25C10.5 5 8.5 4.5 4 4.5v13c4.5 0 6.5.5 8 1.75M12 6.25C13.5 5 15.5 4.5 20 4.5v13c-4.5 0-6.5.5-8 1.75M12 6.25v13' },
      { label: 'API · Desarrolladores', href: '/developers', m: ['/developers'], d: 'M16 18l6-6-6-6M8 6l-6 6 6 6' },
    ] },
  ];

  // Contacto lives outside the groups as its own static call-to-action button.
  const NAV_CONTACTO = { label: 'Contacto', href: '/contacto', m: ['/contacto'], cta: true, d: 'M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.13.81.36 1.6.7 2.34a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.74.34 1.53.57 2.34.7A2 2 0 0122 16.92z' };

  // Admin console stays pinned at the bottom of the nav list.
  const NAV_ADMIN = { label: 'Consola', href: '/admin', m: ['/admin'], d: 'M12 3l8 3.5v5c0 4-3 7-8 9-5-2-8-5-8-9v-5z M9.5 12l2 2 3.5-4' };

  const NAVY = '#00173a', SECONDARY = '#bb0027', VARIANT = '#44474f', LINE = '#c4c6d0', GOLD = '#c9a227', CTARED = '#d62828';
  const path = (location.pathname.replace(/\.html$/, '') || '/');
  const active = (it) => it.m.some((x) => x === '/' ? path === '/' : (path === x || path.startsWith(x + '/')));

  const icon = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" style="width:17px;height:17px;display:block"><path stroke-linecap="round" stroke-linejoin="round" d="${d}"/></svg>`;

  const item = (it) => {
    const on = active(it);
    if (it.alarm) {
      // Red "alarm" button — solid SECONDARY with a pulsing ring so it reads as urgent.
      return `<a href="${it.href}" style="display:flex;align-items:center;gap:12px;padding:10px;border-radius:10px;font:800 13.5px 'Public Sans',sans-serif;text-decoration:none;background:${SECONDARY};color:#fff;box-shadow:0 1px 3px rgba(187,0,39,.4)">
      <span class="s911-chip" style="width:32px;height:32px;display:grid;place-items:center;border-radius:10px;flex:0 0 auto;background:rgba(255,255,255,.18);color:#fff">${icon(it.d)}</span>
      ${it.label}</a>`;
    }
    if (it.solid) {
      // Solid navy feature button — same treatment as the alarm button, navy instead of red.
      return `<a href="${it.href}" style="display:flex;align-items:center;gap:12px;padding:10px;border-radius:10px;font:800 13.5px 'Public Sans',sans-serif;text-decoration:none;background:${NAVY};color:#fff;box-shadow:0 1px 3px rgba(0,23,58,.4)">
      <span class="s911-chip" style="width:32px;height:32px;display:grid;place-items:center;border-radius:10px;flex:0 0 auto;background:rgba(255,255,255,.18);color:#fff">${icon(it.d)}</span>
      ${it.label}</a>`;
    }
    if (it.gold) {
      // Solid Venezuela-flag gold feature button with navy text/icon (the flag's yellow+blue pairing).
      return `<a href="${it.href}" style="display:flex;align-items:center;gap:12px;padding:10px;border-radius:10px;font:800 13.5px 'Public Sans',sans-serif;text-decoration:none;background:${GOLD};color:${NAVY};box-shadow:0 1px 3px rgba(201,162,39,.45)">
      <span class="s911-chip" style="width:32px;height:32px;display:grid;place-items:center;border-radius:10px;flex:0 0 auto;background:rgba(0,23,58,.14);color:${NAVY}">${icon(it.d)}</span>
      ${it.label}</a>`;
    }
    if (it.report) {
      // Big flashing red "REPORTAR" CTA, set apart from the pinned buttons by
      // extra top/bottom margin.
      const onR = active(it);
      return `<a href="${it.href}" class="s911-report" style="display:flex;align-items:center;justify-content:center;gap:10px;margin:14px 0;padding:26px 12px;border-radius:14px;font:900 18px 'Public Sans',sans-serif;letter-spacing:.03em;text-decoration:none;background:${SECONDARY};color:#fff;box-shadow:0 2px 10px rgba(187,0,39,.45)${onR ? ';outline:2px solid #fff;outline-offset:-4px' : ''}">
      ${icon(it.d)}${it.label}</a>`;
    }
    if (it.damage) {
      // Big blue "DAÑOS" CTA — same large shape as REPORTAR, solid navy (no flash).
      const onD = active(it);
      return `<a href="${it.href}" style="display:flex;align-items:center;justify-content:center;gap:10px;margin:0 0 14px;padding:26px 12px;border-radius:14px;font:900 18px 'Public Sans',sans-serif;letter-spacing:.03em;text-decoration:none;background:${NAVY};color:#fff;box-shadow:0 2px 10px rgba(0,23,58,.45)${onD ? ';outline:2px solid #fff;outline-offset:-4px' : ''}">
      ${icon(it.d)}${it.label}</a>`;
    }
    if (it.cta) {
      // Solid red call-to-action (CTA conversion color), static — no animation.
      const on2 = active(it);
      return `<a href="${it.href}" style="display:flex;align-items:center;gap:12px;padding:10px;border-radius:10px;font:800 13.5px 'Public Sans',sans-serif;text-decoration:none;background:${CTARED};color:#fff;box-shadow:0 1px 3px rgba(214,40,40,.4)${on2 ? ';outline:2px solid #fff;outline-offset:-4px' : ''}">
      <span class="s911-chip" style="width:32px;height:32px;display:grid;place-items:center;border-radius:10px;flex:0 0 auto;background:rgba(255,255,255,.20);color:#fff">${icon(it.d)}</span>
      ${it.label}</a>`;
    }
    return `<a href="${it.href}" style="display:flex;align-items:center;gap:12px;padding:8px 10px;border-radius:10px;font:600 13.5px Inter,sans-serif;text-decoration:none;${on ? 'background:rgba(0,23,58,.06);color:' + NAVY : 'color:' + VARIANT}" onmouseover="if(!${on})this.style.background='#eeeef0'" onmouseout="if(!${on})this.style.background='transparent'">
      <span class="s911-chip" style="width:32px;height:32px;display:grid;place-items:center;border-radius:10px;flex:0 0 auto;${on ? 'background:' + NAVY + ';color:#fff;box-shadow:0 1px 2px rgba(0,0,0,.12)' : 'background:rgba(0,23,58,.10);color:' + NAVY}">${icon(it.d)}</span>
      ${it.label}</a>`;
  };

  // Collapsible group: a header button (icon + label + chevron) over a body of
  // child items. Starts open when the current page is one of its items.
  const groupActive = (g) => g.items.some(active);
  const chevron = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" class="s911-chev" style="width:15px;height:15px;margin-left:auto"><path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>`;
  const group = (g, i) => {
    const open = groupActive(g);
    return `<div class="s911-group${open ? ' open' : ''}" data-g="${i}">
      <button type="button" class="s911-ghead" aria-expanded="${open}">
        <span class="s911-chip" style="width:32px;height:32px;display:grid;place-items:center;border-radius:10px;flex:0 0 auto;background:rgba(0,23,58,.10);color:${NAVY}">${icon(g.d)}</span>
        <span style="flex:1;text-align:left;min-width:0">${g.label}</span>
        ${chevron}
      </button>
      <div class="s911-gbody">${g.items.map(item).join('')}</div>
    </div>`;
  };

  const css = `
    /* Page content fills the width next to the sidebar (no narrow centered column). */
    body > main{ max-width:none !important; margin-left:0 !important; margin-right:0 !important; width:auto !important }
    /* MOBILE (<1024px): fixed top bar with burger + brand; content cleared below it. */
    body{ padding-top:56px }
    #s911-topbar{position:fixed;top:0;left:0;right:0;height:56px;z-index:1100;display:flex;align-items:center;justify-content:center;gap:10px;padding:0 12px;background:#fff;border-bottom:1px solid ${LINE};box-shadow:0 1px 3px rgba(0,0,0,.06)}
    #s911-burger{position:absolute;left:12px;top:8px;width:40px;height:40px;border-radius:10px;background:${NAVY};color:#fff;display:grid;place-items:center;border:none;flex:0 0 auto;cursor:pointer}
    #s911-topbar .s911-brand{font:800 20px 'Public Sans',sans-serif;color:${NAVY};letter-spacing:-.01em;text-decoration:none;display:flex;align-items:center;gap:8px}
    /* DESKTOP (>=1024px): sidebar handles nav; hide the top bar, no top padding. */
    @media(min-width:1024px){
      body{ padding-left:16rem !important; padding-top:0 !important }
      #s911-topbar{ display:none !important }
    }
    #s911-shell{position:fixed;top:0;left:0;bottom:0;width:16rem;background:#fff;border-right:1px solid ${LINE};display:flex;flex-direction:column;z-index:1200;transform:translateX(-100%);transition:transform .2s ease}
    #s911-shell.open{transform:none}
    @media(min-width:1024px){ #s911-shell{transform:none} }
    #s911-back{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1199;display:none}
    #s911-back.open{display:block}
    #s911-shell a.acct{text-decoration:none}
    /* Big flashing red "REPORTAR" CTA — pulsing glow/brightness flash. */
    #s911-shell a.s911-report{position:relative;animation:s911-report-flash 1.1s ease-in-out infinite}
    @keyframes s911-report-flash{
      0%,100%{box-shadow:0 2px 8px rgba(187,0,39,.45);filter:brightness(1)}
      50%{box-shadow:0 0 0 6px rgba(187,0,39,.18),0 3px 14px rgba(187,0,39,.65);filter:brightness(1.13)}
    }
    @media(prefers-reduced-motion:reduce){
      #s911-shell a.s911-report{animation:none}
    }
    /* Collapsible nav groups (accordion). */
    #s911-shell .s911-ghead{width:100%;display:flex;align-items:center;gap:12px;padding:8px 10px;border:none;border-radius:10px;background:transparent;font:700 13px Inter,sans-serif;color:${VARIANT};cursor:pointer;transition:background .12s}
    #s911-shell .s911-ghead:hover{background:#eeeef0}
    #s911-shell .s911-chev{color:#9aa0ac;transition:transform .18s ease}
    #s911-shell .s911-group.open .s911-chev{transform:rotate(180deg)}
    #s911-shell .s911-gbody{display:none;flex-direction:column;gap:2px;margin:2px 0 4px 22px;padding-left:10px;border-left:1px solid ${LINE}}
    #s911-shell .s911-group.open .s911-gbody{display:flex}
  `;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  // Hide the page's own top header (the old horizontal nav)
  document.querySelectorAll('body > header').forEach((h) => { h.style.display = 'none'; });
  // Full-screen map pages opt in with class "s911-fullmap": pin to top:0 (the page header
  // is hidden above) and shift right of the sidebar on desktop. Inline / in-container maps
  // (homepage, pager, dashboard, acopio) are left untouched — they ride the body padding-left.
  if (document.querySelector('.s911-fullmap')) {
    const s = document.createElement('style');
    // Mobile: sit below the 56px top bar. Desktop: full height, right of sidebar.
    s.textContent = '.s911-fullmap{top:56px!important}@media(min-width:1024px){.s911-fullmap{top:0!important;left:16rem!important}}';
    document.head.appendChild(s);
  }

  const shell = document.createElement('aside');
  shell.id = 's911-shell';
  shell.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;padding:0 18px;height:72px;border-bottom:1px solid ${LINE}">
      <img src="/logo.svg" alt="SISMO911" style="width:46px;height:46px">
      <div style="line-height:1"><div style="font:800 30px 'Public Sans',sans-serif;color:${NAVY};letter-spacing:-.01em">SISMO911</div></div>
    </div>
    <nav style="flex:1;overflow-y:auto;padding:14px 12px;display:flex;flex-direction:column;gap:2px">${NAV_PINNED.map(item).join('')}<div style="height:6px"></div>${NAV_GROUPS.map(group).join('')}<div style="height:6px"></div>${item(NAV_CONTACTO)}${item(NAV_ADMIN)}</nav>
    <div style="padding:12px;border-top:1px solid ${LINE};display:flex;flex-direction:column;gap:8px">
      <a href="/sos" style="display:flex;align-items:center;justify-content:center;gap:8px;background:${SECONDARY};color:#fff;font:800 13.5px 'Public Sans',sans-serif;padding:11px;border-radius:10px;text-decoration:none">⚠ Emergencia / SOS</a>
      <div id="s911-acct"></div>
    </div>`;
  document.body.appendChild(shell);

  const back = document.createElement('div'); back.id = 's911-back'; document.body.appendChild(back);
  // Mobile top bar: burger + brand (hidden on desktop via CSS).
  const topbar = document.createElement('div'); topbar.id = 's911-topbar';
  topbar.innerHTML = `
    <button id="s911-burger" aria-label="Abrir menú"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:22px;height:22px"><path stroke-linecap="round" d="M4 6h16M4 12h16M4 18h16"/></svg></button>
    <a href="/" class="s911-brand"><img src="/logo.svg" alt="" style="width:30px;height:30px">SISMO911</a>`;
  document.body.appendChild(topbar);
  const burger = topbar.querySelector('#s911-burger');
  const toggle = (open) => { shell.classList.toggle('open', open); back.classList.toggle('open', open); };
  burger.onclick = () => toggle(!shell.classList.contains('open'));
  // Close the drawer after tapping a nav link (mobile).
  shell.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => toggle(false)));
  back.onclick = () => toggle(false);
  // Expand/collapse accordion groups (header buttons, not links — drawer stays open).
  shell.querySelectorAll('.s911-ghead').forEach((h) => h.addEventListener('click', () => {
    const g = h.parentElement, open = g.classList.toggle('open');
    h.setAttribute('aria-expanded', open ? 'true' : 'false');
  }));

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

  // The /donar zone is hidden from the public until an admin reveals it. Hide
  // EVERY link into the zone (/donar, /recaudar, /campana) — the sidebar entry
  // PLUS any CTA on other pages (suministros-dashboard, cuenta, …), including
  // links rendered asynchronously after load — and reveal them only if the zone
  // is public OR the caller is an admin. Fail-closed: default + any fetch error
  // leaves them hidden (admin-only). Mirrors the page-level donar-zone-gate.js.
  let DONAR_VISIBLE = false; // hidden until proven public/admin
  const DONAR_RE = /^\/(donar|recaudar|campana)(?:[\/?#]|$)/;
  const isDonarLink = (a) => { try { return DONAR_RE.test(new URL(a.getAttribute('href'), location.origin).pathname); } catch (e) { return false; } };
  const scan = (root) => {
    const els = root && root.querySelectorAll ? root.querySelectorAll('a[href]') : [];
    els.forEach((a) => { if (isDonarLink(a)) { a.setAttribute('data-donar-gate', '1'); a.style.display = DONAR_VISIBLE ? '' : 'none'; } });
  };
  scan(document);
  // Catch donar links injected later (e.g. the dashboard's dynamically-built cards).
  try {
    new MutationObserver((muts) => { for (const m of muts) m.addedNodes.forEach((n) => { if (n.nodeType === 1) scan(n); }); })
      .observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* no MutationObserver → static scan only */ }
  fetch('/api/donations/zone').then((r) => r.json()).then((z) => {
    DONAR_VISIBLE = !!(z.public || z.canManage);
    document.querySelectorAll('a[data-donar-gate="1"]').forEach((a) => { a.style.display = DONAR_VISIBLE ? '' : 'none'; });
  }).catch(() => {
    DONAR_VISIBLE = false;
    document.querySelectorAll('a[data-donar-gate="1"]').forEach((a) => { a.style.display = 'none'; });
  });
})();
