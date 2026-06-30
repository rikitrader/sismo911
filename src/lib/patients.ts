// Patient registry + medical-case workflow — the bridge that "attaches" the
// telemedicina data to the public /casos system inside the single sismo911 D1.
//
// Two ideas:
//   1. Every consult REGISTERS a patient once (patients table, deduped by
//      cédula → email → phone) and links the appointment/request to it.
//   2. Every consult is FOLLOWED UP as a medical case (patient_cases) with a
//      lifecycle + an append-only timeline (patient_case_events), and the case
//      can optionally be linked to a public case file (persons / personas / rav).
//
// Pure helpers (status enums, dedup-key selection, status mapping) are exported
// for unit testing; the DB functions are best-effort and must never throw in a
// way that breaks the patient-facing booking flow (callers wrap in try/catch).

import type { Env } from '../types';
import { uid } from './db';
import { normalizeCedula } from './identity';

// ── Status model ────────────────────────────────────────────────────────────
export const CASE_STATUSES = ['abierto', 'en_consulta', 'seguimiento', 'resuelto', 'cancelado'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];
const TERMINAL: ReadonlySet<string> = new Set(['resuelto', 'cancelado']);

export function isCaseStatus(s: string): s is CaseStatus {
  return (CASE_STATUSES as readonly string[]).includes(s);
}
export function isTerminalCase(s: string): boolean {
  return TERMINAL.has(s);
}

export const CASE_PRIORITIES = ['baja', 'normal', 'alta', 'critica'] as const;

// ── Patient intake shape ────────────────────────────────────────────────────
export interface PatientIntake {
  full_name: string;
  cedula?: string | null;
  email?: string | null;
  phone?: string | null;
  dob?: string | null;
  gender?: string | null;
  state?: string | null;
  city?: string | null;
}

const normPhone = (p?: string | null) => String(p || '').replace(/[^0-9]/g, '');
const normEmail = (e?: string | null) => String(e || '').trim().toLowerCase();

/**
 * Pick the dedup key for a patient: a normalized cédula (≥6 digits) wins, else a
 * normalized email, else a normalized phone. Returns null for an anonymous intake.
 */
export function dedupKey(intake: PatientIntake): { field: 'cedula' | 'email' | 'phone'; value: string } | null {
  const ced = normalizeCedula(intake.cedula || '');
  if (ced.length >= 6) return { field: 'cedula', value: ced };
  const email = normEmail(intake.email);
  if (email.includes('@')) return { field: 'email', value: email };
  const phone = normPhone(intake.phone);
  if (phone.length >= 7) return { field: 'phone', value: phone };
  return null;
}

/**
 * Map a telemed appointment status to a medical-case action.
 * `status` null means "log the event, don't change the case status".
 */
export function caseActionForApptStatus(
  apptStatus: string,
  requiereSeguimiento: boolean,
): { status: CaseStatus | null; kind: string } {
  switch (apptStatus) {
    case 'in_progress':
      return { status: 'en_consulta', kind: 'consult_started' };
    case 'completed':
      return { status: requiereSeguimiento ? 'seguimiento' : 'resuelto', kind: 'completed' };
    case 'no_show':
      return { status: null, kind: 'no_show' };
    case 'cancelled':
      return { status: null, kind: 'cancelled' };
    case 'checked_in':
      return { status: null, kind: 'checked_in' };
    case 'waiting_room':
      return { status: null, kind: 'waiting_room' };
    default:
      return { status: null, kind: 'status_change' };
  }
}

// ── Patient registry ────────────────────────────────────────────────────────
interface PatientRow {
  id: string; cedula: string | null; full_name: string; email: string | null;
  phone: string | null; dob: string | null; gender: string | null;
  state: string | null; city: string | null; person_id: string | null;
}

async function findPatient(env: Env, key: { field: string; value: string }): Promise<PatientRow | null> {
  const col = key.field; // 'cedula' | 'email' | 'phone' — fixed enum, never user-supplied
  return env.DB.prepare(
    `SELECT id, cedula, full_name, email, phone, dob, gender, state, city, person_id FROM patients WHERE ${col} = ? LIMIT 1`,
  ).bind(key.value).first<PatientRow>().catch(() => null);
}

/**
 * Register (or enrich) a patient. Returns the patient id + whether a row was
 * created. Enriches blank fields on an existing record without overwriting data.
 */
