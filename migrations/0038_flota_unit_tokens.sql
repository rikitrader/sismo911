-- FLOTA field-unit GPS tokens. A unit (vehicle/responder device) can stream its
-- position to POST /api/flota/rastreo/posicion using a scoped bearer token,
-- WITHOUT an operator session. Tokens are hashed (sha256); plaintext is shown
-- once at issue time. Operators issue/revoke tokens (operator-gated routes).

CREATE TABLE IF NOT EXISTS flota_unit_tokens (
  id           TEXT PRIMARY KEY,            -- tok_xxxxxxxx
  unidad_id    TEXT NOT NULL,
  token_prefix TEXT NOT NULL,               -- indexed lookup (non-secret)
  token_hash   TEXT NOT NULL,               -- sha256 of the full token
  label        TEXT,
  created_ms   INTEGER NOT NULL,
  last_used_ms INTEGER,
  revoked_ms   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_flota_unit_tokens_prefix ON flota_unit_tokens(token_prefix);
CREATE INDEX IF NOT EXISTS idx_flota_unit_tokens_unidad ON flota_unit_tokens(unidad_id);
