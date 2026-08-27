// src/boxSchema.js — schema base que se aplica a cada Turso DB de box
// al aprovisionarlo (arquitectura §4).
//
// Exporta:
//   - BOX_BASE_SCHEMA_SQL: string con todas las CREATE TABLE.
//   - applyBoxSchema(client): helper que conecta vía @tursodatabase/serverless
//     y aplica el schema en orden. Pensado para correr una sola vez en el
//     provision de cada box.

export const BOX_BASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS htmlbox_tables (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  columns_json TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'manual',
  flow_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS htmlbox_schema_log (
  version INTEGER PRIMARY KEY AUTOINCREMENT,
  table_slug TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  snapshot_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS htmlbox_files (
  id TEXT PRIMARY KEY,
  table_slug TEXT NOT NULL,
  filename TEXT NOT NULL,
  kind TEXT NOT NULL,
  rows INTEGER NOT NULL DEFAULT 0,
  strategy TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS htmlbox_runs (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  ran_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_htmlbox_files_table ON htmlbox_files(table_slug, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_htmlbox_runs_flow ON htmlbox_runs(flow_id, ran_at DESC);
CREATE INDEX IF NOT EXISTS idx_htmlbox_schema_log_table ON htmlbox_schema_log(table_slug, version DESC);
`

// Aplica el schema. `client` es un cliente libsql de @tursodatabase/serverless
// ya conectado. Las sentencias se ejecutan una a una con `exec()` porque la
// API del paquete varía entre runtimes (Node expone `execute()`, Workers
// solo expone `exec()`/`prepare()` — usamos `exec()` que funciona en ambos).
export async function applyBoxSchema(client) {
  const stmts = BOX_BASE_SCHEMA_SQL
    .split(/;\s*$/m)
    .map(s => s.trim())
    .filter(s => s.length > 0)

  for (const stmt of stmts) {
    if (typeof client.exec === 'function') {
      await client.exec(stmt)
    } else if (typeof client.execute === 'function') {
      await client.execute(stmt)
    } else {
      throw new Error('applyBoxSchema: cliente Turso no expone exec() ni execute()')
    }
  }
}

// SQL para crear la tabla física de una hoja nueva. Se usará en fase 3 (no implementado aún).
export function physicalTableSqlFor(slug) {
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(slug)) {
    throw new Error(`boxSchema: slug inválido "${slug}"`)
  }
  return `
CREATE TABLE IF NOT EXISTS htmlbox_${slug} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_htmlbox_${slug}_deleted ON htmlbox_${slug}(deleted_at);
`
}