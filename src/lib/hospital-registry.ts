// Hospital patient registry helpers — parse the "Registro Maestro de Pacientes –
// Sismo Venezuela 2026" rows into clean, honest records. Pure functions (no DB),
// unit-tested. Status is PARSED per row from the free-text OBSERVACIONES — a
// deceased or discharged patient is NEVER counted as hospitalizado.

export type HospEstado = 'hospitalizado' | 'alta' | 'fallecido' | 'desconocido';

/** Normalize a name for matching (mirrors normName in routes/persons.ts:51). */
export function normName(s: string | null | undefined): string {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bare-digit cédula (Venezuelan ids are 5–9 digits). Returns '' if not a plausible id. */
export function cleanCedula(s: string | null | undefined): string {
  const d = String(s || '').replace(/\D/g, '');
  if (d.length < 5 || d.length > 9) return '';
  return d;
}

/** "APELLIDOS Y NOMBRES" often holds "/"-separated spelling variants. */
export function splitNameVariants(raw: string | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of String(raw || '').split(/\s*\/\s*/)) {
    const v = part.replace(/\s+/g, ' ').trim();
    const k = normName(v);
    if (v && k && !seen.has(k)) { seen.add(k); out.push(v); }
  }
  return out;
}

/**
 * Derive a clean status from OBSERVACIONES. Priority is deliberate: a row that
 * mentions death is fallecido even if it also says "internado" (conflict is
 * flagged separately); discharge (alta) beats hospitalized; otherwise any intake
 * signal → hospitalizado; else desconocido. NEVER guesses hospitalizado from a
 * blank cell.
 */
export function parseStatus(observaciones: string | null | undefined): { estado: HospEstado; conflict: boolean } {
  const o = String(observaciones || '').toLowerCase();
  const conflict = /conflicto/.test(o);
  let estado: HospEstado = 'desconocido';
  if (/fallec/.test(o)) estado = 'fallecido';
  else if (/\balta\b/.test(o)) estado = 'alta';
  else if (/internad|hospitaliz|\buci\b|\bupt\b|ingres|emergencia|servicio:/.test(o)) estado = 'hospitalizado';
  return { estado, conflict };
}

/** Stable per-patient key: cédula if present, else hospital|normalized-primary-name. */
export function dedupeKey(cedula: string, hospital: string | null | undefined, primaryNorm: string): string {
  if (cedula) return 'c:' + cedula;
  return 'n:' + normName(hospital) + '|' + primaryNorm;
}

export interface RawPatient {
  hospital?: string; nombre?: string; edad?: string | number; cedula?: string;
  telefono?: string; direccion?: string; observaciones?: string;
}
export interface PatientRow {
  dedupe_key: string; hospital: string; full_name: string; name_variants: string;
  norm_name: string; edad: string; cedula: string; telefono: string; direccion: string;
  estado: HospEstado; conflict: number; observaciones: string;
}

const clip = (v: unknown, n: number) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, n);

/** Normalize one raw spreadsheet row → a storable PatientRow (null if unusable). */
export function patientToRow(raw: RawPatient): PatientRow | null {
  const variants = splitNameVariants(raw.nombre);
  const full = variants[0] || clip(raw.nombre, 200);
  if (!full) return null;                       // a row with no name is not a patient
  const primaryNorm = normName(full);
  const cedula = cleanCedula(raw.cedula);
  const { estado, conflict } = parseStatus(raw.observaciones);
  return {
    dedupe_key: dedupeKey(cedula, raw.hospital, primaryNorm),
    hospital: clip(raw.hospital, 160),
    full_name: clip(full, 200),
    name_variants: JSON.stringify(variants.slice(0, 6)),
    norm_name: primaryNorm,
    edad: clip(raw.edad, 24),
    cedula,
    telefono: clip(raw.telefono, 40),
    direccion: clip(raw.direccion, 200),
    estado,
    conflict: conflict ? 1 : 0,
    observaciones: clip(raw.observaciones, 2000),
  };
}
