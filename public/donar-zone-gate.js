/* SISMO911 — /donar zone visibility gate.
   The whole donations zone (/donar, /campana, /recaudar) is hidden from the
   public until an admin reveals it. Included on each zone page.
   - Public, zone hidden  → replace the page with a "no disponible" placeholder.
   - Admin, zone hidden    → show the page + a fixed admin bar with a reveal button.
   - Anyone, zone public    → show the page normally (admin still gets a hide button).
   Hides <main> immediately to avoid flashing hidden content, then decides. */
(function () {
  const NAVY = '#00173a';
  const main = document.querySelector('main');
  if (main) main.style.visibility = 'hidden';

  function placeholder() {
    if (main) {
      main.style.visibility = '';
      main.innerHTML =
        '<div style="max-width:560px;margin:8vh auto;text-align:center;padding:0 16px">' +
        '<div style="font-size:44px;line-height:1">🫶</div>' +
        '<h1 class="font-display" style="font:800 26px/1.2 \'Public Sans\',sans-serif;color:' + NAVY + ';margin:14px 0 8px">Donaciones — próximamente</h1>' +
        '<p style="color:#44474f;font:500 15px/1.6 Inter,sans-serif">La zona de donaciones y recaudación aún no está disponible al público. ' +
        'Estamos afinando las campañas; vuelve pronto.</p>' +
        '<a href="/" style="display:inline-block;margin-top:18px;background:' + NAVY + ';color:#fff;font:700 13.5px \'Public Sans\',sans-serif;padding:11px 18px;border-radius:10px;text-decoration:none">← Volver al inicio</a>' +
        '</div>';
    }
    document.title = 'Donaciones — próximamente · SISMO911';
  }

  function adminBar(isPublic) {
    const bar = document.createElement('div');
    bar.id = 's911-donar-adminbar';
    bar.style.cssText =
      'position:fixed;left:0;right:0;bottom:0;z-index:1300;display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap;' +
      'padding:11px 16px;background:' + NAVY + ';color:#fff;box-shadow:0 -2px 12px rgba(0,0,0,.18);font:600 13px Inter,sans-serif';
    const dot = isPublic ? '#34d399' : '#e57200';
    const label = isPublic
      ? 'Zona de donaciones <b>VISIBLE al público</b>'
      : 'Zona de donaciones <b>OCULTA al público</b> — solo tú (admin) la ves';
    bar.innerHTML =
      '<span style="display:inline-flex;align-items:center;gap:8px"><span style="width:9px;height:9px;border-radius:50%;background:' + dot + '"></span>' + label + '</span>' +
      '<button id="s911-donar-toggle" style="font:800 13px \'Public Sans\',sans-serif;border:none;border-radius:9px;padding:9px 16px;cursor:pointer;background:' +
      (isPublic ? 'rgba(255,255,255,.16);color:#fff' : '#fff;color:' + NAVY) + '">' +
      (isPublic ? 'Ocultar al público' : 'Mostrar al público') + '</button>' +
      '<span id="s911-donar-msg" style="font:600 12px Inter,sans-serif;color:#bcd0f4"></span>';
    document.body.appendChild(bar);
    // Lift content above the bar so nothing is covered.
    document.body.style.paddingBottom = '64px';

    document.getElementById('s911-donar-toggle').onclick = async function () {
      const btn = this; btn.disabled = true;
      const msg = document.getElementById('s911-donar-msg');
      msg.textContent = 'Guardando…';
      try {
        const r = await fetch('/api/donations/zone', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ public: !isPublic }),
        });
        if (!r.ok) throw new Error('http ' + r.status);
        msg.textContent = '✓ Actualizado';
        setTimeout(() => location.reload(), 600);
      } catch (e) {
        msg.textContent = 'Error al guardar';
        btn.disabled = false;
      }
    };
  }

  fetch('/api/donations/zone')
    .then((r) => r.json())
    .then((z) => {
      if (z.public) {
        if (main) main.style.visibility = '';
        if (z.canManage) adminBar(true);
        return;
      }
      // Hidden zone:
      if (z.canManage) {
        if (main) main.style.visibility = '';
        adminBar(false);
      } else {
        placeholder();
      }
    })
    .catch(() => { placeholder(); }); // fail-closed for the public
})();
