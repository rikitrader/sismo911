// SISMO911 — operator roster importer page logic.
// External file (not inline) so the strict Report-Only CSP ('self') covers it
// without a hash regen. All requests use the session cookie (credentials:same-origin).

(function () {
  'use strict';
  var fileEl = document.getElementById('file');
  var goEl = document.getElementById('go');
  var statusCard = document.getElementById('statusCard');
  var statusEl = document.getElementById('status');
  var statsEl = document.getElementById('stats');
  var doneLink = document.getElementById('doneLink');
  var jobsBody = document.getElementById('jobsBody');
  var poll = null;

  fileEl.addEventListener('change', function () {
    goEl.disabled = !fileEl.files || !fileEl.files.length;
  });

  function setStat(id, v) { document.getElementById(id).textContent = String(v == null ? 0 : v); }

  function renderStatus(job) {
    statusCard.hidden = false;
    var st = job.status;
    if (st === 'done') {
      statusEl.textContent = '✅ ' + job.code + ' — listo. ' + (job.note || '');
      statsEl.hidden = false;
      doneLink.hidden = false;
      setStat('s_total', job.total_records);
      setStat('s_created', job.created_records);
      setStat('s_matched', job.matched_records);
      setStat('s_review', job.needs_review_records);
    } else if (st === 'error') {
      statusEl.textContent = '⚠️ ' + job.code + ' — ' + (job.note || 'error al procesar.');
    } else {
      statusEl.textContent = '⏳ ' + job.code + ' — leyendo nombres del documento…';
    }
  }

  function pollJob(code) {
    if (poll) clearInterval(poll);
    poll = setInterval(function () {
      fetch('/api/admin/intake/bulk/' + encodeURIComponent(code), { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d || !d.job) return;
          renderStatus(d.job);
          if (d.job.status === 'done' || d.job.status === 'error') { clearInterval(poll); poll = null; loadJobs(); }
        })
        .catch(function () {});
    }, 3000);
  }

  goEl.addEventListener('click', function () {
    if (!fileEl.files || !fileEl.files.length) return;
    goEl.disabled = true;
    statusCard.hidden = false;
    statsEl.hidden = true;
    doneLink.hidden = true;
    statusEl.textContent = '⏳ Subiendo…';
    var fd = new FormData();
    fd.append('file', fileEl.files[0]);
    fetch('/api/admin/intake/bulk', { method: 'POST', body: fd, credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          statusEl.textContent = '⚠️ ' + (res.d && (res.d.hint || res.d.error) || 'No se pudo subir el archivo.');
          goEl.disabled = false;
          return;
        }
        statusEl.textContent = '⏳ ' + res.d.code + ' — procesando…';
        fileEl.value = '';
        pollJob(res.d.code);
        loadJobs();
      })
      .catch(function () { statusEl.textContent = '⚠️ Error de red al subir.'; goEl.disabled = false; });
  });

  function pill(status) {
    var cls = status === 'done' ? 'done' : status === 'error' ? 'error' : 'processing';
    return '<span class="pill ' + cls + '">' + status + '</span>';
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  function loadJobs() {
    fetch('/api/admin/intake/bulk', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { jobs: [] }; })
      .then(function (d) {
        var rows = (d.jobs || []).map(function (j) {
          return '<tr><td>' + esc(j.code) + '</td><td>' + esc(j.file_name || '—') + '</td><td>' + pill(j.status) +
            '</td><td>' + (j.total_records == null ? '—' : j.total_records) + '</td><td>' + (j.created_records || 0) + '</td></tr>';
        });
        jobsBody.innerHTML = rows.length ? rows.join('') : '<tr><td colspan="5" class="muted">Aún no hay importaciones.</td></tr>';
      })
      .catch(function () {});
  }

  loadJobs();
})();
