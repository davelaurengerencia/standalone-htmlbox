-- 0001_control_plane.sql
--
-- Tablas básicas del control plane de HTMLBox. Metadatos globales:
-- tenants, workspaces, memberships.
--
-- Aplicar con:
--   npx wrangler d1 migrations apply htmlbox-control-plane --local
--   npx wrangler d1 migrations apply htmlbox-control-plane --remote

CREATE TABLE IF NOT EXISTS htmlbox_tenants (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',   -- active | suspended
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS htmlbox_users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  -- NULL = platform owner (puede crear tenants / ver todo).
  tenant_id TEXT REFERENCES htmlbox_tenants(id),
  is_platform_owner INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS htmlbox_workspaces (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES htmlbox_tenants(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS htmlbox_memberships (
  user_id TEXT NOT NULL REFERENCES htmlbox_users(id),
  workspace_id TEXT NOT NULL REFERENCES htmlbox_workspaces(id),
  role TEXT NOT NULL,                      -- owner | editor | viewer
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_htmlbox_workspaces_tenant ON htmlbox_workspaces(tenant_id);
CREATE INDEX IF NOT EXISTS idx_htmlbox_memberships_user ON htmlbox_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_htmlbox_memberships_workspace ON htmlbox_memberships(workspace_id);
CREATE INDEX IF NOT EXISTS idx_htmlbox_users_tenant ON htmlbox_users(tenant_id);