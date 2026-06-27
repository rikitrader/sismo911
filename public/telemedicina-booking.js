/* SISMO911 Telemedicina — patient booking wizard + appointment status tracker.
   Flow: specialty → doctor → type → date → slot → reason → insurance(FREE) →
   confirm. Talks to /api/telemedicina (v2: catalog, book/*, appt ics). */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const api = (p, opts) => fetch('/api/telemedicina' + p, opts).then((r) => r.json());
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const SPECS = {
    general: 'Medicina general', pediatria: 'Pediatría', medicina_interna: 'Medicina interna',
    cardiologia: 'Cardiología', ginecologia: 'Ginecología', traumatologia: 'Traumatología',
    psicologia: 'Psicología', psiquiatria: 'Psiquiatría', dermatologia: 'Dermatología',
    neurologia: 'Neurología', nutricion: 'Nutrición', enfermeria: 'Enfermería', farmacia: 'Farmacia', otra: 'Otra',
  };
  const SPEC_ICON = {
    general: '🩺', pediatria: '🧒', medicina_interna: '🫀', cardiologia: '❤️', ginecologia: '🤰',
    traumatologia: '🦴', psicologia: '🧠', psiquiatria: '🧠', dermatologia: '🧴', neurologia: '🧠',
    nutricion: '🥗', enfermeria: '💉', farmacia: '💊', otra: '➕',
  };
  const specLabel = (k) => SPECS[k] || k;
  const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const DOW = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];

  const STEP_LABELS = ['Especialidad', 'Médico', 'Tipo', 'Fecha', 'Hora', 'Motivo', 'Pago', 'Confirmar'];
  let step = 0;
  let TYPES = []; // [{key,label,duration,icon}]
  const st = { specialty: null, doctor: null, type: null, date: null, slot: null };

  const caracasToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' }); // YYYY-MM-DD
  const fmtDate = (d) => { const [y, m, dd] = d.split('-').map(Number); return `${dd} de ${MONTHS[m - 1]} de ${y}`; };

  // ---------- Stepper ----------
  function renderStepper() {
    $('stepper').innerHTML = STEP_LABELS.map((lb, i) =>
      `<div class="stp ${i < step ? 'done' : ''} ${i === step ? 'cur' : ''}"><div class="dot">${i < step ? '✓' : i + 1}</div><div class="lb">${lb}</div></div>`).join('');
  }
  function show(i) {
    step = i;
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', +p.dataset.step === i));
    $('backBtn').style.visibility = i === 0 ? 'hidden' : 'visible';
    const nb = $('nextBtn');
    nb.style.display = (i === 0 || i === 1 || i === 2 || i === 3 || i === 4) ? 'none' : 'block'; // card-pick steps auto-advance
    nb.textContent = i === 7 ? 'Confirmar cita ✓' : 'Continuar →';
    renderStepper();
    refreshNext();
    window.scrollTo({ top: $('wizCard').offsetTop - 12, behavior: 'smooth' });
  }
  function refreshNext() {
    const nb = $('nextBtn');
    if (step === 5) nb.disabled = !($('f_name').value.trim() && ($('f_email').value.trim() || $('f_phone').value.trim()) && $('f_reason').value.trim().length >= 3);
    else if (step === 7) nb.disabled = false;
    else nb.disabled = false;
  }

  // ---------- Step 1: specialty ----------
  async function loadCatalog() {
    const cat = await api('/catalog').catch(() => ({ specialties: [], types: [] }));
    TYPES = cat.types || [];
    const specs = cat.specialties || [];
    const total = specs.reduce((a, s) => a + (s.n || 0), 0);
    $('h_docs').textContent = total; $('h_specs').textContent = specs.length;
    if (!specs.length) {
      $('specGrid').innerHTML = '<div class="empty">Aún no hay médicos con horarios publicados. Vuelve pronto, o si eres médico, regístrate abajo para abrir tu agenda.</div>';
      return;
    }
    $('specGrid').innerHTML = specs.map((s) =>
      `<button class="opt" data-spec="${s.specialty}"><div class="ic">${SPEC_ICON[s.specialty] || '🩺'}</div><div class="t">${esc(specLabel(s.specialty))}</div><div class="meta">${s.n} médico${s.n === 1 ? '' : 's'}</div></button>`).join('');
    $('specGrid').querySelectorAll('.opt').forEach((b) => b.addEventListener('click', () => {
      st.specialty = b.dataset.spec; st.doctor = null; st.type = null; st.date = null; st.slot = null;
      loadDoctors(); show(1);
    }));
  }

  // ---------- Step 2: doctor ----------
  async function loadDoctors() {
    $('docSub').textContent = `Especialidad: ${specLabel(st.specialty)}`;
    $('docGrid').innerHTML = '<div class="empty">Cargando médicos…</div>';
    const res = await api('/book/doctors?specialty=' + encodeURIComponent(st.specialty)).catch(() => ({ items: [] }));
    const items = res.items || [];
    if (!items.length) { $('docGrid').innerHTML = '<div class="empty">No hay médicos con horarios en esta especialidad ahora mismo.</div>'; return; }
    $('docGrid').innerHTML = items.map((d, i) => {
      const initials = (d.full_name || '?').split(/\s+/).slice(0, 2).map((x) => x[0]).join('').toUpperCase();
      const langs = (d.languages || []).join(', ').toUpperCase();
      return `<button class="opt" data-i="${i}"><div class="docrow"><div class="av">${esc(initials)}</div><div><div class="t">Dr(a). ${esc(d.full_name)}${d.verified ? '<span class="vchip">✓ Verificado</span>' : ''}</div><div class="d">${esc(specLabel(d.specialty))}${d.country ? ' · ' + esc(d.country) : ''}</div>${langs ? `<div class="meta">${esc(langs)}</div>` : ''}</div></div>${d.bio ? `<div class="d" style="margin-top:8px">${esc(d.bio).slice(0, 130)}</div>` : ''}</button>`;
    }).join('');
    $('docGrid').querySelectorAll('.opt').forEach((b) => b.addEventListener('click', () => {
      st.doctor = items[+b.dataset.i]; st.type = null; st.date = null; st.slot = null;
      loadTypes(); show(2);
    }));
  }

  // ---------- Step 3: appointment type ----------
  function loadTypes() {
    const allowed = (st.doctor && st.doctor.appt_types && st.doctor.appt_types.length) ? st.doctor.appt_types : TYPES.map((t) => t.key);
    const list = TYPES.filter((t) => allowed.includes(t.key));
    $('typeGrid').innerHTML = list.map((t) =>
      `<button class="opt" data-type="${t.key}"><div class="ic">${t.icon}</div><div class="t">${esc(t.label)}</div><div class="meta">${t.duration} min</div></button>`).join('');
    $('typeGrid').querySelectorAll('.opt').forEach((b) => b.addEventListener('click', () => {
      st.type = list.find((t) => t.key === b.dataset.type); st.date = null; st.slot = null;
      renderCal(); show(3);
    }));
  }

  // ---------- Step 4: calendar ----------
  let calCursor = null; // {y,m}
  function renderCal() {
    const today = caracasToday();
    if (!calCursor) { const [y, m] = today.split('-').map(Number); calCursor = { y, m: m - 1 }; }
    const { y, m } = calCursor;
    const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
    const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const maxDate = new Date(); maxDate.setDate(maxDate.getDate() + 60);
    const maxStr = maxDate.toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
    let cells = '';
    for (let i = 0; i < first; i++) cells += '<div></div>';
    for (let d = 1; d <= days; d++) {
      const ds = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const dis = ds < today || ds > maxStr;
      cells += `<button class="cald ${st.date === ds ? 'sel' : ''}" data-d="${ds}" ${dis ? 'disabled' : ''}>${d}</button>`;
    }
    $('cal').innerHTML =
      `<div class="calhead"><button id="calPrev">‹</button><div class="m">${MONTHS[m]} ${y}</div><button id="calNext">›</button></div>
       <div class="calgrid">${DOW.map((d) => `<div class="caldow">${d}</div>`).join('')}${cells}</div>`;
    const curYM = today.slice(0, 7);
    $('calPrev').disabled = `${y}-${String(m + 1).padStart(2, '0')}` <= curYM;
    $('calPrev').onclick = () => { calCursor = m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 }; renderCal(); };
    $('calNext').onclick = () => { calCursor = m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 }; renderCal(); };
    $('cal').querySelectorAll('.cald[data-d]').forEach((b) => b.addEventListener('click', () => {
      if (b.disabled) return; st.date = b.dataset.d; st.slot = null; loadSlots(); show(4);
    }));
  }

  // ---------- Step 5: slots ----------
  async function loadSlots() {
    $('slotSub').textContent = `${fmtDate(st.date)} · ${st.type.label} (${st.type.duration} min)`;
    $('slotGrid').innerHTML = '<div class="empty">Buscando horarios…</div>';
    const res = await api(`/book/doctors/${encodeURIComponent(st.doctor.id)}/slots?date=${st.date}&type=${st.type.key}`).catch(() => ({ slots: [] }));
    const slots = res.slots || [];
    if (!slots.length) {
      $('slotGrid').innerHTML = '<div class="empty">No hay horarios disponibles ese día.<br><button class="btn btn-ghost" id="reCal" style="margin-top:10px">Elegir otra fecha</button></div>';
      $('reCal').onclick = () => show(3); return;
    }
    $('slotGrid').innerHTML = slots.map((s, i) => `<button class="slot ${st.slot && st.slot.start_min === s.start_min ? 'sel' : ''}" data-i="${i}">${s.label}</button>`).join('');
    $('slotGrid').querySelectorAll('.slot').forEach((b) => b.addEventListener('click', () => {
      st.slot = slots[+b.dataset.i]; renderReview(); show(5);
    }));
  }

  // ---------- Step 8: review ----------
  function renderReview() {
    $('review').innerHTML = [
      ['Especialidad', specLabel(st.specialty)],
      ['Médico', 'Dr(a). ' + st.doctor.full_name],
      ['Tipo de cita', `${st.type.label} (${st.type.duration} min)`],
      ['Fecha', fmtDate(st.date)],
      ['Hora', `${st.slot.label} (hora de Venezuela)`],
      ['Paciente', $('f_name').value.trim() || '—'],
      ['Motivo', ($('f_reason').value.trim() || '—').slice(0, 120)],
      ['Costo', '✓ GRATIS — $0'],
    ].map(([k, v]) => `<div class="r"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join('');
  }

  // ---------- Navigation ----------
  $('nextBtn').addEventListener('click', () => {
    if (step === 5) { if ($('nextBtn').disabled) return; show(6); }
    else if (step === 6) { renderReview(); show(7); }
    else if (step === 7) submitBooking();
    else show(step + 1);
  });
  $('backBtn').addEventListener('click', () => { if (step > 0) show(step - 1); });
  ['f_name', 'f_email', 'f_phone', 'f_reason'].forEach((id) => $(id).addEventListener('input', refreshNext));

  async function submitBooking() {
    const nb = $('nextBtn'); nb.disabled = true; nb.innerHTML = '<span class="spin"></span> Agendando…';
    $('bookMsg').className = 'msg';
    try {
      const res = await api('/book/appointments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          doctor_id: st.doctor.id, appt_type: st.type.key, date: st.date, start_min: st.slot.start_min,
          specialty: st.specialty, patient_name: $('f_name').value.trim(),
          patient_email: $('f_email').value.trim(), patient_phone: $('f_phone').value.trim(),
          reason: $('f_reason').value.trim(), insurance_provider: $('f_ins').value.trim(),
          insurance_member_id: $('f_insid').value.trim(), preferred_lang: 'es',
        }),
      });
      if (!res.ok) {
        $('bookMsg').className = 'msg err'; $('bookMsg').textContent = res.hint || 'No se pudo agendar. Intenta con otro horario.';
        nb.disabled = false; nb.textContent = 'Confirmar cita ✓';
        if (res.error === 'slot_unavailable') { loadSlots(); show(4); }
        return;
      }
      renderDone(res);
    } catch (e) {
      $('bookMsg').className = 'msg err'; $('bookMsg').textContent = 'Error de red. Intenta de nuevo.';
      nb.disabled = false; nb.textContent = 'Confirmar cita ✓';
    }
  }

  function renderDone(res) {
    $('wizCard').style.display = 'none';
    const a = res.appointment;
    const track = '/telemedicina?cita=' + res.manage_token;
    $('doneCard').style.display = 'block';
    $('doneCard').innerHTML =
      `<div class="freebox"><div class="big">✓ ¡Cita agendada!</div><p>Te enviamos la confirmación por correo. Guarda el enlace de seguimiento para entrar a tu videoconsulta.</p></div>
       <div class="review">
         <div class="r"><span class="k">Médico</span><span class="v">Dr(a). ${esc(a.doctor_name)}</span></div>
         <div class="r"><span class="k">Tipo</span><span class="v">${esc(a.type_label)}</span></div>
         <div class="r"><span class="k">Cuándo</span><span class="v">${esc(a.when)}</span></div>
       </div>
       <div class="actrow">
         <a class="videobtn" href="${esc(track)}">📋 Ver y seguir mi cita</a>
         <a class="btn btn-ghost" style="text-decoration:none" href="${esc(a.ics_url)}">📅 Agregar al calendario</a>
       </div>
       <div class="note" style="margin-top:12px">Enlace de tu videollamada (también te llegó por correo): <a href="${esc(a.video_url)}" target="_blank" rel="noopener">${esc(a.video_url)}</a></div>`;
    history.replaceState(null, '', track);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ========== STATUS TRACKER ==========
  const ST_FLOW = ['scheduled', 'checked_in', 'waiting_room', 'in_progress', 'completed'];
  const ST_LABEL = {
    scheduled: 'Cita agendada', checked_in: 'Registrado (check-in)', waiting_room: 'En sala de espera',
    in_progress: 'En consulta', completed: 'Completada', cancelled: 'Cancelada', no_show: 'No asististe',
  };
  const ST_BADGE = {
    scheduled: ['#dcfce7', '#166534'], checked_in: ['#dbeafe', '#1e40af'], waiting_room: ['#fef3c7', '#92600a'],
    in_progress: ['#cffafe', '#0e7490'], completed: ['#e5e7eb', '#374151'], cancelled: ['#fee2e2', '#991b1b'], no_show: ['#fee2e2', '#991b1b'],
  };
  let trackTimer = null;

  async function loadTrack(token) {
    $('trackCard').style.display = 'block'; $('wizCard').style.display = 'none';
    const res = await api('/book/appointment/' + encodeURIComponent(token)).catch(() => ({}));
    if (!res.ok) { $('trackBox').innerHTML = '<div class="empty">No encontramos esa cita. Revisa el enlace.</div>'; return; }
    const a = res.appointment, hist = res.history || [];
    const at = {}; hist.forEach((h) => { if (at[h.status] == null) at[h.status] = h.at_ms; });
    const terminal = a.status === 'cancelled' || a.status === 'no_show';
    const curIdx = ST_FLOW.indexOf(a.status);
    const tFmt = (ms) => new Date(ms).toLocaleString('es-VE', { timeZone: 'America/Caracas', dateStyle: 'medium', timeStyle: 'short' });

    let timeline = '';
    ST_FLOW.forEach((s, i) => {
      const reached = at[s] != null;
      const cur = !terminal && s === a.status;
      const cls = cur ? 'cur' : (reached ? 'done' : 'pending');
      timeline += `<div class="tl ${cls}"><div class="mk">${reached && !cur ? '✓' : i + 1}</div><div><div class="ti">${ST_LABEL[s]}</div>${at[s] ? `<div class="tw">${tFmt(at[s])}</div>` : ''}</div></div>`;
    });
    if (terminal) timeline += `<div class="tl bad"><div class="mk">✕</div><div><div class="ti">${ST_LABEL[a.status]}</div>${at[a.status] ? `<div class="tw">${tFmt(at[a.status])}</div>` : ''}</div></div>`;

    const bd = ST_BADGE[a.status] || ['#e5e7eb', '#374151'];
    let actions = '';
    const canJoin = ['scheduled', 'checked_in', 'waiting_room', 'in_progress'].includes(a.status);
    if (canJoin && a.video_url) actions += `<a class="videobtn" href="${esc(a.video_url)}" target="_blank" rel="noopener">🎥 Entrar a la videoconsulta</a>`;
    if (a.status === 'scheduled') actions += `<button class="btn btn-go" data-act="checkin">Ya llegué (check-in)</button>`;
    if (a.status === 'checked_in') actions += `<button class="btn btn-go" data-act="waiting">Entrar a sala de espera</button>`;
    if (['scheduled', 'checked_in', 'waiting_room'].includes(a.status)) actions += `<button class="btn btn-ghost" data-act="cancel">Cancelar cita</button>`;
    actions += `<a class="btn btn-ghost" style="text-decoration:none" href="/api/telemedicina/appt/${esc(a.id)}/ics?t=${esc(a.manage_token)}">📅 Calendario</a>`;

    $('trackBox').innerHTML =
      `<div style="margin:10px 0"><span class="badge" style="background:${bd[0]};color:${bd[1]}">${ST_LABEL[a.status]}</span></div>
       <div class="kv"><span class="k">Médico</span><span class="v">Dr(a). ${esc(a.doctor_name || '—')}</span></div>
       <div class="kv"><span class="k">Especialidad</span><span class="v">${esc(specLabel(a.specialty))}</span></div>
       <div class="kv"><span class="k">Tipo</span><span class="v">${esc(a.type_label)}</span></div>
       <div class="kv"><span class="k">Cuándo</span><span class="v">${esc(a.when)}</span></div>
       <div class="actrow">${actions}</div>
       <h2 class="sec" style="margin:20px 0 6px;font-size:15px">Seguimiento</h2>
       <div class="timeline">${timeline}</div>`;

    $('trackBox').querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
      const act = b.dataset.act;
      if (act === 'cancel' && !confirm('¿Seguro que quieres cancelar tu cita?')) return;
      b.disabled = true;
      await api(`/book/appointment/${encodeURIComponent(token)}/${act}`, { method: 'POST' }).catch(() => {});
      loadTrack(token);
    }));

    clearTimeout(trackTimer);
    if (!terminal) trackTimer = setTimeout(() => loadTrack(token), 25000); // live-refresh until closed
  }

  // Legacy ?caso= (old request-queue cases) — best-effort read-only view.
  async function loadLegacyCaso(token) {
    $('trackCard').style.display = 'block'; $('wizCard').style.display = 'none';
    const res = await api('/request/' + encodeURIComponent(token)).catch(() => ({}));
    if (!res.ok) { $('trackBox').innerHTML = '<div class="empty">No encontramos esa solicitud.</div>'; return; }
    const r = res.request;
    let html = `<div class="kv"><span class="k">Paciente</span><span class="v">${esc(r.patient_name)}</span></div>
       <div class="kv"><span class="k">Especialidad</span><span class="v">${esc(specLabel(r.specialty))}</span></div>
       <div class="kv"><span class="k">Estado</span><span class="v">${esc(r.status)}</span></div>`;
    if (r.doctor_name) html += `<div class="kv"><span class="k">Médico</span><span class="v">Dr(a). ${esc(r.doctor_name)}</span></div>`;
    if (r.status === 'scheduled' && r.video_url) html += `<a class="videobtn" href="${esc(r.video_url)}" target="_blank" rel="noopener">🎥 Entrar a la videoconsulta</a>`;
    $('trackBox').innerHTML = html;
  }

  // ---------- Doctor registration (secondary) ----------
  $('d_spec').innerHTML = Object.entries(SPECS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('d_btn').addEventListener('click', async () => {
    const name = $('d_name').value.trim(), email = $('d_email').value.trim();
    const msg = $('d_msg');
    if (!name) { msg.className = 'msg err'; msg.textContent = 'Indica tu nombre.'; return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg.className = 'msg err'; msg.textContent = 'Indica un correo válido.'; return; }
    $('d_btn').disabled = true; msg.className = 'msg ok'; msg.textContent = 'Registrando…';
    try {
      const res = await api('/doctors/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: name, email, specialty: $('d_spec').value, country: $('d_country').value.trim(), license_no: $('d_lic').value.trim(), phone: $('d_phone').value.trim(), bio: $('d_bio').value.trim() }),
      });
      if (!res.ok) { msg.className = 'msg err'; msg.textContent = res.hint || 'No se pudo registrar.'; $('d_btn').disabled = false; return; }
      msg.className = 'msg ok';
      msg.innerHTML = '✓ ¡Registro completo! Te enviamos el enlace a tu panel por correo. Ábrelo para publicar tu disponibilidad:<br>';
      const link = document.createElement('a'); link.href = res.panel_url; link.className = 'videobtn'; link.textContent = 'Abrir mi panel médico →';
      msg.appendChild(link); $('d_btn').textContent = 'Registrado ✓';
    } catch { msg.className = 'msg err'; msg.textContent = 'Error de red. Intenta de nuevo.'; $('d_btn').disabled = false; }
  });

  // ---------- Boot ----------
  const qs = new URLSearchParams(location.search);
  const cita = qs.get('cita'), caso = qs.get('caso');
  if (cita) { loadTrack(cita); }
  else if (caso) { loadLegacyCaso(caso); }
  else { loadCatalog(); show(0); }
})();
