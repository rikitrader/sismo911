-- 0070_support_tickets.sql — in-dashboard support ticket system ("Soporte").
-- Inbox/email-style: every ticket gets a human-readable hash reference (ref,
-- e.g. SOP-7K3F9A), a status the citizen can track, and a threaded message log.
-- Citizens open/reply from /cuenta → Soporte; operators triage from /console.
-- Email is wired both ways: outbound notifications carry [#REF] in the subject
-- and a Reply-To of the support address, and inbound replies are matched back to
-- the ticket by that ref (src/index.ts email() handler).
-- Idempotent (CREATE … IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS support_tickets (
  id            TEXT PRIMARY KEY,           -- tkt_…
  ref           TEXT NOT NULL UNIQUE,       -- public hash, e.g. SOP-7K3F9A
  user_id       TEXT,                       -- owner (NULL only for orphan inbound email)
  email         TEXT NOT NULL,              -- contact email snapshot (where replies go)
  name          TEXT,                       -- contact name snapshot
  subject       TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'otro',   -- cuenta | pagos | retiros | tecnico | seguridad | otro
  priority      TEXT NOT NULL DEFAULT 'normal', -- low | normal | high | urgent
  status        TEXT NOT NULL DEFAULT 'open',   -- open | pending | answered | resolved | closed
  assigned_to   TEXT,                       -- staff user_id handling it (NULL = unassigned)
  msg_count     INTEGER NOT NULL DEFAULT 0,
  unread_user   INTEGER NOT NULL DEFAULT 0, -- messages the citizen hasn't seen (staff replies)
  unread_staff  INTEGER NOT NULL DEFAULT 0, -- messages staff hasn't seen (citizen messages)
  last_message_ms INTEGER,                  -- timestamp of most recent message
  last_sender   TEXT,                       -- 'user' | 'staff' | 'system' of the last message
  created_ms    INTEGER NOT NULL,
  updated_ms    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS support_messages (
  id           TEXT PRIMARY KEY,            -- msg_…
  ticket_id    TEXT NOT NULL,
  author_type  TEXT NOT NULL,               -- user | staff | system
  author_id    TEXT,                        -- user_id / staff id (NULL for system + inbound)
  author_name  TEXT,                        -- display name snapshot
  body         TEXT NOT NULL,
  via          TEXT NOT NULL DEFAULT 'web', -- web | email
  created_ms   INTEGER NOT NULL
);

-- Citizen's own ticket list, newest activity first.
CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets(user_id, last_message_ms DESC);
-- Operator triage queue filtered by status.
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status, last_message_ms DESC);
-- Inbound-email matching + tracking lookups by ref.
CREATE INDEX IF NOT EXISTS idx_support_tickets_ref ON support_tickets(ref);
-- Thread render: all messages for a ticket in order.
CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON support_messages(ticket_id, created_ms);
