-- 0010_tenant_app_users.sql — usuarios de app centralizados (fase 3 de
-- "usuarios de las apps"). Distinto de htmlbox_users (usuarios de PLATAFORMA,
-- gente que construye boxes en el portal) y distinto de htmlbox_app_users
-- (fase 1/2, vive en la Turso de cada box, un email = una app). Este es
-- un tercer tipo: identidad que cruza boxes/workspaces del mismo tenant,
-- gestionada una sola vez desde el portal a nivel tenant.
--
-- Modelo: identidad + accesos separados.
--   htmlbox_tenant_app_users     — quién es (1 fila por email, por tenant)
--   htmlbox_tenant_app_access    — a qué llega (N filas: tenant | workspace | box)
--
-- Ver htmlbox-spec-app-users-centralized.md para el diseño completo.

CREATE TABLE IF NOT EXISTS htmlbox_tenant_app_users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES htmlbox_tenants(id),
  email TEXT NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  disabled_at TEXT,
  UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS htmlbox_tenant_app_sessions (
  id TEXT PRIMARY KEY,
  tenant_app_user_id TEXT NOT NULL REFERENCES htmlbox_tenant_app_users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS htmlbox_tenant_app_magic_links (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES htmlbox_tenants(id),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- scope_type: 'tenant' | 'workspace' | 'box'
-- scope_id:   NULL si scope_type='tenant'; id del workspace o box puntual
CREATE TABLE IF NOT EXISTS htmlbox_tenant_app_access (
  id TEXT PRIMARY KEY,
  tenant_app_user_id TEXT NOT NULL REFERENCES htmlbox_tenant_app_users(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  role TEXT NOT NULL DEFAULT 'full',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_htmlbox_tenant_app_sessions_user ON htmlbox_tenant_app_sessions(tenant_app_user_id);
CREATE INDEX IF NOT EXISTS idx_htmlbox_tenant_app_sessions_expires ON htmlbox_tenant_app_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_htmlbox_tenant_app_magic_links_email_created ON htmlbox_tenant_app_magic_links(email, created_at);
CREATE INDEX IF NOT EXISTS idx_htmlbox_tenant_app_access_user ON htmlbox_tenant_app_access(tenant_app_user_id);
CREATE INDEX IF NOT EXISTS idx_htmlbox_tenant_app_access_scope ON htmlbox_tenant_app_access(scope_type, scope_id);