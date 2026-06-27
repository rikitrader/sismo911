/* SISMO911 Telemedicina — doctor panel (v2).
   Tabs: Citas (drive the 7-state lifecycle), Disponibilidad (weekly hours +
   blocks → generates patient slots), Calendario. Styled strictly with the
   SISMO911 design system (navy/crimson tokens). */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const qs = new URLSearchParams(location.search);
  const DOC = qs.get('doc'), TOKEN = qs.get('t');
  const api = (p, opts) => fetch('/api/telemedicina' + p, opts).then((r) => r.json());
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const SPECS = { general: 'Medicina general', pediatria: 'Pediatría', medicina_interna: 'Medicina interna', cardiologia: 'Cardiología', ginecologia: 'Ginecología', traumatologia: 'Traumatología', psicologia: 'Psicología', psiquiatria: 'Psiquiatría', dermatologia: 'Dermatología', neurologia: 'Neurología', nutricion: 'Nutrición', enfermeria: 'Enfermería', farmacia: 'Farmacia', otra: 'Otra' };
  const specL = (k) => SPECS[k] || k;
  const TYPES = [{ key: 'video', label: 'Videoconsulta' }, { key: 'followup', label: 'Seguimiento' }, { key: 'urgent', label: 'Urgente' }, { key: 'mental_health', label: 'Salud mental' }, { key: 'refill', label: 'Receta' }];
  const typeL = (k) => (TYPES.find((t) => t.key === k) || { label: k }).label;
  const DAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

  const ST_LABEL = { scheduled: 'Agendada', checked_in: 'Registrado', waiting_room: 'Sala de espera', in_progress: 'En consulta', completed: 'Completada', cancelled: 'Cancelada', no_show: 'No asistió' };
  const ST_CLS = { scheduled: 'bg-safe/10 text-safe', checked_in: 'bg-primary/10 text-primary', waiting_room: 'bg-warning/10 text-warning', in_progress: 'bg-secondary/10 text-secondary', completed: 'bg-surface-container text-on-surface-variant', cancelled: 'bg-critical/10 text-critical', no_show: 'bg-critical/10 text-critical' };
  const badge = (s) => `<span class="badge ${ST_CLS[s] || 'bg-surface-container text-on-surface-variant'}">${ST_LABEL[s] || s}</span>`;
  const TERMINAL = ['completed', 'cancelled', 'no_show'];
  const ACTIONS = {
    scheduled: [['checked_in', 'Registrado', 'go'], ['waiting_room', 'Sala de espera', 'go'], ['in_progress', 'Iniciar', 'start'], ['no_show', 'No asistió', 'warn'], ['cancelled', 'Cancelar', 'danger']],
    checked_in: [['waiting_room', 'Sala de espera', 'go'], ['in_progress', 'Iniciar', 'start'], ['no_show', 'No asistió', 'warn'], ['cancelled', 'Cancelar', 'danger']],
    waiting_room: [['in_progress', 'Iniciar consulta', 'start'], ['no_show', 'No asistió', 'warn'], ['cancelled', 'Cancelar', 'danger']],
    in_progress: [['completed', 'Completar', 'done'], ['cancelled', 'Cancelar', 'danger']],
  };

  const minToTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const t12 = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); const ap = h < 12 ? 'AM' : 'PM'; return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ap}`; };
  const timeToMin = (t) => { const [h, m] = String(t || '').split(':').map(Number); return Number.isFinite(h) ? h * 60 + (m || 0) : null; };
  const caracasToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
  const tFmt = (ms) => new Date(ms).toLocaleString('es-VE', { timeZone: 'America/Caracas', dateStyle: 'medium', timeStyle: 'short' });

  let DOCTOR = null;

  if (!DOC || !TOKEN) { $('gate').style.display = 'block'; }
  else { boot(); }

  document.querySelectorAll('.ptab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.ptab').forEach((x) => x.classList.remove('on'));
    document.querySelectorAll('.pane').forEach((x) => x.classList.remove('on'));
    t.classList.add('on'); $('pane-' + t.dataset.pane).classList.add('on');
  }));
  $('patSearch').addEventListener('input', (e) => renderPatients(e.target.value));

  async function boot() {
    const me = await api(`/doctors/me?doc=${encodeURIComponent(DOC)}&t=${encodeURIComponent(TOKEN)}`).catch(() => ({}));
    if (!me.ok) { $('gate').style.display = 'block'; $('gate').querySelector('p').textContent = 'El enlace no es válido o expiró. Vuelve a registrarte.'; return; }
    DOCTOR = me.doctor; $('app').style.display = 'block';
    $('docName').textContent = 'Dr(a). ' + DOCTOR.full_name;
    $('docWho').textContent = specL(DOCTOR.specialty) + (DOCTOR.country ? ' · ' + DOCTOR.country : '') + (DOCTOR.verified ? ' · ✔ Verificado' : '');
    await Promise.all([loadAppointments(), loadAvailability(), loadPatients()]);
  }

  // ---------- Pacientes (registry derived from appointments) ----------
  let PATIENTS = [];
  async function loadPatients() {
    const res = await api(`/panel/patients?doc=${encodeURIComponent(DOC)}&t=${encodeURIComponent(TOKEN)}`).catch(() => ({ items: [] }));
    PATIENTS = res.items || [];
    $('c_pat').textContent = PATIENTS.length;
    renderPatients('');
  }
  function renderPatients(q) {
    const term = q.trim().toLowerCase();
    const list = term ? PATIENTS.filter((p) => `${p.full_name || ''} ${p.cedula || ''}`.toLowerCase().includes(term)) : PATIENTS;
    if (!list.length) { $('patList').innerHTML = `<div class="empty">${PATIENTS.length ? 'Sin coincidencias.' : 'Aún no tienes pacientes.'}</div>`; return; }
    $('patList').innerHTML = list.map((p) => {
      const sub = [p.cedula ? 'CI ' + esc(p.cedula) : '', p.age != null ? esc(p.age) + ' años' : '', esc(p.gender || ''), esc(p.location || '')].filter(Boolean).join(' · ');
      const contact = [p.email, p.phone].filter(Boolean).join(' · ');
      return `<div class="prow">
        <div class="flex justify-between items-start gap-3 flex-wrap">
          <div class="min-w-0"><div class="font-display font-extrabold text-[15px] text-on-surface">${esc(p.full_name || '—')}</div>
          ${sub ? `<div class="text-[12.5px] text-on-surface-variant mt-0.5">${sub}</div>` : ''}
          ${contact ? `<div class="text-[12.5px] text-on-surface-variant">${esc(contact)}</div>` : ''}</div>
          <div class="text-right"><div class="font-display font-extrabold text-lg text-primary tabnum">${p.visits}</div><div class="text-[10.5px] uppercase tracking-wide text-on-surface-variant">visita${p.visits === 1 ? '' : 's'}</div></div>
        </div>
        <div class="flex flex-wrap gap-2 mt-2"><button class="tm-btn tm-btn-ghost" data-pkey="${esc(p.pkey)}">Ver historial</button></div>
        <div class="ws" id="hist-${esc(p.pkey)}" style="display:none"></div>
      </div>`;
    }).join('');
    $('patList').querySelectorAll('button[data-pkey]').forEach((b) => b.addEventListener('click', () => {
      const box = $('hist-' + b.dataset.pkey);
      if (box.style.display === 'none') { box.style.display = 'block'; loadHistory(b.dataset.pkey, box); }
      else box.style.display = 'none';
    }));
  }
  async function loadHistory(pkey, box) {
    box.innerHTML = '<div class="empty">Cargando historial…</div>';
    const res = await api(`/panel/patients/${encodeURIComponent(pkey)}/history?doc=${encodeURIComponent(DOC)}&t=${encodeURIComponent(TOKEN)}`).catch(() => ({ visits: [] }));
    const v = res.visits || [];
    if (!v.length) { box.innerHTML = '<div class="text-[13px] text-on-surface-variant py-2">Sin visitas.</div>'; return; }
    box.innerHTML = `<div class="rounded-lg border border-outline-variant/60 bg-surface p-3 mt-1">${v.map((a) => `<div class="wsnote"><div class="flex justify-between gap-2 flex-wrap"><span class="font-display font-bold text-[13.5px] text-on-surface">${esc(a.type_label)} ${badge(a.status)}</span><span class="text-[12px] text-on-surface-variant tabnum">${tFmt(a.start_ms)}</span></div>${a.reason ? `<div class="text-[13px] text-on-surface mt-1">${esc(a.reason)}</div>` : ''}</div>`).join('')}</div>`;
  }

  // ---------- Citas ----------
  async function loadAppointments() {
    const res = await api(`/panel/appointments?doc=${encodeURIComponent(DOC)}&t=${encodeURIComponent(TOKEN)}`).catch(() => ({ items: [] }));
    const items = res.items || [];
    const today = caracasToday();
    $('c_appts').textContent = items.length;
    $('s_next').textContent = items.filter((a) => !TERMINAL.includes(a.status) && a.start_ms >= Date.now()).length;
    $('s_today').textContent = items.filter((a) => a.date === today && !TERMINAL.includes(a.status)).length;
    $('s_done').textContent = items.filter((a) => a.status === 'completed').length;

    const active = items.filter((a) => !TERMINAL.includes(a.status));
    const past = items.filter((a) => TERMINAL.includes(a.status)).reverse();
    renderCal(active.filter((a) => a.status !== 'cancelled'));
    if (!items.length) { $('pane-appts').innerHTML = '<div class="empty">Aún no tienes citas. Publica tu <b>disponibilidad</b> para que los pacientes puedan agendar.</div>'; return; }
    $('pane-appts').innerHTML = (active.length ? active.map(apptRow).join('') : '<div class="empty">No tienes citas activas.</div>') +
      (past.length ? `<h3 class="font-display font-bold text-base text-on-surface mt-7 mb-3">Historial</h3>${past.map(apptRow).join('')}` : '');
    wireApptButtons();
  }

  function apptRow(a) {
    const term = TERMINAL.includes(a.status);
    const contact = [a.patient_email, a.patient_phone].filter(Boolean).join(' · ');
    const acts = ACTIONS[a.status] || [];
    let btns = '';
    if (!term && a.video_url) btns += `<a class="tm-btn tm-btn-primary" href="${esc(a.video_url)}" target="_blank" rel="noopener">🎥 Entrar</a>`;
    btns += acts.map(([to, label, cls]) => `<button class="tm-btn tm-btn-${cls}" data-id="${esc(a.id)}" data-to="${to}">${label}</button>`).join('');
    if (!term) btns += `<a class="tm-btn tm-btn-ghost" href="/api/telemedicina/appt/${esc(a.id)}/ics?t=${encodeURIComponent(TOKEN)}">.ics</a>`;
    if (a.status !== 'cancelled') btns += `<button class="tm-btn tm-btn-primary" data-ws="${esc(a.id)}">📋 Consulta</button>`;
    return `<div class="prow ${term ? 'term' : ''}">
      <div class="flex justify-between items-start gap-3 flex-wrap">
        <div class="min-w-0"><div class="font-display font-extrabold text-[15px] text-on-surface">${esc(a.patient_name)} ${badge(a.status)}</div>
        <div class="text-[12.5px] text-on-surface-variant mt-0.5">${esc(typeL(a.appt_type))} · ${esc(specL(a.specialty))}${contact ? ' · ' + esc(contact) : ''}</div></div>
        <div class="text-[12.5px] text-on-surface-variant text-right tabnum">${tFmt(a.start_ms)}</div>
      </div>
      ${(() => { const d = [a.patient_cedula ? 'CI ' + esc(a.patient_cedula) : '', a.patient_age != null ? esc(a.patient_age) + ' años' : '', esc(a.patient_gender || ''), esc(a.patient_location || '')].filter(Boolean).join(' · '); return d ? `<div class="text-[12.5px] text-on-surface mt-2 font-medium">${d}</div>` : ''; })()}
      ${a.reason ? `<div class="text-[13.5px] text-on-surface mt-2 leading-relaxed whitespace-pre-wrap">${esc(a.reason)}</div>` : ''}
      ${a.insurance_provider ? `<div class="text-[12.5px] text-on-surface-variant mt-1.5">Seguro: ${esc(a.insurance_provider)}</div>` : ''}
      <div class="flex flex-wrap gap-2 mt-3">${btns}</div>
      <div class="ws" id="ws-${esc(a.id)}" style="display:none"></div>
    </div>`;
  }

  function wireApptButtons() {
    $('pane-appts').querySelectorAll('button.tm-btn[data-to]').forEach((b) => b.addEventListener('click', async () => {
      const to = b.dataset.to;
      if ((to === 'cancelled' || to === 'no_show') && !confirm(`¿Marcar la cita como "${ST_LABEL[to]}"?`)) return;
      b.disabled = true;
      const res = await api(`/panel/appointments/${encodeURIComponent(b.dataset.id)}/status`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doctor_id: DOC, token: TOKEN, status: to }),
      }).catch(() => ({}));
      if (!res.ok) { b.disabled = false; alert(res.hint || res.error || 'No se pudo actualizar.'); return; }
      loadAppointments();
    }));
    $('pane-appts').querySelectorAll('button[data-ws]').forEach((b) => b.addEventListener('click', () => {
      const box = $('ws-' + b.dataset.ws);
      if (box.style.display === 'none') { box.style.display = 'block'; openWorkspace(b.dataset.ws, box); }
      else { box.style.display = 'none'; }
    }));
  }

  // ---------- Clinical consult workspace ----------
  const CHECKS = [['receta_emitida', 'Récipe emitido'], ['requiere_seguimiento', 'Requiere seguimiento'], ['referido_presencial', 'Referido a atención presencial']];
  async function openWorkspace(id, box) {
    box.innerHTML = '<div class="empty">Cargando consulta…</div>';
    const r = await api(`/panel/appointment/${encodeURIComponent(id)}?doc=${encodeURIComponent(DOC)}&t=${encodeURIComponent(TOKEN)}`).catch(() => ({}));
    if (!r.ok) { box.innerHTML = '<div class="msg err">No se pudo abrir la consulta.</div>'; return; }
    const ck = r.consult.checklist || {};
    const notesHtml = (r.notes || []).map((n) => `<div class="wsnote"><div class="text-[12px] text-on-surface-variant tabnum">${tFmt(n.at_ms)}</div><div class="text-[13.5px] text-on-surface whitespace-pre-wrap">${esc(n.body)}</div></div>`).join('') || '<div class="text-[13px] text-on-surface-variant">Sin notas todavía.</div>';
    const rxHtml = (r.prescriptions || []).map((p) => `<div class="wsnote"><div class="text-[12px] text-on-surface-variant tabnum">Emitido ${tFmt(p.issued_ms)}</div>${p.items.map((it) => `<div class="text-[13.5px] text-on-surface"><b>${esc(it.med)}</b>${it.dose ? ' · ' + esc(it.dose) : ''}${it.freq ? ' · ' + esc(it.freq) : ''}${it.duration ? ' · ' + esc(it.duration) : ''}${it.notes ? ' — ' + esc(it.notes) : ''}</div>`).join('')}${p.notes ? `<div class="text-[12.5px] text-on-surface-variant mt-1">${esc(p.notes)}</div>` : ''}</div>`).join('') || '<div class="text-[13px] text-on-surface-variant">Aún no has emitido récipe.</div>';
    const fileUrl = (fid) => `/api/telemedicina/appt/${encodeURIComponent(id)}/file/${encodeURIComponent(fid)}?t=${encodeURIComponent(TOKEN)}`;
    const filesHtml = (r.files || []).length ? `<div class="flex flex-wrap gap-2">${r.files.map((f) => (f.content_type || '').startsWith('image/')
      ? `<a href="${fileUrl(f.id)}" target="_blank" rel="noopener" title="${esc(f.filename || '')}"><img src="${fileUrl(f.id)}" alt="${esc(f.caption || f.filename || '')}" style="width:72px;height:72px;object-fit:cover;border-radius:8px;border:1px solid var(--line)"></a>`
      : `<a class="tm-btn tm-btn-ghost" href="${fileUrl(f.id)}" target="_blank" rel="noopener">📄 ${esc((f.filename || 'Documento').slice(0, 24))}</a>`).join('')}</div>` : '<div class="text-[13px] text-on-surface-variant">Sin archivos.</div>';
    box.innerHTML = `
      <div class="rounded-lg border border-outline-variant/60 bg-surface p-4 mt-1">
        <h4 class="font-display font-extrabold text-[15px] text-on-surface mb-2">Historia clínica <span class="font-normal text-on-surface-variant text-xs">· registro auditado</span></h4>
        <div class="wslist mb-3">${notesHtml}</div>
        <textarea class="fld" id="wsnote-${id}" placeholder="Escribe la nota de evolución / historia…"></textarea>
        <button class="tm-btn tm-btn-go mt-2" id="wsaddnote-${id}">Agregar nota</button>

        <h4 class="font-display font-extrabold text-[15px] text-on-surface mt-5 mb-2">Resumen y plan</h4>
        <div class="flex flex-wrap gap-2 mb-2">${CHECKS.map(([k, l]) => `<label class="chk"><input type="checkbox" class="wschk" value="${k}" ${ck[k] ? 'checked' : ''}> ${l}</label>`).join('')}</div>
        <textarea class="fld" id="wssummary-${id}" placeholder="Indicaciones / plan para el paciente (esto lo verá el paciente)…">${esc(r.consult.summary || '')}</textarea>
        <button class="tm-btn tm-btn-go mt-2" id="wssave-${id}">Guardar resumen</button>

        <h4 class="font-display font-extrabold text-[15px] text-on-surface mt-5 mb-1">Récipe / Indicación médica</h4>
        <p class="text-[12px] text-on-surface-variant mb-2">Registro informativo con traza de auditoría — no sustituye una receta médica legal.</p>
        <div class="wslist mb-3">${rxHtml}</div>
        <div id="wsmeds-${id}"></div>
        <button class="tm-btn tm-btn-ghost mt-2" id="wsaddmed-${id}">+ Medicamento</button>
        <textarea class="fld mt-2" id="wsrxnotes-${id}" placeholder="Notas de la indicación (opcional)…"></textarea>
        <button class="tm-btn tm-btn-done mt-2" id="wsissue-${id}">Emitir récipe</button>
        <div class="msg" id="wsmsg-${id}"></div>

        <h4 class="font-display font-extrabold text-[15px] text-on-surface mt-5 mb-2">Archivos (fotos / documentos)</h4>
        <div class="mb-3">${filesHtml}</div>
        <label class="tm-btn tm-btn-ghost" style="cursor:pointer">Adjuntar archivo<input type="file" id="wsfile-${id}" accept="image/jpeg,image/png,image/webp,application/pdf" style="display:none"></label>
        <div class="msg" id="wsfmsg-${id}"></div>
      </div>`;
    const meds = $('wsmeds-' + id);
    const addMed = () => { const row = document.createElement('div'); row.className = 'wsmed flex flex-wrap gap-2 mb-2'; row.innerHTML = `<input class="fld flex-1 min-w-[140px] m-med" placeholder="Medicamento"><input class="fld w-[110px] m-dose" placeholder="Dosis"><input class="fld w-[120px] m-freq" placeholder="Frecuencia"><input class="fld w-[110px] m-dur" placeholder="Duración">`; meds.appendChild(row); };
    addMed();
    $('wsaddmed-' + id).onclick = addMed;
    $('wsaddnote-' + id).onclick = async () => {
      const body = $('wsnote-' + id).value.trim(); if (!body) return;
      $('wsaddnote-' + id).disabled = true;
      await api(`/panel/appointment/${encodeURIComponent(id)}/note`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doctor_id: DOC, token: TOKEN, body }) }).catch(() => {});
      openWorkspace(id, box);
    };
    $('wssave-' + id).onclick = async () => {
      const checklist = {}; box.querySelectorAll('.wschk').forEach((c) => { checklist[c.value] = c.checked; });
      const summary = $('wssummary-' + id).value;
      const msg = $('wsmsg-' + id); $('wssave-' + id).disabled = true;
      const res = await api(`/panel/appointment/${encodeURIComponent(id)}/consult`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doctor_id: DOC, token: TOKEN, summary, checklist }) }).catch(() => ({}));
      $('wssave-' + id).disabled = false; msg.className = res.ok ? 'msg ok' : 'msg err'; msg.textContent = res.ok ? '✓ Resumen guardado.' : 'No se pudo guardar.';
    };
    $('wsissue-' + id).onclick = async () => {
      const items = [...box.querySelectorAll('.wsmed')].map((row) => ({ med: row.querySelector('.m-med').value.trim(), dose: row.querySelector('.m-dose').value.trim(), freq: row.querySelector('.m-freq').value.trim(), duration: row.querySelector('.m-dur').value.trim() })).filter((it) => it.med);
      const msg = $('wsmsg-' + id);
      if (!items.length) { msg.className = 'msg err'; msg.textContent = 'Agrega al menos un medicamento.'; return; }
      $('wsissue-' + id).disabled = true;
      const res = await api(`/panel/appointment/${encodeURIComponent(id)}/prescription`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doctor_id: DOC, token: TOKEN, items, notes: $('wsrxnotes-' + id).value.trim() }) }).catch(() => ({}));
      if (!res.ok) { $('wsissue-' + id).disabled = false; msg.className = 'msg err'; msg.textContent = res.hint || 'No se pudo emitir.'; return; }
      openWorkspace(id, box);
    };
    $('wsfile-' + id).onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      const fmsg = $('wsfmsg-' + id); fmsg.className = 'msg ok'; fmsg.textContent = 'Subiendo…';
      const fd = new FormData(); fd.append('file', file); fd.append('doctor_id', DOC); fd.append('token', TOKEN);
      const res = await fetch(`/api/telemedicina/panel/appointment/${encodeURIComponent(id)}/files`, { method: 'POST', body: fd }).then((x) => x.json()).catch(() => ({}));
      if (!res.ok) { fmsg.className = 'msg err'; fmsg.textContent = res.hint || 'No se pudo subir.'; return; }
      openWorkspace(id, box);
    };
  }

  // ---------- Disponibilidad ----------
  async function loadAvailability() {
    const res = await api(`/panel/availability?doc=${encodeURIComponent(DOC)}&t=${encodeURIComponent(TOKEN)}`).catch(() => ({}));
    const prefs = res.prefs || { slot_minutes: 30, accepting: true, appt_types: TYPES.map((t) => t.key) };
    const weekly = res.weekly || [];
    $('av_accept').checked = !!prefs.accepting;
    $('av_slot').value = String(prefs.slot_minutes || 30);
    $('av_types').innerHTML = TYPES.map((t) => `<label class="chk"><input type="checkbox" class="avtype" value="${t.key}" ${(prefs.appt_types || []).includes(t.key) ? 'checked' : ''}> ${t.label}</label>`).join('');

    const byDay = {};
    weekly.forEach((w) => { if (byDay[w.weekday] == null) byDay[w.weekday] = w; });
    const cold = weekly.length === 0;
    $('av_days').innerHTML = DAY_ORDER.map((d) => {
      const w = byDay[d];
      const on = w ? true : (cold && d >= 1 && d <= 5);
      const from = w ? minToTime(w.start_min) : '09:00';
      const to = w ? minToTime(w.end_min) : '17:00';
      return `<div class="dayrow ${on ? '' : 'off'}" data-day="${d}">
        <label class="flex items-center gap-2 w-[120px]"><input type="checkbox" class="avday" ${on ? 'checked' : ''} style="accent-color:#00173a"> <span class="font-display font-bold text-[13px] text-on-surface">${DAY_NAMES[d]}</span></label>
        <span class="times flex items-center gap-2"><input class="fld w-[116px] avfrom" type="time" value="${from}"> <span class="text-on-surface-variant">–</span> <input class="fld w-[116px] avto" type="time" value="${to}"></span>
      </div>`;
    }).join('');
    $('av_days').querySelectorAll('.avday').forEach((c) => c.addEventListener('change', () => c.closest('.dayrow').classList.toggle('off', !c.checked)));

    $('setup').style.display = (weekly.length || !prefs.accepting) ? 'none' : 'block';
    renderBlocks(res.blocks || []);
  }

  $('av_save').addEventListener('click', async () => {
    const weekly = [];
    $('av_days').querySelectorAll('.dayrow').forEach((r) => {
      if (!r.querySelector('.avday').checked) return;
      const s = timeToMin(r.querySelector('.avfrom').value), e = timeToMin(r.querySelector('.avto').value);
      if (s != null && e != null && e > s) weekly.push({ weekday: +r.dataset.day, start_min: s, end_min: e });
    });
    const types = [...$('av_types').querySelectorAll('.avtype:checked')].map((c) => c.value);
    const msg = $('av_msg');
    $('av_save').disabled = true; msg.className = 'msg ok'; msg.textContent = 'Guardando…';
    const res = await api('/panel/availability', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doctor_id: DOC, token: TOKEN, slot_minutes: Number($('av_slot').value), accepting: $('av_accept').checked, appt_types: types, weekly }),
    }).catch(() => ({}));
    $('av_save').disabled = false;
    if (!res.ok) { msg.className = 'msg err'; msg.textContent = res.hint || 'No se pudo guardar.'; return; }
    msg.className = 'msg ok'; msg.textContent = `✓ Disponibilidad guardada (${res.windows} día(s) con horario). Los pacientes ya pueden agendar contigo.`;
    $('setup').style.display = res.windows ? 'none' : 'block';
  });

  function renderBlocks(blocks) {
    if (!blocks.length) { $('blk_list').innerHTML = '<div class="text-[13px] text-on-surface-variant py-2">Sin fechas bloqueadas.</div>'; return; }
    $('blk_list').innerHTML = blocks.map((b) => {
      const range = (b.start_min != null && b.end_min != null) ? `${minToTime(b.start_min)}–${minToTime(b.end_min)}` : 'Día completo';
      return `<div class="blkrow"><b>${esc(b.date)}</b> · ${range}${b.reason ? ' · ' + esc(b.reason) : ''}<button class="tm-btn tm-btn-danger ml-auto" data-blk="${esc(b.id)}" style="padding:6px 12px">Quitar</button></div>`;
    }).join('');
    $('blk_list').querySelectorAll('[data-blk]').forEach((btn) => btn.addEventListener('click', async () => {
      btn.disabled = true;
      await api(`/panel/blocks/${encodeURIComponent(btn.dataset.blk)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doctor_id: DOC, token: TOKEN }) }).catch(() => {});
      loadAvailability();
    }));
  }

  $('blk_add').addEventListener('click', async () => {
    const date = $('blk_date').value; const msg = $('blk_msg');
    if (!date) { msg.className = 'msg err'; msg.textContent = 'Elige una fecha.'; return; }
    const from = timeToMin($('blk_from').value), to = timeToMin($('blk_to').value);
    const body = { doctor_id: DOC, token: TOKEN, date };
    if (from != null && to != null) { body.start_min = from; body.end_min = to; }
    $('blk_add').disabled = true;
    const res = await api('/panel/blocks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => ({}));
    $('blk_add').disabled = false;
    if (!res.ok) { msg.className = 'msg err'; msg.textContent = res.hint || res.error || 'No se pudo bloquear.'; return; }
    msg.className = 'msg'; $('blk_date').value = ''; $('blk_from').value = ''; $('blk_to').value = '';
    loadAvailability();
  });

  // ---------- Calendario ----------
  function renderCal(appts) {
    $('c_cal').textContent = appts.length;
    if (!appts.length) { $('pane-cal').innerHTML = '<div class="empty">No tienes citas próximas.</div>'; return; }
    appts.sort((a, b) => a.start_ms - b.start_ms);
    let html = '', lastDay = '';
    for (const a of appts) {
      const day = new Date(a.start_ms).toLocaleDateString('es-VE', { timeZone: 'America/Caracas', weekday: 'long', day: 'numeric', month: 'long' });
      if (day !== lastDay) { html += `<div class="cal-day">${day}</div>`; lastDay = day; }
      html += `<div class="cal-item">
        <div class="flex gap-3 items-center"><div class="cal-time">${t12(a.time)}</div>
          <div><div class="font-display font-extrabold text-[15px] text-on-surface">${esc(a.patient_name)} ${badge(a.status)}</div><div class="text-[12.5px] text-on-surface-variant">${esc(typeL(a.appt_type))} · ${esc(specL(a.specialty))}</div></div></div>
        ${a.video_url ? `<a class="tm-btn tm-btn-primary" href="${esc(a.video_url)}" target="_blank" rel="noopener">🎥 Entrar</a>` : ''}
      </div>`;
    }
    $('pane-cal').innerHTML = html;
  }
})();
