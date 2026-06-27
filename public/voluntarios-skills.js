/* SISMO911 — volunteer skill DISPLAY maps (client-side, presentation only).

   The authoritative classifier now lives server-side in src/lib/volunteer-skills.ts:
   the /api/voluntarios/directory and /profile endpoints derive every tag and compute
   all counts, so there is exactly ONE classifier and the client can never disagree
   with the server. This file only maps skill KEYS → emoji + label for rendering, plus
   the availability labels. No keyword logic lives here anymore.                       */
(function (g) {
  // key → [emoji, label]. Keys + order MUST match SKILL_KEYS in volunteer-skills.ts
  // (a server test guards the key set).
  var SK = {
    medico: ['🩺', 'Médico / Enfermería'],
    primeros_auxilios: ['⛑️', 'Primeros auxilios'],
    rescate: ['🧗', 'Rescate / USAR'],
    busqueda: ['🔦', 'Búsqueda'],
    logistica: ['📦', 'Logística'],
    transporte: ['🚚', 'Transporte / Conductor'],
    construccion: ['🧱', 'Construcción'],
    electricidad: ['⚡', 'Electricidad'],
    plomeria: ['🔧', 'Plomería'],
    cocina: ['🍲', 'Cocina / Alimentación'],
    psicologia: ['🧠', 'Apoyo psicológico'],
    traduccion: ['🗣️', 'Traducción / Idiomas'],
    comunicaciones: ['📡', 'Comunicaciones / Radio'],
    tecnologia: ['💻', 'Tecnología / Datos'],
    agua_saneamiento: ['🚰', 'Agua / Saneamiento'],
    veterinario: ['🐾', 'Veterinario / Mascotas'],
    donaciones: ['🎁', 'Donaciones / Acopio'],
    general: ['🙋', 'Voluntario general'],
  };

  var AV = { inmediata: 'De inmediato', dias: 'En pocos días', fines_de_semana: 'Fines de semana', remoto: 'Solo remoto' };

  // Light presentation passthrough for a server record. Skills ALWAYS come from the
  // server (already derived); we only normalize field names + provide safe defaults.
  // No keyword classification here — that is the server's job.
  function normalize(rec) {
    rec = rec || {};
    var skills = Array.isArray(rec.skills) ? rec.skills : [];
    if (!skills.length) skills = ['general'];
    return {
      id: rec.id,
      source: rec.source === 'rav' ? 'rav' : 'registered',
      full_name: rec.full_name || 'Voluntario',
      city: rec.city || '', state: rec.state || '', area: rec.area || '',
      skills: skills,
      availability: rec.availability || '',
      has_vehicle: !!rec.has_vehicle, can_travel: !!rec.can_travel,
      experience: rec.experience || '', notes: rec.notes || '',
      contact_phone: rec.contact_phone || '', email: rec.email || '',
      photo_url: rec.photo_url || '', lat: rec.lat, lng: rec.lng,
      created_at: rec.created_at || null,
    };
  }

  g.VOL = { SK: SK, AV: AV, normalize: normalize };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
