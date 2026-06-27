/* SISMO911 Telemedicina — PWA glue (scoped to /telemedicina + /telemedicina-panel).
   Registers the shared service worker, shows a custom "Instalar app" button when
   the browser offers install (Android/desktop via beforeinstallprompt), and shows
   a one-tap hint on iOS Safari (which has no beforeinstallprompt). One file, loaded
   only by the two Telemedicina pages so the install identity stays self-contained. */
(function () {
  'use strict';

  // 1) Service worker — same /sw.js the rest of SISMO911 uses (root scope → controls
  //    these pages too). Enables the offline app shell + makes the app installable.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {});
    });
  }

  // Already running as an installed app? Then there's nothing to prompt.
  var standalone = window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;
  if (standalone) return;

  function makeBtn(label) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-label', label);
    b.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483000',
      'background:#0e7c86', 'color:#fff', 'border:none', 'border-radius:999px',
      'padding:12px 18px', 'font:800 14px/1 "Public Sans",system-ui,sans-serif',
      'box-shadow:0 6px 20px rgba(6,48,58,.35)', 'cursor:pointer',
      'display:inline-flex', 'align-items:center', 'gap:8px'
    ].join(';');
    document.body.appendChild(b);
    return b;
  }

  // 2) Android / desktop Chromium — intercept the native mini-infobar and offer a
  //    branded button instead, firing the real prompt on click.
  var deferred = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    var btn = makeBtn('Instalar app');
    btn.addEventListener('click', function () {
      btn.disabled = true;
      deferred.prompt();
      deferred.userChoice.finally(function () {
        deferred = null;
        btn.remove();
      });
    });
  });

  window.addEventListener('appinstalled', function () {
    deferred = null;
  });

  // 3) iOS Safari — no beforeinstallprompt; surface a dismissible "Add to Home Screen"
  //    hint once (remembered in localStorage so it isn't nagging).
  var ua = window.navigator.userAgent || '';
  var isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  var isSafari = /^((?!chrome|crios|fxios|android).)*safari/i.test(ua);
  if (isIOS && isSafari) {
    try { if (localStorage.getItem('tm-ios-install-dismissed') === '1') return; } catch (_) {}
    var hint = makeBtn('Instalar: Compartir → Agregar a inicio');
    hint.style.background = '#06303a';
    hint.style.maxWidth = '92vw';
    hint.style.fontSize = '13px';
    hint.addEventListener('click', function () {
      try { localStorage.setItem('tm-ios-install-dismissed', '1'); } catch (_) {}
      hint.remove();
    });
  }
})();
