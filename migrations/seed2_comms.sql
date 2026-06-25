-- HAM / emergency comms frequencies (Venezuela + international calling/emergency).
-- Public amateur-radio + emergency calling frequencies. Verify against current
-- CONATEL / IARU Region 2 band plans before operational use.
INSERT OR IGNORE INTO comms_channels (id, name, band, frequency, mode, region, purpose, created_ms) VALUES
 ('emrg-2m',   'Emergencia VHF 2m',            'VHF', '145.000 MHz', 'FM',  'Nacional', 'Llamada/emergencia simplex', 0),
 ('emrg-hf40', 'Red Nacional HF 40m',          'HF',  '7.090 MHz',   'SSB', 'Nacional', 'Coordinación nacional emergencia', 0),
 ('emrg-hf80', 'Red Nacional HF 80m',          'HF',  '3.750 MHz',   'SSB', 'Nacional', 'Enlace nocturno emergencia', 0),
 ('iaru-cot',  'IARU Centro de Operaciones',   'HF',  '14.300 MHz',  'SSB', 'Región 2', 'Tráfico emergencia internacional', 0),
 ('marps',     'Sistema Marítimo VHF Canal 16','VHF', '156.800 MHz', 'FM',  'Costa',    'Socorro marítimo (Canal 16)', 0),
 ('repetidora','Repetidora Caracas',           'VHF', '146.940 MHz', 'FM',  'D. Capital','Repetidora regional (-600 kHz)', 0),
 ('citizen-cb','Banda Ciudadana Canal 9',      'citizen','27.065 MHz','AM',  'Nacional', 'Emergencia banda ciudadana', 0);

-- Sample resources (admin will curate live values).
INSERT OR IGNORE INTO resources (id, kind, label, quantity, status, region, updated_ms) VALUES
 ('res-water-dc','water','Punto de agua — Distrito Capital','—','available','Distrito Capital',0),
 ('res-shelter-ca','shelter','Refugio temporal — Carabobo','120 cupos','available','Carabobo',0),
 ('res-med-fa','medical','Brigada médica — Falcón','—','available','Falcón',0);
