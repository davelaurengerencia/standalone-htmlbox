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
// Idempotente. El nombre original 'from' era palabra reservada en SQL
// (FROM keyword) — renombramos a 'origin' en código + DB. Si una DB vieja
// tiene la columna 'from' (intento previo que falló silenciosamente por
// syntax error), la renombramos acá.
export async function applyAuthSchema(env) {
  // PRAGMA: ver qué columnas existen actualmente.
  const info = await env.DB.prepare('PRAGMA table_info(htmlbox_magic_links)').all()
  const cols = new Set((info.results || []).map((r) => r.name))
  // Si la DB tiene la columna vieja 'from' (de un intento previo), la
  // renombramos. RENAME COLUMN requiere SQLite 3.25+ — D1 usa 3.39, OK.
  if (cols.has('from') && !cols.has('origin')) {
    await env.DB.prepare('ALTER TABLE htmlbox_magic_links RENAME COLUMN "from" TO "origin"').run()
    cols.delete('from')
    cols.add('origin')
  }
  // Si después de la transición no tenemos 'origin', la creamos.
  if (!cols.has('origin')) {
    await env.DB.prepare(`ALTER TABLE htmlbox_magic_links ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'portal'`).run()
  }
}
