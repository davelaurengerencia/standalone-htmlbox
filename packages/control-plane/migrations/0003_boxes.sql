-- 0003_boxes.sql — boxes + versionado de HTML (5 últimas)
--
-- Versión activa del box: htmlbox_boxes.htmlbox_version.
-- Historial: htmlbox_versions. La regla §11.2 es "siempre 5 últimas" — el
-- versionado se mantiene en versioning.js#purgeIfOverLimit del shared.

CREATE TABLE IF NOT EXISTS htmlbox_boxes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES htmlbox_tenants(id),
  workspace_id TEXT NOT NULL REFERENCES htmlbox_workspaces(id),
  slug TEXT NOT NULL,                                   -- ".../{boxSlug}"
  name TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',           -- public | private
  template TEXT NOT NULL DEFAULT 'empty',               -- empty | dashboard | crm

  -- Turso provisioning (los datos del box viven en su DB propia, §4)
  turso_db_url TEXT,                                    -- libsql://htmlbox-box-{id}.turso.io (o http://localhost:8080 en dev)
  turso_db_token TEXT,                                  -- texto plano por ahora (deuda §13)
  turso_status TEXT NOT NULL DEFAULT 'pending',         -- pending | ready | failed

  -- Versionado
  htmlbox_version INTEGER NOT NULL DEFAULT 0,
  share_id TEXT,                                        -- para URL pública tipo https://htmlbox.app/s/{shareId}

  created_by TEXT REFERENCES htmlbox_users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workspace_id, slug)
);

CREATE TABLE IF NOT EXISTS htmlbox_versions (
  box_id TEXT NOT NULL REFERENCES htmlbox_boxes(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  source TEXT NOT NULL,                                 -- portal | agent | api | rollback
  agent_name TEXT,
  summary TEXT NOT NULL,
  created_by TEXT REFERENCES htmlbox_users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (box_id, version)
);

CREATE INDEX IF NOT EXISTS idx_htmlbox_boxes_workspace ON htmlbox_boxes(workspace_id);
CREATE INDEX IF NOT EXISTS idx_htmlbox_boxes_tenant ON htmlbox_boxes(tenant_id);
CREATE INDEX IF NOT EXISTS idx_htmlbox_boxes_share ON htmlbox_boxes(share_id);
CREATE INDEX IF NOT EXISTS idx_htmlbox_versions_box_desc ON htmlbox_versions(box_id, version DESC);