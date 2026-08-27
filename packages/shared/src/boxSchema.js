// src/boxSchema.js — schema base que se aplica a cada Turso DB de box
// al aprovisionarlo (arquitectura §4).
//
// Exporta:
//   - BOX_BASE_SCHEMA_SQL: string con todas las CREATE TABLE.
//   - applyBoxSchema(client): helper que conecta vía @tursodatabase/serverless
//     y aplica el schema en orden. Pensado para correr una sola vez en el
//     provision de cada box.
//   - APP_USERS_SCHEMA_SQL: tablas para usuarios de la app (fase 1 de
//     htmlbox-spec-app-users.md). Se aplica on-demand, no en el provision.
//   - applyAppUsersSchema(client): helper idempotente.
//   - APP_SETTINGS_SCHEMA_SQL: tabla de settings por box (fase 2 — signup_mode).
//   - applyAppSettingsSchema(client): helper idempotente.
//   - ensureColumn()/ensureTableScopeColumn()/ensureOwnerColumn(): helpers
//     para agregar columnas a tablas existentes sin `ADD COLUMN IF NOT EXISTS`
//     (que SQLite no soporta).

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

// ─────────────────────────────────────────────────────────────────────────────
// Fase 1 — htmlbox-spec-app-users.md
//
// 3 tablas para usuarios de la app (NO usuarios de plataforma HTMLBox):
//   - htmlbox_app_users: el registro del app-user (email, display_name, role, disabled_at).
//   - htmlbox_app_sessions: sesiones activas (cookie hbx_app_sid → app_user_id).
//   - htmlbox_app_magic_links: magic links para passwordless login.
//
// Se aplican on-demand (no en el provision del box) — un box puede no usar
// esta funcionalidad nunca (ej. un dashboard de una sola persona). Se llama
// desde runtime/src/lib/appAuth.js y desde el alta del primer app-user por el
// tenant, vía applyAppUsersSchema(client).
//
// Role existe desde v1 pero NO se valida en ningún chequeo de autorización —
// ver htmlbox-spec-app-users.md §7. La columna se crea ahora para que la
// fase 2+ de roles/permisos no requiera un ALTER TABLE.
//
// disabled_at es nullable: si está seteado, el usuario no puede pedir magic
// link ni loguearse (chequeos en appAuth.js §isRateLimited/validateAppSession).
// ─────────────────────────────────────────────────────────────────────────────

export const APP_USERS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS htmlbox_app_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  disabled_at TEXT
);

CREATE TABLE IF NOT EXISTS htmlbox_app_sessions (
  id TEXT PRIMARY KEY,
  app_user_id TEXT NOT NULL REFERENCES htmlbox_app_users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS htmlbox_app_magic_links (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_htmlbox_app_sessions_user ON htmlbox_app_sessions(app_user_id);
CREATE INDEX IF NOT EXISTS idx_htmlbox_app_sessions_expires ON htmlbox_app_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_htmlbox_app_magic_links_email_created ON htmlbox_app_magic_links(email, created_at);
CREATE INDEX IF NOT EXISTS idx_htmlbox_app_magic_links_expires ON htmlbox_app_magic_links(expires_at);
`

// Idéntico patrón a applyBoxSchema() — reusa el mismo split-por-';' y el
// mismo fallback exec()/execute() (ver comentario original en applyBoxSchema).
export async function applyAppUsersSchema(client) {
  const stmts = APP_USERS_SCHEMA_SQL
    .split(/;\s*$/m)
    .map(s => s.trim())
    .filter(s => s.length > 0)

  for (const stmt of stmts) {
    if (typeof client.exec === 'function') {
      await client.exec(stmt)
    } else if (typeof client.execute === 'function') {
      await client.execute(stmt)
    } else {
      throw new Error('applyAppUsersSchema: cliente Turso no expone exec() ni execute()')
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fase 2 — htmlbox-spec-app-customers.md
//
// Tabla de settings por box (1 sola fila, id=1). Hoy solo guarda signup_mode
// para el comportamiento de auto-registro de customers:
//   - 'invite_only' (default): comportamiento de fase 1 — el tenant agrega
//     cada email a mano desde el portal; el que no está agregado, NO puede
//     pedir magic link.
//   - 'open': cualquier email puede pedir magic link y la cuenta se crea
//     sola al consumirlo (modo ecommerce / customer-facing).
// ─────────────────────────────────────────────────────────────────────────────

export const APP_SETTINGS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS htmlbox_app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  signup_mode TEXT NOT NULL DEFAULT 'invite_only'
);
`

export async function applyAppSettingsSchema(client) {
  const stmts = APP_SETTINGS_SCHEMA_SQL
    .split(/;\s*$/m)
    .map(s => s.trim())
    .filter(s => s.length > 0)

  for (const stmt of stmts) {
    if (typeof client.exec === 'function') {
      await client.exec(stmt)
    } else if (typeof client.execute === 'function') {
      await client.execute(stmt)
    } else {
      throw new Error('applyAppSettingsSchema: cliente Turso no expone exec() ni execute()')
    }
  }

  // fila única por default — INSERT OR IGNORE porque puede llamarse varias veces
  const insert = `INSERT OR IGNORE INTO htmlbox_app_settings (id, signup_mode) VALUES (1, 'invite_only')`
  if (typeof client.exec === 'function') await client.exec(insert)
  else await client.execute(insert)
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers para agregar columnas a tablas existentes sin `ADD COLUMN IF NOT
// EXISTS` (SQLite no lo soporta). Usado por la fase 2 para:
//   - htmlbox_tables.scope (¿la tabla es 'private' por app_user o 'shared'?)
//
//   - htmlbox_{slug}.owner_user_id (¿qué app_user es dueño de esta fila?)
//
// Se chequea con PRAGMA table_info antes de alterar — correrlo dos veces
// sobre el mismo box no debe tirar "duplicate column name".
// ─────────────────────────────────────────────────────────────────────────────

export async function ensureColumn(client, tableName, columnName, columnDefSql) {
  const info = await (typeof client.execute === 'function'
    ? client.execute(`PRAGMA table_info(${tableName})`)
    : client.exec(`PRAGMA table_info(${tableName})`))
  const rows = info.rows || info || []
  const exists = rows.some(r => (r.name || r[1]) === columnName)
  if (exists) return
  const alter = `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefSql}`
  if (typeof client.exec === 'function') await client.exec(alter)
  else await client.execute(alter)
}

// scope de una tabla de datos del box: 'private' (default, cada app_user ve
// solo lo suyo) | 'shared' (todos ven lo mismo — catálogos, listas, etc.)
export async function ensureTableScopeColumn(client) {
  await ensureColumn(client, 'htmlbox_tables', 'scope', `TEXT NOT NULL DEFAULT 'private'`)
}

// dueño de una fila. Nullable: filas creadas por otra vía (ej. el tenant
// cargó un CSV desde el portal, vía dataApi.js) quedan sin dueño y no las ve
// ningún app_user en una tabla 'private' hasta que se les asigne uno — mismo
// criterio fail-closed que en cualquier otra parte de este sistema.
export async function ensureOwnerColumn(client, slug) {
  await ensureColumn(client, `htmlbox_${slug}`, 'owner_user_id', 'TEXT')
}