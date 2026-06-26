-- Gated data API + MCP clients.
-- External consumers self-register for an API key + secret, an operator approves
-- the request, and the approved client can then pull SISMO911's public datasets
-- (earthquakes, shelters, blog, stats — and, with an explicit grant, the
-- citizen-submitted missing-persons registry) from our D1 over the keyed API and
-- the MCP server. The secret is shown to the client exactly once at registration;
-- we only ever store its SHA-256 hash.
CREATE TABLE IF NOT EXISTS api_clients (
  id            TEXT PRIMARY KEY,                -- cli_<uuid8>
  name          TEXT NOT NULL,                   -- contact name
  email         TEXT NOT NULL,                   -- contact email (approval notice)
  org           TEXT NOT NULL DEFAULT '',        -- organization / project
  purpose       TEXT NOT NULL DEFAULT '',        -- stated use of the data
  api_key       TEXT NOT NULL UNIQUE,            -- sk911_<hex> — public identifier
  secret_hash   TEXT NOT NULL,                   -- hex SHA-256 of the secret (shown once)
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | approved | revoked
  -- Comma-separated scopes. Missing-persons PII requires the explicit
  -- read:missing-persons grant, only added by an operator at approval time.
  scopes        TEXT NOT NULL DEFAULT 'read:earthquakes,read:shelters,read:blog,read:stats',
  rate_limit    INTEGER NOT NULL DEFAULT 120,    -- requests per minute (KV-enforced)
  request_count INTEGER NOT NULL DEFAULT 0,      -- lifetime authorized requests
  last_used_ms  INTEGER,
  approved_by   TEXT,                            -- operator user id / email
  approved_ms   INTEGER,
  revoked_ms    INTEGER,
  note          TEXT NOT NULL DEFAULT '',        -- operator note
  created_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_clients_status ON api_clients (status);
CREATE INDEX IF NOT EXISTS idx_api_clients_key    ON api_clients (api_key);

-- Lightweight usage trail (recent requests per client). Opportunistically pruned
-- by the keyed-API middleware so it never grows unbounded.
CREATE TABLE IF NOT EXISTS api_request_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id  TEXT NOT NULL,
  endpoint   TEXT NOT NULL,
  status     INTEGER NOT NULL,
  ip         TEXT NOT NULL DEFAULT '',
  ts_ms      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_request_log_client ON api_request_log (client_id, ts_ms DESC);
