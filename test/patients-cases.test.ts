import { describe, it, expect } from 'vitest';
import {
  CASE_STATUSES, isCaseStatus, isTerminalCase, dedupKey, caseActionForApptStatus,
  upsertPatient, openOrUpdateCase, recordCaseEvent, registerConsultPatient, linkPatientToPerson,
  syncCaseFromAppointmentStatus,
} from '../src/lib/patients';

// Programmable D1 stub: records run() calls and answers first() per table.
function makeEnv(rows: Record<string, any> = {}) {
  const runs: { sql: string; binds: any[] }[] = [];
  const firstFor = (sql: string) => {
    if (/FROM patients WHERE cedula/.test(sql)) return rows.patientByCedula ?? null;
    if (/FROM patients WHERE email/.test(sql)) return rows.patientByEmail ?? null;
    if (/FROM patients WHERE phone/.test(sql)) return rows.patientByPhone ?? null;
    if (/FROM patient_cases WHERE patient_id/.test(sql)) return rows.openCase ?? null;
    if (/FROM telemed_appointments WHERE id/.test(sql)) return rows.appt ?? null;
    if (/FROM telemed_consults WHERE appointment_id/.test(sql)) return rows.consult ?? null;
    return null;
  };
  const stmt = (sql: string, binds: any[] = []): any => ({
    bind: (...n: any[]) => stmt(sql, n),
    first: async () => firstFor(sql),
    all: async () => ({ results: [] }),
    run: async () => { runs.push({ sql, binds }); return { meta: { changes: 1 } }; },
  });
  const env: any = { DB: { prepare: (s: string) => stmt(s) } };
  return { env, runs };
}
const ran = (runs: any[], re: RegExp) => runs.filter((r) => re.test(r.sql));

describe('case status helpers', () => {
  it('exposes the 5 spec statuses', () => {
    expect([...CASE_STATUSES]).toEqual(['abierto', 'en_consulta', 'seguimiento', 'resuelto', 'cancelado']);
    expect(isCaseStatus('seguimiento')).toBe(true);
    expect(isCaseStatus('napping')).toBe(false);
  });
  it('treats resuelto/cancelado as terminal', () => {
    expect(isTerminalCase('resuelto')).toBe(true);
    expect(isTerminalCase('cancelado')).toBe(true);
    expect(isTerminalCase('abierto')).toBe(false);
    expect(isTerminalCase('seguimiento')).toBe(false);
  });
});

describe('dedupKey — cédula → email → phone priority', () => {
  it('prefers cédula, normalizing it to digits', () => {
    expect(dedupKey({ full_name: 'x', cedula: 'V-12.345.678', email: 'a@b.com', phone: '0414-1112233' }))
      .toEqual({ field: 'cedula', value: '12345678' });
  });
  it('falls back to email (lowercased) then phone (digits)', () => {
    expect(dedupKey({ full_name: 'x', email: 'A@B.com', phone: '0414 111 2233' }))
      .toEqual({ field: 'email', value: 'a@b.com' });
    expect(dedupKey({ full_name: 'x', phone: '0414 111 2233' }))
      .toEqual({ field: 'phone', value: '04141112233' });
  });
  it('ignores a too-short cédula and returns null when nothing identifies the patient', () => {
    expect(dedupKey({ full_name: 'x', cedula: '12' })).toBeNull();
    expect(dedupKey({ full_name: 'x' })).toBeNull();
  });
});

