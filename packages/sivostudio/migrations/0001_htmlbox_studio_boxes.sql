-- Migration: htmlbox_studio_boxes
-- Tabla de metadata de boxes creados por sivostudio.
-- SIVOCLOUD: paquete nuevo @htmlbox/sivostudio (experimento aislado).
-- NO comparte DB con control-plane — esta D1 es `htmlbox-sivostudio`.

CREATE TABLE IF NOT EXISTS htmlbox_studio_boxes (
  box_id      TEXT PRIMARY KEY,                       -- [a-z0-9]{16}
  name        TEXT NOT NULL,
  script_name TEXT NOT NULL,                          -- 'box-{boxId}'
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
  deleted     INTEGER NOT NULL DEFAULT 0              -- 0 = activo, 1 = soft-deleted
);

CREATE INDEX IF NOT EXISTS htmlbox_studio_boxes_last_seen_idx
  ON htmlbox_studio_boxes (last_seen);

CREATE INDEX IF NOT EXISTS htmlbox_studio_boxes_deleted_idx
  ON htmlbox_studio_boxes (deleted);
