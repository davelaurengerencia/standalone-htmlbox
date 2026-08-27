-- 0004_api_tokens.sql — port del patrón sivocloud 0009
--
-- Se guarda el HASH, no el token (igual que una contraseña).
-- Scopes según arquitectura §11.5:
--   read | write_html | write_data | execute
--
-- El endpoint de creación devuelve el token en claro UNA sola vez.
-- prefix permite identificar el token en una lista sin poder usarlo.

CREATE TABLE IF NOT EXISTS htmlbox_api_tokens (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,                   -- SHA-256 hex
  prefix        TEXT NOT NULL,                          -- primeros chars del token en claro (ej. "hbx_a1b2...")
  name          TEXT NOT NULL,
  box_id        TEXT NOT NULL REFERENCES htmlbox_boxes(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES htmlbox_users(id),
  scope         TEXT NOT NULL DEFAULT 'read',           -- CSV: "read,write_html,execute"
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT,
  last_used_at  TEXT,
  revoked_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_htmlbox_api_tokens_box ON htmlbox_api_tokens (box_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_htmlbox_api_tokens_user ON htmlbox_api_tokens (user_id, revoked_at);