describe('caseActionForApptStatus — telemed status → medical-case action', () => {
  it('in_progress opens the consult', () => {
    expect(caseActionForApptStatus('in_progress', false)).toEqual({ status: 'en_consulta', kind: 'consult_started' });
  });
  it('completed resolves, or goes to seguimiento when follow-up is required', () => {
    expect(caseActionForApptStatus('completed', false)).toEqual({ status: 'resuelto', kind: 'completed' });
    expect(caseActionForApptStatus('completed', true)).toEqual({ status: 'seguimiento', kind: 'completed' });
  });
  it('no_show / cancelled log an event but never change the case status', () => {
    expect(caseActionForApptStatus('no_show', false)).toEqual({ status: null, kind: 'no_show' });
    expect(caseActionForApptStatus('cancelled', false)).toEqual({ status: null, kind: 'cancelled' });
  });
  it('check-in / waiting log an event without a status change', () => {
    expect(caseActionForApptStatus('checked_in', false)).toEqual({ status: null, kind: 'checked_in' });
  });
});

describe('upsertPatient', () => {
  it('inserts a new patient when no dedup match exists', async () => {
    const { env, runs } = makeEnv();
    const out = await upsertPatient(env, { full_name: 'Juan Perez', cedula: 'V-12.345.678', email: 'j@p.com' });
    expect(out.created).toBe(true);
    expect(out.id).toMatch(/^pat_/);
    expect(ran(runs, /INSERT INTO patients/).length).toBe(1);
    // cédula stored normalized
    expect(ran(runs, /INSERT INTO patients/)[0].binds).toContain('12345678');
  });
  it('updates the existing patient when the cédula matches (no new row)', async () => {
    const { env, runs } = makeEnv({ patientByCedula: { id: 'pat_existing', full_name: 'Juan', email: null, phone: null, cedula: '12345678', dob: null, gender: null, state: null, city: null, person_id: null } });
    const out = await upsertPatient(env, { full_name: 'Juan Perez', cedula: '12345678', phone: '04141112233' });
    expect(out).toEqual({ id: 'pat_existing', created: false });
    expect(ran(runs, /INSERT INTO patients/).length).toBe(0);
    expect(ran(runs, /UPDATE patients SET/).length).toBe(1);
  });
});

describe('openOrUpdateCase', () => {
  it('opens a new case when the patient has none', async () => {
    const { env, runs } = makeEnv();
    const out = await openOrUpdateCase(env, 'pat_1', { specialty: 'pediatria', doctorId: 'doc_1', appointmentId: 'apt_1' });
    expect(out.created).toBe(true);
    expect(out.id).toMatch(/^mcase_/);
    expect(ran(runs, /INSERT INTO patient_cases/).length).toBe(1);
  });
  it('reuses the patient open case instead of creating a second', async () => {
    const { env, runs } = makeEnv({ openCase: { id: 'mcase_open', status: 'seguimiento' } });
    const out = await openOrUpdateCase(env, 'pat_1', { appointmentId: 'apt_2' });
    expect(out).toEqual({ id: 'mcase_open', created: false });
    expect(ran(runs, /INSERT INTO patient_cases/).length).toBe(0);
    expect(ran(runs, /UPDATE patient_cases SET/).length).toBe(1);
  });
});

describe('recordCaseEvent', () => {
  it('appends an event and bumps the case activity timestamp', async () => {
    const { env, runs } = makeEnv();
    const id = await recordCaseEvent(env, 'mcase_1', 'note_added', { appointmentId: 'apt_1', detail: 'x', actor: 'doc_1' });
    expect(id).toMatch(/^pce_/);
    expect(ran(runs, /INSERT INTO patient_case_events/).length).toBe(1);
    expect(ran(runs, /UPDATE patient_cases SET last_activity_ms/).length).toBe(1);
  });
});

