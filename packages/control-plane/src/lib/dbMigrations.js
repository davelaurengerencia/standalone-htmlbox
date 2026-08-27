// src/lib/dbMigrations.js — migraciones idempotentes sobre D1 (control-plane).
//
// SQLite (y por lo tanto D1) NO soporta `ALTER TABLE ... ADD COLUMN IF NOT
// EXISTS`. Para agregar columnas a tablas existentes en runtime sin romper
// un re-deploy, usamos PRAGMA table_info para chequear antes de alterar.
//
// Patrón de AGENTS.md §5 — `ensureColumn()` para Turso. Acá el equivalente
// para D1 (la API es distinta: D1 usa prepare/bind/run, no execute/exec).

// Asegura que la columna exista en D1. Si ya existe, no hace nada.
// tableName y columnName se validan contra regex simple para evitar SQL
// injection (D1 no acepta parametrizar nombres de tabla/columna).
function SAFE_NAME_RE() {
  return /^[a-z_][a-z0-9_]{0,62}$/
}

function assertSafe(name) {
  if (!SAFE_NAME_RE().test(name)) {
    throw new Error(`dbMigrations: nombre SQL inválido ${JSON.stringify(name)}`)
  }
}

export async function ensureColumnD1(env, tableName, columnName, columnDefSql) {
  assertSafe(tableName)
  assertSafe(columnName)
  // columnDefSql no se valida contra regex (puede tener DEFAULT, NOT NULL,
  // CHECK, etc.). Confiamos en que viene de código, no de user input.
  const info = await env.DB.prepare(`PRAGMA table_info(${tableName})`).all()
  const exists = (info.results || []).some(r => r.name === columnName)
  if (exists) return
  await env.DB.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefSql}`).run()
}

// Aplica las columnas necesarias para Phase 2 de WFP.
// Idempotente — se puede llamar en cada request sin costo (PRAGMA es O(1)
// y el check termina early cuando las columnas ya están).
export async function applyWfpSchema(env) {
  await ensureColumnD1(env, 'htmlbox_boxes', 'wfp_status', `TEXT NOT NULL DEFAULT 'pending'`)
  await ensureColumnD1(env, 'htmlbox_boxes', 'wfp_error', `TEXT`)
}

// Aplica las columnas necesarias para el routing post-magic-link.
// Idempotente.
//   - htmlbox_magic_links.from: 'portal' | 'admin'. El loginConfirmHtml
//     redirige según este flag al origin correcto. Antes siempre iba
//     al portal — bug: si pedías el link desde /admin/ te redirigía al
//     portal y viceversa. Fix en routes/auth.js#postRequest + loginConfirmHtml.
export async function applyAuthSchema(env) {
  await ensureColumnD1(env, 'htmlbox_magic_links', 'from', `TEXT NOT NULL DEFAULT 'portal'`)
}
