-- 0002_auth.sql — magic-link + sessions (port del patrón sivocloud)
--
-- Misma idea: tokens random 32 bytes hex, TTL 15 min para links / 30 días para sesiones.
-- Consumo en POST (no GET) — los scanners de correo no invalidan el link.

CREATE TABLE IF NOT EXISTS htmlbox_sessions (
  id TEXT PRIMARY KEY,                                  -- random 32 bytes hex (= cookie "sid")
  user_id TEXT NOT NULL REFERENCES htmlbox_users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS htmlbox_magic_links (
  id TEXT PRIMARY KEY,                                  -- random 32 bytes hex
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,                                         -- NULL = disponible
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_htmlbox_sessions_user ON htmlbox_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_htmlbox_sessions_expires ON htmlbox_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_htmlbox_magic_links_email_created ON htmlbox_magic_links(email, created_at);
CREATE INDEX IF NOT EXISTS idx_htmlbox_magic_links_expires ON htmlbox_magic_links(expires_at);