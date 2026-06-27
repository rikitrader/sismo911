// Canonical volunteer skill taxonomy + classifier — the SINGLE source of truth.
// The server derives every volunteer's skill tags here (RAV "se ofreció" reports
// carry no skills field, so tags are inferred from their free text), and computes
// the directory's exact totals/per-skill counts over the FULL dataset. The client
// only renders what this produces, so client and server can never disagree and the
// header counts stay accurate regardless of any fetch/pagination cap.

// Canonical skill keys, in display/priority order. Mirrored (labels only) by
// public/voluntarios-skills.js for rendering; a test asserts the key sets match.
export const SKILL_KEYS = [
  'medico', 'primeros_auxilios', 'rescate', 'busqueda', 'logistica', 'transporte',
  'construccion', 'electricidad', 'plomeria', 'cocina', 'psicologia', 'traduccion',
  'comunicaciones', 'tecnologia', 'agua_saneamiento', 'veterinario', 'donaciones', 'general',
] as const;

export type SkillKey = (typeof SKILL_KEYS)[number];

// The three buckets the hero header reports, each an OR over skill keys.
export const GROUPS: Record<'medico' | 'rescate' | 'logistica', SkillKey[]> = {
  medico: ['medico', 'primeros_auxilios'],
  rescate: ['rescate', 'busqueda'],
  logistica: ['logistica', 'transporte'],
};

export const AVAILABILITY = ['inmediata', 'dias', 'fines_de_semana', 'remoto'] as const;

// Accent-insensitive keyword → skill matchers (Spanish + common variants).
const KW: Record<Exclude<SkillKey, 'general'>, string[]> = {
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

function norm(s: unknown): string {
  return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Derive skill keys from free text. Returns keys in SKILL_KEYS display order,
// falling back to ['general'] so every volunteer carries at least one tag.
export function deriveSkills(text: unknown): SkillKey[] {
  const t = norm(text);
  const hit: Partial<Record<SkillKey, boolean>> = {};
  (Object.keys(KW) as Array<keyof typeof KW>).forEach((key) => {
    if (KW[key].some((kw) => t.indexOf(kw) !== -1)) hit[key] = true;
  });
  const out = SKILL_KEYS.filter((k) => hit[k]);
  return out.length ? out : ['general'];
}

// Validate/clean an explicit skills value (registered volunteers). Accepts an
// array, a JSON-array string (how the volunteers.skills column is stored), or a
// comma-separated string; returns canonical keys in SKILL_KEYS order.
export function cleanSkills(skills: unknown): SkillKey[] {
  let arr: unknown[];
  if (Array.isArray(skills)) {
    arr = skills;
  } else {
    const s = String(skills || '').trim();
    if (s.startsWith('[')) { try { const p = JSON.parse(s); arr = Array.isArray(p) ? p : []; } catch { arr = []; } }
    else arr = s.split(',');
  }
  const wanted = new Set(arr.map((s) => String(s).trim().toLowerCase()));
  return SKILL_KEYS.filter((k) => wanted.has(k));
}

export interface NormalizedVolunteer {
  id: string;
  source: 'registered' | 'rav';
  full_name: string;
  city: string; state: string; area: string;
  skills: SkillKey[];
  availability: string;
  has_vehicle: boolean; can_travel: boolean;
  experience: string; notes: string;
  contact_phone: string; email: string;
  photo_url: string; lat: number | null; lng: number | null;
  created_at: string | null;
}

// Flatten a registered or RAV DB row to the common model + attach skill tags.
export function normalizeRow(rec: any): NormalizedVolunteer {
  const isRav = rec.source === 'rav';
  let skills = cleanSkills(rec.skills);
  if (!skills.length) {
    skills = deriveSkills([rec.full_name, rec.notes, rec.experience, rec.area].filter(Boolean).join(' '));
  }
  return {
    id: rec.id,
    source: isRav ? 'rav' : 'registered',
    full_name: rec.full_name || 'Voluntario',
    city: rec.city || '', state: rec.state || '', area: rec.area || '',
    skills,
    availability: rec.availability || '',
    has_vehicle: !!rec.has_vehicle, can_travel: !!rec.can_travel,
    experience: rec.experience || '', notes: rec.notes || '',
    contact_phone: rec.contact_phone || '', email: rec.email || '',
    photo_url: rec.photo_url || '', lat: rec.lat ?? null, lng: rec.lng ?? null,
    created_at: rec.created_at || null,
  };
}

export interface DirectoryStats {
  total: number;
  groups: { total: number; medico: number; rescate: number; logistica: number };
  counts: Record<string, number>;
}

// Exact totals + per-skill + per-group counts over a normalized set.
export function statsFromRows(rows: NormalizedVolunteer[]): DirectoryStats {
  const counts: Record<string, number> = {};
  const groups = { total: rows.length, medico: 0, rescate: 0, logistica: 0 };
  for (const r of rows) {
    const seen: Record<string, boolean> = {};
    for (const key of r.skills) {
      counts[key] = (counts[key] || 0) + 1;
      (Object.keys(GROUPS) as Array<keyof typeof GROUPS>).forEach((gk) => {
        if (!seen[gk] && GROUPS[gk].includes(key)) { groups[gk]++; seen[gk] = true; }
      });
    }
  }
  return { total: groups.total, groups, counts };
}
