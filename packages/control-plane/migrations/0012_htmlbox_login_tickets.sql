-- 0012_htmlbox_login_tickets.sql — OAuth-style ticket transfer entre subdominios
--
-- El Worker `auth` (auth.<dominio>) arma la sesión de plataforma. Pero la cookie
-- `sid` no se comparte entre `*.localhost` (PSL rechaza Domain=.localhost) ni
-- queremos depender de esa mecánica en prod. Solución: el Worker `auth` emite
-- un TICKET de un solo uso (60s TTL) después de crear la sesión, y el destino
-- (studio.* o controlplane.*) lo canjea server-to-server contra auth.*/exchange
-- para setear su cookie host-only en su propio dominio.
--
-- Referencia: docs/htmlbox-spec-auth-centralizado.md §6.

CREATE TABLE IF NOT EXISTS htmlbox_login_tickets (
  id TEXT PRIMARY KEY,                                  -- random 32 bytes hex
  session_id TEXT NOT NULL REFERENCES htmlbox_sessions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,                             -- 60 segundos después de created_at
  consumed_at TEXT,                                    -- NULL hasta que se canjea
  return_to TEXT                                       -- path dentro del destino al que redirigir post-exchange
);

CREATE INDEX IF NOT EXISTS idx_htmlbox_login_tickets_expires ON htmlbox_login_tickets(expires_at);
CREATE INDEX IF NOT EXISTS idx_htmlbox_login_tickets_session ON htmlbox_login_tickets(session_id);
