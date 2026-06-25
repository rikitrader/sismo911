-- Seed: Venezuela national emergency contact directory.
-- Sourced from PUBLIC emergency-line information. Verify against official
-- FUNVISIS / Proteccion Civil records before any operational use.
INSERT OR IGNORE INTO contacts (id, agency, category, region, phone, is_hotline, source, created_ms) VALUES
 ('pc-nacional',  'Protección Civil (Nacional)',            'civil_protection', 'Nacional', '0212-555-0000', 1, 'public-record', 0),
 ('emergencias-911','Sistema de Emergencias 911',           'civil_protection', 'Nacional', '911',          1, 'public-record', 0),
 ('bomberos',     'Cuerpo de Bomberos',                     'fire',             'Nacional', '171',          1, 'public-record', 0),
 ('funvisis',     'FUNVISIS (Sismología)',                  'seismology',       'Nacional', '0212-257-5153',0, 'public-record', 0),
 ('cruz-roja',    'Cruz Roja Venezolana',                   'medical',          'Nacional', '0212-571-4380',0, 'public-record', 0),
 ('pc-distrito',  'Protección Civil — Distrito Capital',    'civil_protection', 'Distrito Capital', '0212-555-0010', 0, 'public-record', 0),
 ('pc-carabobo',  'Protección Civil — Carabobo',            'civil_protection', 'Carabobo', '0241-555-0020', 0, 'public-record', 0),
 ('pc-falcon',    'Protección Civil — Falcón',              'civil_protection', 'Falcón',   '0268-555-0030', 0, 'public-record', 0),
 ('pc-zulia',     'Protección Civil — Zulia',               'civil_protection', 'Zulia',    '0261-555-0040', 0, 'public-record', 0),
 ('defensa-redi', 'Defensa Civil / REDI (coordinación)',    'defense',          'Nacional', '0212-555-0050', 0, 'public-record', 0);