export async function upsertPatient(env: Env, intake: PatientIntake): Promise<{ id: string; created: boolean }> {
  const now = Date.now();
  const ced = normalizeCedula(intake.cedula || '');
  const cedula = ced.length >= 6 ? ced : null;
  const email = normEmail(intake.email) || null;
  const phone = normPhone(intake.phone) ? String(intake.phone).trim() : null;
  const full = String(intake.full_name || '').trim().slice(0, 120) || 'Paciente';

  const key = dedupKey(intake);
  const existing = key ? await findPatient(env, key) : null;

  if (existing) {
    // Fill blanks only; keep the latest non-empty name.
    const merged = {
      cedula: existing.cedula || cedula,
      full_name: full || existing.full_name,
      email: existing.email || email,
      phone: existing.phone || phone,
      dob: existing.dob || (intake.dob || null),
      gender: existing.gender || (intake.gender || null),
      state: existing.state || (intake.state || null),
      city: existing.city || (intake.city || null),
    };
    await env.DB.prepare(
      `UPDATE patients SET cedula=?, full_name=?, email=?, phone=?, dob=?, gender=?, state=?, city=?, updated_ms=? WHERE id=?`,
    ).bind(merged.cedula, merged.full_name, merged.email, merged.phone, merged.dob, merged.gender, merged.state, merged.city, now, existing.id).run();
    return { id: existing.id, created: false };
  }

  const id = uid('pat');
  await env.DB.prepare(
    `INSERT INTO patients (id, cedula, full_name, email, phone, dob, gender, state, city, person_id, notes, created_ms, updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, cedula, full, email, phone, intake.dob || null, intake.gender || null, intake.state || null, intake.city || null, null, null, now, now).run();
  return { id, created: true };
}

// ── Medical case ────────────────────────────────────────────────────────────
export interface CaseOpts {
  specialty?: string | null;
  doctorId?: string | null;
  priority?: string | null;
  appointmentId?: string | null;
  personId?: string | null;
}

/**
 * Return the patient's current OPEN (non-terminal) case, opening a new one if
 * none exists. Reuses an open case so a patient is never split across cases.
 */
export async function openOrUpdateCase(env: Env, patientId: string, opts: CaseOpts = {}): Promise<{ id: string; created: boolean }> {
  const now = Date.now();
  const open = await env.DB.prepare(
    `SELECT id, status FROM patient_cases WHERE patient_id = ? AND status NOT IN ('resuelto','cancelado') ORDER BY opened_ms DESC LIMIT 1`,
  ).bind(patientId).first<{ id: string; status: string }>().catch(() => null);

  if (open) {
    await env.DB.prepare(
      `UPDATE patient_cases SET specialty=COALESCE(specialty,?), assigned_doctor_id=COALESCE(assigned_doctor_id,?), updated_ms=?, last_activity_ms=? WHERE id=?`,
    ).bind(opts.specialty || null, opts.doctorId || null, now, now, open.id).run();
    return { id: open.id, created: false };
  }

  const id = uid('mcase');
  const priority = (CASE_PRIORITIES as readonly string[]).includes(String(opts.priority)) ? String(opts.priority) : 'normal';
  await env.DB.prepare(
    `INSERT INTO patient_cases (id, patient_id, status, priority, specialty, assigned_doctor_id, opening_appointment_id, person_id, summary, opened_ms, updated_ms, last_activity_ms, closed_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, patientId, 'abierto', priority, opts.specialty || null, opts.doctorId || null, opts.appointmentId || null, opts.personId || null, null, now, now, now, null).run();
  return { id, created: true };
}

export interface EventOpts { appointmentId?: string | null; detail?: string | null; actor?: string | null; }

/** Append an event to a case's timeline and bump its activity timestamp. */
export async function recordCaseEvent(env: Env, caseId: string, kind: string, opts: EventOpts = {}): Promise<string> {
  const now = Date.now();
  const id = uid('pce');
  await env.DB.prepare(
    `INSERT INTO patient_case_events (id, case_id, kind, appointment_id, detail, actor, at_ms) VALUES (?,?,?,?,?,?,?)`,
  ).bind(id, caseId, kind, opts.appointmentId || null, opts.detail || null, opts.actor || null, now).run();
  await env.DB.prepare(`UPDATE patient_cases SET last_activity_ms=?, updated_ms=? WHERE id=?`).bind(now, now, caseId).run();
  return id;
}

/**
 * Set a case status (validated). Sets closed_ms on terminal states. Does NOT log
 * an event — callers record the semantic event so the timeline has exactly one
 * entry per action (e.g. `completed`, `consult_started`, `status_change`).
 */
export async function setCaseStatus(env: Env, caseId: string, status: CaseStatus): Promise<boolean> {
  if (!isCaseStatus(status)) return false;
  const now = Date.now();
  const closed = isTerminalCase(status) ? now : null;
  await env.DB.prepare(`UPDATE patient_cases SET status=?, updated_ms=?, last_activity_ms=?, closed_ms=COALESCE(?, closed_ms) WHERE id=?`)
    .bind(status, now, now, closed, caseId).run();
  return true;
}

/**
 * Reflect a telemed appointment status change onto the patient's open medical
 * case: advance the case status when warranted and append a timeline event.
 * Best-effort: returns the case id touched, or null if the appointment has no
 * registered patient / open case yet.
 */
export async function syncCaseFromAppointmentStatus(
  env: Env, appointmentId: string, apptStatus: string, actor: string | null = null,
): Promise<string | null> {
  const appt = await env.DB.prepare(`SELECT patient_id FROM telemed_appointments WHERE id = ?`)
    .bind(appointmentId).first<{ patient_id: string | null }>().catch(() => null);
  if (!appt?.patient_id) return null;
  const open = await env.DB.prepare(
    `SELECT id FROM patient_cases WHERE patient_id = ? AND status NOT IN ('resuelto','cancelado') ORDER BY opened_ms DESC LIMIT 1`,
  ).bind(appt.patient_id).first<{ id: string }>().catch(() => null);
  if (!open) return null;

  let requiereSeguimiento = false;
  if (apptStatus === 'completed') {
    const consult = await env.DB.prepare(`SELECT checklist FROM telemed_consults WHERE appointment_id = ?`)
      .bind(appointmentId).first<{ checklist: string | null }>().catch(() => null);
    if (consult?.checklist) { try { requiereSeguimiento = !!JSON.parse(consult.checklist)?.requiere_seguimiento; } catch { /* ignore */ } }
  }
  const action = caseActionForApptStatus(apptStatus, requiereSeguimiento);
  if (action.status) await setCaseStatus(env, open.id, action.status);
  await recordCaseEvent(env, open.id, action.kind, { appointmentId, detail: action.status, actor });
  return open.id;
}

// ── The booking-time workflow hook ──────────────────────────────────────────
export interface ConsultRegistration {
  appointmentId: string;
  kind: 'appointment' | 'request';
  patient_name: string;
  patient_cedula?: string | null;
  patient_email?: string | null;
  patient_phone?: string | null;
  patient_dob?: string | null;
  patient_gender?: string | null;
  patient_state?: string | null;
  patient_city?: string | null;
  specialty?: string | null;
  doctor_id?: string | null;
}

/**
 * Run the full bridge for a new consult: register the patient, link the
 * appointment/request to it, open (or reuse) a medical case, and log `booked`.
 */
export async function registerConsultPatient(env: Env, r: ConsultRegistration): Promise<{ patientId: string; caseId: string }> {
  const { id: patientId } = await upsertPatient(env, {
    full_name: r.patient_name,
    cedula: r.patient_cedula,
    email: r.patient_email,
    phone: r.patient_phone,
    dob: r.patient_dob,
    gender: r.patient_gender,
    state: r.patient_state,
    city: r.patient_city,
  });

  const table = r.kind === 'request' ? 'telemed_requests' : 'telemed_appointments';
  await env.DB.prepare(`UPDATE ${table} SET patient_id=? WHERE id=?`).bind(patientId, r.appointmentId).run();

  const { id: caseId } = await openOrUpdateCase(env, patientId, {
    specialty: r.specialty, doctorId: r.doctor_id, appointmentId: r.appointmentId,
  });
  await recordCaseEvent(env, caseId, 'booked', { appointmentId: r.appointmentId, detail: r.specialty || null, actor: 'system' });
  return { patientId, caseId };
}

/**
 * Append a timeline event to the open medical case behind an appointment, looking
 * up patient → open case. Best-effort: no-ops if there is no registered patient /
 * open case. Used by note / prescription handlers to enrich the follow-up trail.
 */
export async function recordCaseEventForAppointment(
  env: Env, appointmentId: string, kind: string, opts: Omit<EventOpts, 'appointmentId'> = {},
): Promise<string | null> {
  const appt = await env.DB.prepare(`SELECT patient_id FROM telemed_appointments WHERE id = ?`)
    .bind(appointmentId).first<{ patient_id: string | null }>().catch(() => null);
  if (!appt?.patient_id) return null;
  const open = await env.DB.prepare(
    `SELECT id FROM patient_cases WHERE patient_id = ? AND status NOT IN ('resuelto','cancelado') ORDER BY opened_ms DESC LIMIT 1`,
  ).bind(appt.patient_id).first<{ id: string }>().catch(() => null);
  if (!open) return null;
  return recordCaseEvent(env, open.id, kind, { ...opts, appointmentId });
}

/** Attach a patient (and its open case) to a public case file (persons/personas/rav id). */
export async function linkPatientToPerson(env: Env, patientId: string, personId: string, actor: string | null = null): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(`UPDATE patients SET person_id=?, updated_ms=? WHERE id=?`).bind(personId, now, patientId).run();
  const open = await env.DB.prepare(
    `SELECT id, status FROM patient_cases WHERE patient_id = ? AND status NOT IN ('resuelto','cancelado') ORDER BY opened_ms DESC LIMIT 1`,
  ).bind(patientId).first<{ id: string }>().catch(() => null);
  if (open) {
    await env.DB.prepare(`UPDATE patient_cases SET person_id=?, updated_ms=? WHERE id=?`).bind(personId, now, open.id).run();
    await recordCaseEvent(env, open.id, 'linked_person', { detail: personId, actor });
  }
}
