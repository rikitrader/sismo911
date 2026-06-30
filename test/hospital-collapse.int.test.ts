import { describe, it, expect, beforeEach } from 'vitest';
import { collapseHospitalDupes } from '../src/lib/hospital-ingest';
import { makeDb, makeEnv, type TestEnv, type D1Mock } from './helpers/d1';

// Reversible duplicate collapse for the hospital patient registry.
// Guards the inflation bug: the same person listed both with and without a cédula
// (and under hospital-name variants) used to land as multiple rows.

let db: D1Mock;
let env: TestEnv;

beforeEach(() => {
  db = makeDb(['migrations/0083_hospital_patients.sql', 'migrations/0084_hospital_patients_dupes.sql']);
  env = makeEnv(db);
});

let seq = 0;
async function ins(over: Partial<{ id: string; dedupe_key: string; hospital: string; full_name: string; norm_name: string; cedula: string; telefono: string; estado: string; matched_person_id: string }>) {
  const id = over.id || 'hp_' + (++seq).toString().padStart(6, '0');
  const t = 1_700_000_000_000 + seq * 1000;
  await env.DB.prepare(
    `INSERT INTO hospital_patients (id,dedupe_key,hospital,full_name,norm_name,cedula,telefono,estado,matched_person_id,created_ms,updated_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, over.dedupe_key ?? id, over.hospital ?? '', over.full_name ?? 'X', over.norm_name ?? 'x',
         over.cedula ?? '', over.telefono ?? '', over.estado ?? 'desconocido', over.matched_person_id ?? null, t, t).run();
  return id;
}

const count = async (sql: string) => Number((await env.DB.prepare(sql).first<any>())?.n ?? 0);

describe('collapseHospitalDupes', () => {
  it('merges a person listed with + without a cédula (and hospital-name variants) into one winner', async () => {
    // ABARCA NEIULAN — 1 cédula row + 2 no-cédula rows (hospital-string variants).
    await ins({ dedupe_key: 'c:15881615', full_name: 'ABARCA NEIULAN', norm_name: 'abarca neiulan', cedula: '15881615', estado: 'hospitalizado', hospital: 'Hospital Ana Francisca Pérez de León 2' });
    await ins({ dedupe_key: 'n:abarca neiulan', full_name: 'ABARCA NEIULAN', norm_name: 'abarca neiulan', estado: 'desconocido', hospital: 'Hospital Ana Francisca Pérez de León' });
    await ins({ dedupe_key: 'n2:abarca neiulan', full_name: 'ABARCA NEIULAN', norm_name: 'abarca neiulan', estado: 'hospitalizado', hospital: 'Hospital Ana Francisca Pérez de León 2' });

    const out = await collapseHospitalDupes(env);
    expect(out.collapsed).toBe(2);

    const rows = (await env.DB.prepare(`SELECT * FROM hospital_patients WHERE norm_name='abarca neiulan'`).all<any>()).results;
    expect(rows.length).toBe(1);                       // collapsed to one
    expect(rows[0].cedula).toBe('15881615');           // winner is the cédula row
    expect(rows[0].estado).toBe('hospitalizado');      // best status carried
    expect(await count(`SELECT COUNT(*) n FROM hospital_patients_dupes WHERE norm_name='abarca neiulan'`)).toBe(2);
    const arch = (await env.DB.prepare(`SELECT merged_into FROM hospital_patients_dupes LIMIT 1`).first<any>());
    expect(arch.merged_into).toBe(rows[0].id);         // archive points to the survivor
  });

  it('collapses a no-cédula-only group and carries the best status', async () => {
    await ins({ dedupe_key: 'n:perez juan', full_name: 'PEREZ JUAN', norm_name: 'perez juan', estado: 'desconocido' });
    await ins({ dedupe_key: 'n2:perez juan', full_name: 'PEREZ JUAN', norm_name: 'perez juan', estado: 'alta' });
    await ins({ dedupe_key: 'n3:perez juan', full_name: 'PEREZ JUAN', norm_name: 'perez juan', estado: 'desconocido' });
    await collapseHospitalDupes(env);
    const rows = (await env.DB.prepare(`SELECT * FROM hospital_patients WHERE norm_name='perez juan'`).all<any>()).results;
    expect(rows.length).toBe(1);
    expect(rows[0].estado).toBe('alta');
  });

  it('NEVER merges two different real people who share a name but have different cédulas', async () => {
    await ins({ dedupe_key: 'c:11111111', full_name: 'GOMEZ MARIA', norm_name: 'gomez maria', cedula: '11111111', estado: 'hospitalizado' });
    await ins({ dedupe_key: 'c:22222222', full_name: 'GOMEZ MARIA', norm_name: 'gomez maria', cedula: '22222222', estado: 'alta' });
    await ins({ dedupe_key: 'n:gomez maria', full_name: 'GOMEZ MARIA', norm_name: 'gomez maria', estado: 'desconocido' });
    const out = await collapseHospitalDupes(env);
    // ambiguous group (2 distinct cédulas) left fully untouched.
    expect((await env.DB.prepare(`SELECT * FROM hospital_patients WHERE norm_name='gomez maria'`).all<any>()).results.length).toBe(3);
    expect(out.collapsed).toBe(0);
  });

  it('is idempotent — a second run collapses nothing', async () => {
    await ins({ dedupe_key: 'c:15881615', full_name: 'ABARCA NEIULAN', norm_name: 'abarca neiulan', cedula: '15881615', estado: 'hospitalizado' });
    await ins({ dedupe_key: 'n:abarca neiulan', full_name: 'ABARCA NEIULAN', norm_name: 'abarca neiulan', estado: 'desconocido' });
    expect((await collapseHospitalDupes(env)).collapsed).toBe(1);
    expect((await collapseHospitalDupes(env)).collapsed).toBe(0);
  });
});
