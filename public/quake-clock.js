/* SISMO911 — canonical earthquake clock.
   Single source of truth for the reference event (Yumare M7.5, event us6000t7zp)
   so the "tiempo transcurrido" cronómetro on /terremotos and the "tiempo
   desaparecidos" counter on /personas always agree. Origin time per USGS PAGER
   (see pager.html): 2026-06-24 22:05:11 UTC. */
(function () {
  // Canonical origin time (epoch ms).
  var ORIGIN = Date.parse('2026-06-24T22:05:11Z');
  window.SISMO_QUAKE = { time: ORIGIN, mag: 7.5, alert: 'red', place: 'Yumare, Yaracuy' };

  // Break an elapsed-ms span into d/h/m/s + a few preformatted strings.
  function parts(ms) {
    var t = Math.max(0, Math.floor(ms / 1000));
    var d = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600),
        m = Math.floor((t % 3600) / 60), s = t % 60;
    var p2 = function (n) { return String(n).padStart(2, '0'); };
    return {
      d: d, h: h, m: m, s: s,
      clock: (d ? d + 'd ' : '') + p2(h) + ':' + p2(m) + ':' + p2(s),
      compact: d ? (d + 'd ' + h + 'h ' + p2(m) + 'm') : (h ? (h + 'h ' + p2(m) + 'm ' + p2(s) + 's') : (m + 'm ' + p2(s) + 's')),
      totalMin: Math.floor(t / 60)
    };
  }
  window.sismoElapsed = function (fromMs) { return parts(Date.now() - (fromMs || ORIGIN)); };

  // Live-tick a span every second. `render(parts)` paints; returns a stop fn.
  window.sismoTick = function (render, fromMs) {
    var from = fromMs || ORIGIN;
    var run = function () { render(parts(Date.now() - from)); };
    run();
    var id = setInterval(run, 1000);
    return function () { clearInterval(id); };
  };
})();
