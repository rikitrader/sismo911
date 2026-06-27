/* SISMO911 — shared volunteer skill taxonomy + classifier.
   ONE source of truth used by both /voluntarios (directory + header counts) and
   /voluntario (profile page). Loaded as a plain script: defines window.VOL.

   Registered volunteers carry explicit skill keys. RAV "se ofreció" reports are
   free text with NO skills field, so deriveSkills() infers tags from the title +
   description by keyword. Header counts and card tags both run through this, so the
   numbers shown ALWAYS match the data on the page (no separate stats source).      */
(function (g) {
  // key → [emoji, label]. Order here is the display/priority order.
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

  // The "main data" buckets the hero header reports, each an OR over skill keys.
  // Keeping this here means the header numbers are derived from the same tags as
  // the cards — change a keyword once and both update together.
  var GROUPS = {
    medico: ['medico', 'primeros_auxilios'],
    rescate: ['rescate', 'busqueda'],
    logistica: ['logistica', 'transporte'],
  };

  // Accent-insensitive keyword → skill matchers. Each skill lists substrings; if any
  // appears in the normalized text, the skill is tagged. Spanish + common variants.
  var KW = {
    medico: ['medic', 'enfermer', 'doctor', 'doctora', 'paramedic', 'salud', 'hospital', 'farmac', 'odontolog', 'pediatr', 'cirujan'],
    primeros_auxilios: ['primeros auxilios', 'rcp', 'cruz roja', 'soporte vital', 'triage', 'triaje'],
    rescate: ['rescate', 'usar', 'rescatista', 'busqueda y rescate', 'escombros', 'bombero', 'bomber'],
    busqueda: ['busqueda', 'localiz', 'desaparecid', 'dron', 'drone', 'rastreo'],
    logistica: ['logistic', 'almacen', 'acopio', 'inventario', 'distribuc', 'coordina', 'suministr', 'bodega'],
    transporte: ['transport', 'conductor', 'chofer', 'camion', 'vehiculo', 'moto', 'traslad', 'flete', 'carga'],
    construccion: ['construc', 'albañil', 'albanil', 'obrero', 'estructur', 'demolic', 'ingenier civil', 'maestro de obra'],
    electricidad: ['electric', 'electricista', 'cablead', 'planta electr', 'generador'],
    plomeria: ['plomer', 'fontaner', 'tuberia', 'tuberias', 'gasfiter'],
    cocina: ['cocin', 'aliment', 'comida', 'chef', 'olla', 'panader', 'reposter'],
    psicologia: ['psicolog', 'psicosocial', 'apoyo emocional', 'salud mental', 'consejer', 'terapeuta'],
    traduccion: ['traduc', 'traductor', 'interpret', 'idioma', 'ingles', 'english', 'frances', 'portugues'],
    comunicaciones: ['comunicacion', 'radio', 'radioaficion', 'telecomunic', 'antena', 'periodist', 'prensa'],
    tecnologia: ['informatic', 'tecnolog', 'sistemas', 'programad', 'software', 'desarrollad', 'datos', 'digitaliz', 'computad', 'web', 'soporte tecnico', 'soporte', 'it ', 'ti '],
    agua_saneamiento: ['agua', 'saneamiento', 'potabiliz', 'higiene', 'sanitari', 'pozo', 'cisterna'],
    veterinario: ['veterinari', 'mascota', 'animal', 'rescate animal', 'perro', 'gato'],
    donaciones: ['donacion', 'donar', 'donativ', 'recolecta', 'recaud', 'ropa', 'viveres', 'viver'],
  };

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  // Derive skill keys from free text. Returns an array of SK keys (deduped, in SK
  // display order). Falls back to ['general'] so every volunteer carries ≥1 tag.
  function deriveSkills(text) {
    var t = norm(text);
    var hit = {};
    for (var key in KW) {
      var list = KW[key];
      for (var i = 0; i < list.length; i++) {
        if (t.indexOf(list[i]) !== -1) { hit[key] = true; break; }
      }
    }
    var out = [];
    for (var k in SK) { if (hit[k]) out.push(k); }
    return out.length ? out : ['general'];
  }

  // Normalize one record (registered OR RAV) to a common card/profile model and
  // attach its skill tags. RAV rows have no skills → derive from title+notes+area.
  function normalize(rec) {
    var isRav = rec.source === 'rav' || rec.__rav === true;
    var skills = Array.isArray(rec.skills) ? rec.skills.slice() : [];
    if (!skills.length) skills = deriveSkills([rec.full_name, rec.notes, rec.experience, rec.area].filter(Boolean).join(' '));
    return {
      id: rec.id,
      source: isRav ? 'rav' : 'registered',
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

  // Count the three hero buckets + total over a normalized list.
  function statsFromData(rows) {
    var counts = {}; var groups = { total: rows.length, medico: 0, rescate: 0, logistica: 0 };
    for (var i = 0; i < rows.length; i++) {
      var sk = rows[i].skills || [];
      var seenG = {};
      for (var j = 0; j < sk.length; j++) {
        var key = sk[j];
        counts[key] = (counts[key] || 0) + 1;
        for (var gk in GROUPS) { if (!seenG[gk] && GROUPS[gk].indexOf(key) !== -1) { groups[gk]++; seenG[gk] = true; } }
      }
    }
    return { total: groups.total, groups: groups, counts: counts };
  }

  g.VOL = { SK: SK, AV: AV, GROUPS: GROUPS, deriveSkills: deriveSkills, normalize: normalize, statsFromData: statsFromData };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
