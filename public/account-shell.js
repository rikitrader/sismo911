/* SISMO911 backend account shell.
   Injects the same fintech "account" left sidebar used on /cuenta so that
   logged-in client backend pages (e.g. /suministros-ciudadano) share ONE
   consistent backend look — instead of the public emergency app-shell.

   Usage: include INSTEAD of /app-shell.js, e.g.
     <script src="/account-shell.js" defer></script>
   The page's existing <body> content is reparented into the shell's main
   column, so no markup changes are required beyond swapping the script.

   The sidebar mirrors /cuenta's nav. Tab-based finance tools live on /cuenta,
   so "Finanzas" links there; the per-feature links navigate directly. The
   link matching the current path is marked active. */
(function () {
  'use strict';
  if (window.__s911AccountShell) return;            // idempotent
  window.__s911AccountShell = true;

  var path = (location.pathname || '/').replace(/\.html$/, '').replace(/\/+$/, '') || '/';

  /* Nav model — label, href, match prefix, inline SVG path(s). Mirrors the
     /cuenta sidebar so the backend feels like one app. */
  var NAV = [
    { label: 'Inicio',       href: '/cuenta',                 m: '/cuenta',
      svg: '<path d="M3 9.5 12 3l9 6.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>' },
    { label: 'Finanzas',     href: '/cuenta',                 m: '__never__',
      svg: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>' },
    { label: 'Suministros',  href: '/suministros-ciudadano',  m: '/suministros-ciudadano',
      svg: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>' },
    { label: 'Transporte',   href: '/flota',                  m: '/flota',
      svg: '<path d="M1 3h15v13H1z"/><path d="M16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>' },
    { label: 'Campañas',     href: '/campana',                m: '/campana',
      svg: '<path d="M3 11l18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>' },
    { sep: true },
    { label: 'Contactos',    href: '/contacto',               m: '/contacto',
      svg: '<path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><path d="M9 9h0M9 13a3 3 0 0 1 6 0M15 9h0"/>' }
  ];

  function icon(d) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
           'stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
  }

  /* ── Styles (self-contained; reuses page CSS vars with safe fallbacks) ── */
  var css = '' +
    ':root{color-scheme:light;' +
      '--as-bg:var(--bg,#f5f7fb);--as-surface:var(--surface,#fff);' +
      '--as-surface-2:var(--surface-2,#f9fafc);--as-text:var(--text,#111827);' +
      '--as-muted:var(--muted,#6b7280);--as-border:var(--border,#d9dee8);' +
      '--as-brand:var(--brand-2,#0b5fff);}' +
    'html body{padding-left:0!important;padding-top:0!important;}' +     /* kill any public app-shell offsets */
    '#s911-shell,#s911-topbar,#s911-back{display:none!important;}' +
    '.as-shell{display:flex;align-items:stretch;min-height:100vh;background:var(--as-bg);}' +
    '.as-side{position:sticky;top:0;align-self:flex-start;height:100vh;width:248px;flex:0 0 248px;' +
      'z-index:50;background:var(--as-surface);border-right:1px solid var(--as-border);' +
      'display:flex;flex-direction:column;padding:18px 16px;font-family:Inter,"Public Sans",system-ui,sans-serif;}' +
    '.as-head{display:flex;align-items:center;gap:9px;padding:2px 4px 18px;text-decoration:none;}' +
    '.as-head img{width:34px;height:34px;object-fit:contain;flex-shrink:0;display:block;}' +
    '.as-brand{font-family:"Public Sans",Inter,system-ui,sans-serif;font-weight:800;font-size:1.08rem;' +
      'color:var(--as-text);letter-spacing:-.01em;line-height:1.05;}' +
    '.as-brand small{display:block;font-size:.62rem;font-weight:600;color:var(--as-muted);' +
      'letter-spacing:.02em;margin-top:1px;}' +
    '.as-nav{display:flex;flex-direction:column;gap:3px;flex:1;overflow-y:auto;margin:0 -4px;padding:0 4px;}' +
    '.as-link{display:flex;align-items:center;gap:12px;width:100%;text-align:left;text-decoration:none;' +
      'padding:10px 12px;border-radius:11px;border:none;background:transparent;cursor:pointer;' +
      'font-size:.875rem;font-weight:600;color:var(--as-muted);transition:background .14s,color .14s;}' +
    '.as-link svg{width:18px;height:18px;flex-shrink:0;}' +
    '.as-link:hover{background:var(--as-surface-2);color:var(--as-text);}' +
    '.as-link.active{background:var(--as-brand);color:#fff;box-shadow:0 4px 12px rgba(11,95,255,.30);}' +
    '.as-sep{height:1px;background:var(--as-border);margin:8px 4px;}' +
    '.as-foot{padding-top:12px;}' +
    '.as-help{display:block;text-decoration:none;background:var(--as-surface-2);border:1px solid var(--as-border);' +
      'border-radius:14px;padding:14px;}' +
    '.as-help b{display:block;font-size:.85rem;color:var(--as-text);margin-bottom:3px;}' +
    '.as-help span{font-size:.76rem;color:var(--as-muted);}' +
    '.as-help i{display:block;margin-top:8px;font-style:normal;font-size:.8rem;font-weight:700;color:var(--as-brand);}' +
    '.as-main{flex:1;min-width:0;display:flex;flex-direction:column;}' +
    /* mobile top bar + drawer */
    '.as-burger{display:none;position:sticky;top:0;z-index:45;align-items:center;gap:10px;' +
      'background:var(--as-surface);border-bottom:1px solid var(--as-border);padding:10px 14px;}' +
    '.as-burger button{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;' +
      'border:1px solid var(--as-border);border-radius:10px;background:var(--as-surface);color:var(--as-text);cursor:pointer;}' +
    '.as-burger button svg{width:20px;height:20px;}' +
    '.as-burger .as-burger-brand{font-family:"Public Sans",Inter,system-ui,sans-serif;font-weight:800;color:var(--as-text);}' +
    '.as-scrim{display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:49;}' +
    '@media(max-width:880px){' +
      '.as-side{position:fixed;left:0;top:0;transform:translateX(-100%);transition:transform .22s ease;box-shadow:0 0 40px rgba(0,0,0,.18);}' +
      '.as-side.open{transform:translateX(0);}' +
      '.as-burger{display:flex;}' +
      '.as-scrim.open{display:block;}' +
    '}';

  function build() {
    var body = document.body;
    if (!body) return;

    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    /* Sidebar */
    var aside = document.createElement('aside');
    aside.className = 'as-side';
    var navHtml = NAV.map(function (n) {
      if (n.sep) return '<div class="as-sep" role="separator"></div>';
      var active = n.m !== '__never__' && (path === n.m || path.indexOf(n.m + '/') === 0) ? ' active' : '';
      return '<a class="as-link' + active + '" href="' + n.href + '">' + icon(n.svg) + '<span>' + n.label + '</span></a>';
    }).join('');
    aside.innerHTML =
      '<a class="as-head" href="/cuenta" aria-label="SISMO911 — mi cuenta">' +
        '<img src="/logo.svg" alt="">' +
        '<span class="as-brand">SISMO911<small>Plataforma Humanitaria</small></span>' +
      '</a>' +
      '<nav class="as-nav" aria-label="Secciones de cuenta">' + navHtml + '</nav>' +
      '<div class="as-foot"><a class="as-help" href="/guia"><b>¿Necesitas ayuda?</b>' +
        '<span>Estamos aquí para apoyarte.</span><i>Centro de ayuda →</i></a></div>';

    /* Main column — reparent existing body content into it */
    var main = document.createElement('main');
    main.className = 'as-main';

    var burger = document.createElement('div');
    burger.className = 'as-burger';
    burger.innerHTML =
      '<button type="button" aria-label="Abrir menú"><svg viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button>' +
      '<span class="as-burger-brand">SISMO911</span>';

    var moved = [];
    while (body.firstChild) {
      if (body.firstChild.nodeType === 1 && body.firstChild.tagName === 'SCRIPT') {
        moved.push(body.firstChild);                // keep scripts at body level
        body.removeChild(body.firstChild);
      } else {
        main.appendChild(body.firstChild);
      }
    }
    main.insertBefore(burger, main.firstChild);

    var scrim = document.createElement('div');
    scrim.className = 'as-scrim';

    var shell = document.createElement('div');
    shell.className = 'as-shell';
    shell.appendChild(aside);
    shell.appendChild(main);

    body.appendChild(shell);
    body.appendChild(scrim);
    moved.forEach(function (s) { body.appendChild(s); });   // re-attach scripts (already executed; harmless)

    /* Mobile drawer toggle */
    function setOpen(o) { aside.classList.toggle('open', o); scrim.classList.toggle('open', o); }
    burger.querySelector('button').addEventListener('click', function () { setOpen(!aside.classList.contains('open')); });
    scrim.addEventListener('click', function () { setOpen(false); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