describe('registerConsultPatient — the booking-time workflow hook', () => {
  it('registers the patient, links the appointment, opens a case, logs booked', async () => {
    const { env, runs } = makeEnv();
    const out = await registerConsultPatient(env, {
      appointmentId: 'apt_1', kind: 'appointment',
      patient_name: 'Ana Diaz', patient_cedula: 'V-9.999.999', patient_email: 'ana@x.com',
      specialty: 'general', doctor_id: 'doc_1',
    });
    expect(out.patientId).toMatch(/^pat_/);
    expect(out.caseId).toMatch(/^mcase_/);
    expect(ran(runs, /INSERT INTO patients/).length).toBe(1);
    expect(ran(runs, /UPDATE telemed_appointments SET patient_id/).length).toBe(1);
    expect(ran(runs, /INSERT INTO patient_cases/).length).toBe(1);
    const booked = ran(runs, /INSERT INTO patient_case_events/);
    expect(booked.length).toBe(1);
    expect(booked[0].binds).toContain('booked');
  });
  it('links a request (req_) appointment via the requests table', async () => {
    const { env, runs } = makeEnv();
    await registerConsultPatient(env, { appointmentId: 'req_1', kind: 'request', patient_name: 'Ana', patient_phone: '04141112233' });
    expect(ran(runs, /UPDATE telemed_requests SET patient_id/).length).toBe(1);
  });
});

describe('syncCaseFromAppointmentStatus', () => {
  it('no-ops when the appointment has no registered patient', async () => {
    const { env, runs } = makeEnv({ appt: { patient_id: null } });
    expect(await syncCaseFromAppointmentStatus(env, 'apt_1', 'completed')).toBeNull();
    expect(runs.length).toBe(0);
  });
  it('completed without follow-up resolves the case and logs completed', async () => {
    const { env, runs } = makeEnv({ appt: { patient_id: 'pat_1' }, openCase: { id: 'mcase_1' } });
    const id = await syncCaseFromAppointmentStatus(env, 'apt_1', 'completed', 'doc_1');
    expect(id).toBe('mcase_1');
    const set = ran(runs, /UPDATE patient_cases SET status=\?/);
    expect(set.length).toBe(1);
    expect(set[0].binds[0]).toBe('resuelto');
    expect(ran(runs, /INSERT INTO patient_case_events/)[0].binds).toContain('completed');
  });
  it('completed WITH requiere_seguimiento moves the case to seguimiento', async () => {
    const { env, runs } = makeEnv({
      appt: { patient_id: 'pat_1' }, openCase: { id: 'mcase_1' },
      consult: { checklist: JSON.stringify({ requiere_seguimiento: true }) },
    });
    await syncCaseFromAppointmentStatus(env, 'apt_1', 'completed', 'doc_1');
    expect(ran(runs, /UPDATE patient_cases SET status=\?/)[0].binds[0]).toBe('seguimiento');
  });
  it('in_progress moves the case to en_consulta', async () => {
    const { env, runs } = makeEnv({ appt: { patient_id: 'pat_1' }, openCase: { id: 'mcase_1' } });
    await syncCaseFromAppointmentStatus(env, 'apt_1', 'in_progress', 'doc_1');
    expect(ran(runs, /UPDATE patient_cases SET status=\?/)[0].binds[0]).toBe('en_consulta');
  });
  it('cancelled logs an event but does not change status', async () => {
    const { env, runs } = makeEnv({ appt: { patient_id: 'pat_1' }, openCase: { id: 'mcase_1' } });
    await syncCaseFromAppointmentStatus(env, 'apt_1', 'cancelled', 'patient');
    expect(ran(runs, /UPDATE patient_cases SET status=\?/).length).toBe(0);
    expect(ran(runs, /INSERT INTO patient_case_events/)[0].binds).toContain('cancelled');
  });
});

describe('linkPatientToPerson — attach a medical case to a public case file', () => {
  it('writes person_id to the patient and its open case and logs the link', async () => {
    const { env, runs } = makeEnv({ openCase: { id: 'mcase_open', status: 'abierto' } });
    await linkPatientToPerson(env, 'pat_1', 'fam-abc123', 'operator@x.com');
    expect(ran(runs, /UPDATE patients SET person_id/).length).toBe(1);
    expect(ran(runs, /UPDATE patient_cases SET person_id/).length).toBe(1);
    const ev = ran(runs, /INSERT INTO patient_case_events/);
    expect(ev[0].binds).toContain('linked_person');
  });
});
