/* SISMO911 Telemedicina — patient booking wizard + appointment status tracker.
   Flow: specialty → doctor → type → date → slot → reason → insurance(FREE) →
   confirm. Talks to /api/telemedicina (v2). Styled strictly with the SISMO911
   design system (navy/crimson tokens + .tm-* component classes). */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const api = (p, opts) => fetch('/api/telemedicina' + p, opts).then((r) => r.json());
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const svg = (inner, sw) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw || 1.8}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

  const ICON = {
    pulse: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    video: '<rect x="2.5" y="6" width="12" height="12" rx="2"/><path d="M14.5 10l5-2.3A1 1 0 0 1 21 8.6v6.8a1 1 0 0 1-1.5.9l-5-2.3"/>',
    followup: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    urgent: '<path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
    mental: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/>',
    refill: '<path d="M10.5 20.5 3.5 13.5a4.95 4.95 0 0 1 7-7l7 7a4.95 4.95 0 0 1-7 7z"/><path d="M8.5 6.5l9 9"/>',
  };
  const typeIcon = (k) => svg(ICON[{ video: 'video', followup: 'followup', urgent: 'urgent', mental_health: 'mental', refill: 'refill' }[k]] || ICON.pulse);

  const SPECS = {
    general: 'Medicina general', pediatria: 'Pediatría', medicina_interna: 'Medicina interna', cardiologia: 'Cardiología',
    ginecologia: 'Ginecología', traumatologia: 'Traumatología', psicologia: 'Psicología', psiquiatria: 'Psiquiatría',
    dermatologia: 'Dermatología', neurologia: 'Neurología', nutricion: 'Nutrición', enfermeria: 'Enfermería', farmacia: 'Farmacia', otra: 'Otra',
  };
  const specLabel = (k) => SPECS[k] || k;
  const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const DOW = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];

  const STEP_LABELS = ['Especialidad', 'Médico', 'Tipo', 'Fecha', 'Hora', 'Motivo', 'Pago', 'Confirmar'];
  let step = 0;
  let TYPES = [];
  const st = { specialty: null, doctor: null, type: null, date: null, slot: null };

  const caracasToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
  const fmtDate = (d) => { const [y, m, dd] = d.split('-').map(Number); return `${dd} de ${MONTHS[m - 1]} de ${y}`; };

  // ---------- Stepper ----------
  function renderStepper() {
    $('stepper').innerHTML = STEP_LABELS.map((lb, i) =>
      `<div class="tm-step ${i < step ? 'done' : ''} ${i === step ? 'cur' : ''}"><div class="tm-dot">${i < step ? '✓' : i + 1}</div><div class="tm-lb">${lb}</div></div>`).join('');
  }
  function show(i) {
    step = i;
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', +p.dataset.step === i));
    $('backBtn').style.visibility = i === 0 ? 'hidden' : 'visible';
    const nb = $('nextBtn');
    nb.style.display = [0, 1, 2, 3, 4].includes(i) ? 'none' : 'inline-flex'; // card-pick steps auto-advance
    nb.textContent = i === 7 ? 'Confirmar cita ✓' : 'Continuar →';
    renderStepper();
    refreshNext();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function refreshNext() {
    const nb = $('nextBtn');
    if (step === 5) nb.disabled = !($('f_name').value.trim() && ($('f_email').value.trim() || $('f_phone').value.trim()) && $('f_reason').value.trim().length >= 3);
    else nb.disabled = false;
  }

  // ---------- 1 specialty ----------
  async function loadCatalog() {
    const cat = await api('/catalog').catch(() => ({ specialties: [], types: [] }));
    TYPES = cat.types || [];
    const specs = cat.specialties || [];
    if (!specs.length) {
      $('specGrid').innerHTML = '<div class="empty">Aún no hay médicos con horarios publicados. Vuelve pronto, o si eres médico, regístrate abajo para abrir tu agenda.</div>';
      return;
    }
    $('specGrid').innerHTML = specs.map((s) =>
      `<button class="tm-opt" data-spec="${s.specialty}"><div class="tm-ic">${svg(ICON.pulse)}</div><div class="t">${esc(specLabel(s.specialty))}</div><div class="meta">${s.n} médico${s.n === 1 ? '' : 's'}</div></button>`).join('');
    $('specGrid').querySelectorAll('.tm-opt').forEach((b) => b.addEventListener('click', () => {
      st.specialty = b.dataset.spec; st.doctor = null; st.type = null; st.date = null; st.slot = null;
      loadDoctors(); show(1);
    }));
  }

  // ---------- 2 doctor ----------
  async function loadDoctors() {
    $('docSub').textContent = `Especialidad: ${specLabel(st.specialty)}`;
    $('docGrid').innerHTML = '<div class="empty">Cargando médicos…</div>';
    const res = await api('/book/doctors?specialty=' + encodeURIComponent(st.specialty)).catch(() => ({ items: [] }));
    const items = res.items || [];
    if (!items.length) { $('docGrid').innerHTML = '<div class="empty">No hay médicos con horarios en esta especialidad ahora mismo.</div>'; return; }
    $('docGrid').innerHTML = items.map((d, i) => {
      const initials = (d.full_name || '?').split(/\s+/).slice(0, 2).map((x) => x[0]).join('').toUpperCase();
      const langs = (d.languages || []).join(' · ').toUpperCase();
      const vchip = d.verified ? '<span class="inline-block ml-1.5 align-middle px-1.5 py-0.5 rounded-full bg-safe/10 text-safe text-[10px] font-extrabold uppercase tracking-wide">✓ Verificado</span>' : '';
      return `<button class="tm-opt" data-i="${i}"><div class="flex items-start gap-3"><div class="av">${esc(initials)}</div><div class="min-w-0"><div class="t">Dr(a). ${esc(d.full_name)}${vchip}</div><div class="d">${esc(specLabel(d.specialty))}${d.country ? ' · ' + esc(d.country) : ''}</div>${langs ? `<div class="meta mt-0.5">${esc(langs)}</div>` : ''}</div></div>${d.bio ? `<div class="d mt-1">${esc(d.bio).slice(0, 120)}</div>` : ''}</button>`;
    }).join('');
    $('docGrid').querySelectorAll('.tm-opt').forEach((b) => b.addEventListener('click', () => {
      st.doctor = items[+b.dataset.i]; st.type = null; st.date = null; st.slot = null;
      loadTypes(); show(2);
    }));
  }

  // ---------- 3 type ----------
  function loadTypes() {
    const allowed = (st.doctor && st.doctor.appt_types && st.doctor.appt_types.length) ? st.doctor.appt_types : TYPES.map((t) => t.key);
    const list = TYPES.filter((t) => allowed.includes(t.key));
    $('typeGrid').innerHTML = list.map((t) =>
      `<button class="tm-opt" data-type="${t.key}"><div class="tm-ic">${typeIcon(t.key)}</div><div class="t">${esc(t.label)}</div><div class="meta">${t.duration} min</div></button>`).join('');
    $('typeGrid').querySelectorAll('.tm-opt').forEach((b) => b.addEventListener('click', () => {
      st.type = list.find((t) => t.key === b.dataset.type); st.date = null; st.slot = null;
      renderCal(); show(3);
    }));
  }

  // ---------- 4 calendar ----------
  let calCursor = null;
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
      cells += `<button class="tm-cald ${st.date === ds ? 'sel' : ''}" data-d="${ds}" ${dis ? 'disabled' : ''}>${d}</button>`;
    }
    const navBtn = 'w-9 h-9 rounded-lg border border-outline-variant/60 bg-white text-primary text-lg leading-none hover:bg-surface-container disabled:opacity-30 disabled:cursor-default';
    $('cal').innerHTML =
      `<div class="flex items-center justify-between mb-3"><button id="calPrev" class="${navBtn}">‹</button>
         <div class="font-display font-bold text-base text-on-surface capitalize">${MONTHS[m]} ${y}</div>
         <button id="calNext" class="${navBtn}">›</button></div>
       <div class="calgrid">${DOW.map((d) => `<div class="caldow">${d}</div>`).join('')}${cells}</div>`;
    const curYM = today.slice(0, 7);
    $('calPrev').disabled = `${y}-${String(m + 1).padStart(2, '0')}` <= curYM;
    $('calPrev').onclick = () => { calCursor = m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 }; renderCal(); };
    $('calNext').onclick = () => { calCursor = m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 }; renderCal(); };
    $('cal').querySelectorAll('.tm-cald[data-d]').forEach((b) => b.addEventListener('click', () => {
      if (b.disabled) return; st.date = b.dataset.d; st.slot = null; loadSlots(); show(4);
    }));
  }

  // ---------- 5 slots ----------
  async function loadSlots() {
    $('slotSub').textContent = `${fmtDate(st.date)} · ${st.type.label} (${st.type.duration} min)`;
    $('slotGrid').innerHTML = '<div class="empty">Buscando horarios…</div>';
    const res = await api(`/book/doctors/${encodeURIComponent(st.doctor.id)}/slots?date=${st.date}&type=${st.type.key}`).catch(() => ({ slots: [] }));
    const slots = res.slots || [];
    if (!slots.length) {
      $('slotGrid').innerHTML = '<div class="empty">No hay horarios disponibles ese día.<br><button class="tm-btn tm-btn-ghost mt-3" id="reCal">Elegir otra fecha</button></div>';
      $('reCal').onclick = () => show(3); return;
    }
    $('slotGrid').innerHTML = slots.map((s, i) => `<button class="tm-slot ${st.slot && st.slot.start_min === s.start_min ? 'sel' : ''}" data-i="${i}">${s.label}</button>`).join('');
    $('slotGrid').querySelectorAll('.tm-slot').forEach((b) => b.addEventListener('click', () => {
      st.slot = slots[+b.dataset.i]; renderReview(); show(5);
    }));
  }

  // ---------- review ----------
  function reviewRow(k, v, accent) {
    return `<div class="flex justify-between gap-3 px-4 py-2.5 border-b border-outline-variant/40 text-sm last:border-b-0"><span class="text-on-surface-variant">${k}</span><span class="font-semibold text-right ${accent || ''}">${esc(v)}</span></div>`;
  }
  function renderReview() {
    $('review').innerHTML =
      reviewRow('Especialidad', specLabel(st.specialty)) +
      reviewRow('Médico', 'Dr(a). ' + st.doctor.full_name) +
      reviewRow('Tipo de cita', `${st.type.label} (${st.type.duration} min)`) +
      reviewRow('Fecha', fmtDate(st.date)) +
      reviewRow('Hora', `${st.slot.label} (hora de Venezuela)`) +
      reviewRow('Paciente', $('f_name').value.trim() || '—') +
      reviewRow('Motivo', ($('f_reason').value.trim() || '—').slice(0, 120)) +
      reviewRow('Costo', 'GRATIS — $0', 'text-safe');
  }

  // ---------- nav ----------
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
      `<div class="flex items-start gap-3 mb-5">
         <span class="flex items-center justify-center w-11 h-11 rounded-full bg-safe/10 text-safe flex-shrink-0">${svg('<path d="M20 6 9 17l-5-5"/>', 2.4)}</span>
         <div><h2 class="font-display font-extrabold text-2xl text-on-surface leading-tight">¡Cita agendada!</h2><p class="text-sm text-on-surface-variant mt-0.5">Te enviamos la confirmación por correo. Guarda el enlace de seguimiento para entrar a tu videoconsulta.</p></div>
       </div>
       <div class="rounded-lg border border-outline-variant/60 overflow-hidden mb-5">
         ${reviewRow('Médico', 'Dr(a). ' + a.doctor_name)}${reviewRow('Tipo', a.type_label)}${reviewRow('Cuándo', a.when)}
       </div>
       <div class="flex flex-wrap gap-3">
         <a class="tm-btn tm-btn-primary" href="${esc(track)}">Ver y seguir mi cita</a>
         <a class="tm-btn tm-btn-ghost" href="${esc(a.ics_url)}">Agregar al calendario</a>
       </div>
       <p class="text-xs text-on-surface-variant mt-4">Enlace de tu videollamada (también te llegó por correo): <a class="text-primary font-semibold underline break-all" href="${esc(a.video_url)}" target="_blank" rel="noopener">${esc(a.video_url)}</a></p>`;
    history.replaceState(null, '', track);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ========== STATUS TRACKER ==========
  const ST_FLOW = ['scheduled', 'checked_in', 'waiting_room', 'in_progress', 'completed'];
  const ST_LABEL = { scheduled: 'Cita agendada', checked_in: 'Registrado (check-in)', waiting_room: 'En sala de espera', in_progress: 'En consulta', completed: 'Completada', cancelled: 'Cancelada', no_show: 'No asististe' };
  const ST_CLS = { scheduled: 'bg-safe/10 text-safe', checked_in: 'bg-primary/10 text-primary', waiting_room: 'bg-warning/10 text-warning', in_progress: 'bg-secondary/10 text-secondary', completed: 'bg-surface-container text-on-surface-variant', cancelled: 'bg-critical/10 text-critical', no_show: 'bg-critical/10 text-critical' };
  const badge = (s) => `<span class="inline-block px-2.5 py-1 rounded-full text-[11px] font-extrabold uppercase tracking-wide ${ST_CLS[s] || 'bg-surface-container text-on-surface-variant'}">${ST_LABEL[s] || s}</span>`;
  let trackTimer = null;

  async function loadTrack(token) {
    $('trackCard').style.display = 'block'; $('wizCard').style.display = 'none';
    const res = await api('/book/appointment/' + encodeURIComponent(token)).catch(() => ({}));
    if (!res.ok) { $('trackBox').innerHTML = '<div class="empty">No encontramos esa cita. Revisa el enlace.</div>'; return; }
    const a = res.appointment, hist = res.history || [];
    const at = {}; hist.forEach((h) => { if (at[h.status] == null) at[h.status] = h.at_ms; });
    const terminal = a.status === 'cancelled' || a.status === 'no_show';
    const tFmt = (ms) => new Date(ms).toLocaleString('es-VE', { timeZone: 'America/Caracas', dateStyle: 'medium', timeStyle: 'short' });

    let timeline = '';
    ST_FLOW.forEach((s, i) => {
      const reached = at[s] != null;
      const cur = !terminal && s === a.status;
      const cls = cur ? 'cur' : (reached ? 'done' : 'pending');
      timeline += `<div class="tm-tl ${cls}"><div class="tm-mk">${reached && !cur ? '✓' : i + 1}</div><div><div class="ti">${ST_LABEL[s]}</div>${at[s] ? `<div class="tw tabnum">${tFmt(at[s])}</div>` : ''}</div></div>`;
    });
    if (terminal) timeline += `<div class="tm-tl bad"><div class="tm-mk">✕</div><div><div class="ti">${ST_LABEL[a.status]}</div>${at[a.status] ? `<div class="tw tabnum">${tFmt(at[a.status])}</div>` : ''}</div></div>`;

    const canJoin = ['scheduled', 'checked_in', 'waiting_room', 'in_progress'].includes(a.status);
    let actions = '';
    if (canJoin && a.video_url) actions += `<a class="tm-btn tm-btn-primary" href="${esc(a.video_url)}" target="_blank" rel="noopener">🎥 Entrar a la videoconsulta</a>`;
    if (a.status === 'scheduled') actions += `<button class="tm-btn tm-btn-ghost" data-act="checkin">Ya llegué (check-in)</button>`;
    if (a.status === 'checked_in') actions += `<button class="tm-btn tm-btn-ghost" data-act="waiting">Entrar a sala de espera</button>`;
    if (['scheduled', 'checked_in', 'waiting_room'].includes(a.status)) actions += `<button class="tm-btn tm-btn-danger" data-act="cancel">Cancelar cita</button>`;
    actions += `<a class="tm-btn tm-btn-ghost" href="/api/telemedicina/appt/${esc(a.id)}/ics?t=${esc(a.manage_token)}">Calendario</a>`;

    $('trackBox').innerHTML =
      `<div class="mb-4">${badge(a.status)}</div>
       <div class="rounded-lg border border-outline-variant/60 p-4 mb-5">
         <div class="kv"><span class="k">Médico</span><span class="v">Dr(a). ${esc(a.doctor_name || '—')}</span></div>
         <div class="kv"><span class="k">Especialidad</span><span class="v">${esc(specLabel(a.specialty))}</span></div>
         <div class="kv"><span class="k">Tipo</span><span class="v">${esc(a.type_label)}</span></div>
         <div class="kv"><span class="k">Cuándo</span><span class="v tabnum">${esc(a.when)}</span></div>
       </div>
       <div class="flex flex-wrap gap-3">${actions}</div>
       <h3 class="font-display font-bold text-base text-on-surface mt-7 mb-3">Seguimiento</h3>
       <div class="timeline">${timeline}</div>`;

    $('trackBox').querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
      const act = b.dataset.act;
      if (act === 'cancel' && !confirm('¿Seguro que quieres cancelar tu cita?')) return;
      b.disabled = true;
      await api(`/book/appointment/${encodeURIComponent(token)}/${act}`, { method: 'POST' }).catch(() => {});
      loadTrack(token);
    }));

    // Live-refresh is quota-frugal: poll every 60s only when updates matter.
    clearTimeout(trackTimer);
    const todayCaracas = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
    const liveState = ['checked_in', 'waiting_room', 'in_progress'].includes(a.status);
    if (!terminal && (liveState || a.date === todayCaracas)) trackTimer = setTimeout(() => loadTrack(token), 60000);
  }

  // Legacy ?caso= (old request-queue) — read-only.
  async function loadLegacyCaso(token) {
    $('trackCard').style.display = 'block'; $('wizCard').style.display = 'none';
    const res = await api('/request/' + encodeURIComponent(token)).catch(() => ({}));
    if (!res.ok) { $('trackBox').innerHTML = '<div class="empty">No encontramos esa solicitud.</div>'; return; }
    const r = res.request;
    let html = `<div class="rounded-lg border border-outline-variant/60 p-4"><div class="kv"><span class="k">Paciente</span><span class="v">${esc(r.patient_name)}</span></div>
       <div class="kv"><span class="k">Especialidad</span><span class="v">${esc(specLabel(r.specialty))}</span></div>
       <div class="kv"><span class="k">Estado</span><span class="v">${esc(r.status)}</span></div></div>`;
    if (r.status === 'scheduled' && r.video_url) html += `<a class="tm-btn tm-btn-primary mt-4" href="${esc(r.video_url)}" target="_blank" rel="noopener">🎥 Entrar a la videoconsulta</a>`;
    $('trackBox').innerHTML = html;
  }

  // ---------- Doctor registration ----------
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
      const link = document.createElement('a'); link.href = res.panel_url; link.className = 'tm-btn tm-btn-primary mt-2'; link.textContent = 'Abrir mi panel médico →';
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
