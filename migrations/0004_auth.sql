-- Authentication: users + sessions. Roles: citizen | operator | admin.
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'citizen',   -- citizen | operator | admin
  rank        TEXT,                               -- e.g. "Cnel.", optional title
  unit        TEXT,                               -- e.g. "Oficial de Guardia"
  pw_hash     TEXT NOT NULL,
  pw_salt     TEXT NOT NULL,
  phone       TEXT,
  created_ms  INTEGER NOT NULL,
  last_login_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  expires_ms  INTEGER NOT NULL,
  created_ms  INTEGER NOT NULL,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_ms);
