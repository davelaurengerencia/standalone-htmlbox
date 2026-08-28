// __tests__/dbMigrations.test.js — ensureColumnD1 idempotente + applyWfpSchema.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureColumnD1, applyWfpSchema } from '../lib/dbMigrations.js'

// Mock minimalista del D1 binding. Mantiene el state en memoria.
// Devuelve el objeto listo para wrappear como { DB } (el patrón de los
// handlers de control-plane). `_seedTable(name, cols)` permite simular
// que el schema base ya creó una tabla con ciertas columnas.
function makeD1() {
  const tables = {}
  function exec(sql) {
    // PRAGMA table_info(<table>) — devuelve filas { name, type, dflt_value, ... }
    const m = sql.match(/^PRAGMA\s+table_info\(([a-z_]+)\)/i)
    if (m) {
      const t = tables[m[1]] || {}
      const results = Object.keys(t).map(name => ({ name, ...t[name] }))
      return { all: async () => ({ results }), results }
    }
    // ALTER TABLE <t> ADD COLUMN <col> <def>
    const a = sql.match(/^ALTER\s+TABLE\s+([a-z_]+)\s+ADD\s+COLUMN\s+([a-z_]+)\s+(.+)$/i)
    if (a) {
      const [, t, c, def] = a
      if (!tables[t]) tables[t] = {}
      if (tables[t][c]) throw new Error(`duplicate column name: ${t}.${c}`)
      tables[t][c] = { type: def }
      return { run: async () => ({}) }
    }
    throw new Error(`Mock D1 no soporta: ${sql}`)
  }
  const d1 = {
    prepare(sql) {
      return {
        all: async () => {
          const r = exec(sql)
          if (r.all) return await r.all()
          return { results: r.results || [] }
        },
        run: async () => {
          const r = exec(sql)
          if (r.run) return await r.run()
          return {}
        },
      }
    },
    // Helper de test: sembrar una tabla con columnas pre-existentes.
    _seedTable(tableName, cols) {
      tables[tableName] = cols
    },
  }
  return d1
}

// Wraps un D1 mock como { DB } para que matchee la firma que las
// funciones esperan (env.DB.prepare).
function asEnv(d1) {
  return { DB: d1 }
}

test('ensureColumnD1: agrega columna cuando no existe', async () => {
  const d1 = makeD1()
  await ensureColumnD1(asEnv(d1), 'htmlbox_boxes', 'wfp_status', `TEXT NOT NULL DEFAULT 'pending'`)
  const info = await d1.prepare(`PRAGMA table_info(htmlbox_boxes)`).all()
  const cols = info.results.map(r => r.name)
  assert.ok(cols.includes('wfp_status'))
})

test('ensureColumnD1: idempotente (segunda llamada no hace nada)', async () => {
  const d1 = makeD1()
  await ensureColumnD1(asEnv(d1), 'htmlbox_boxes', 'wfp_status', `TEXT NOT NULL DEFAULT 'pending'`)
  // Segunda llamada no debería tirar duplicate column.
  await ensureColumnD1(asEnv(d1), 'htmlbox_boxes', 'wfp_status', `TEXT NOT NULL DEFAULT 'pending'`)
  const info = await d1.prepare(`PRAGMA table_info(htmlbox_boxes)`).all()
  const cols = info.results.filter(r => r.name === 'wfp_status')
  assert.equal(cols.length, 1, 'columna única después de 2 ensureColumnD1')
})

test('ensureColumnD1: múltiples columnas se agregan independientes', async () => {
  const d1 = makeD1()
  await ensureColumnD1(asEnv(d1), 'htmlbox_boxes', 'wfp_status', `TEXT NOT NULL DEFAULT 'pending'`)
  await ensureColumnD1(asEnv(d1), 'htmlbox_boxes', 'wfp_error', `TEXT`)
  const info = await d1.prepare(`PRAGMA table_info(htmlbox_boxes)`).all()
  const cols = info.results.map(r => r.name)
  assert.ok(cols.includes('wfp_status'))
  assert.ok(cols.includes('wfp_error'))
})

test('applyWfpSchema: agrega columnas a htmlbox_boxes que ya existe sin wfp_*', async () => {
  // Caso real del bug: el control-plane se deploya antes de que se cree
  // cualquier box, así que la tabla existe pero sin wfp_status / wfp_error.
  // applyWfpSchema() debe agregarlas sin tocar las columnas que ya están.
  const d1 = makeD1()
  d1._seedTable('htmlbox_boxes', {
    id: { type: 'TEXT' },
    slug: { type: 'TEXT' },
    workspace_id: { type: 'TEXT' },
    tenant_id: { type: 'TEXT' },
    visibility: { type: 'TEXT' },
    htmlbox_version: { type: 'INTEGER' },
    turso_status: { type: 'TEXT' },
    share_id: { type: 'TEXT' },
    name: { type: 'TEXT' },
    template: { type: 'TEXT' },
    created_by: { type: 'TEXT' },
  })
  await applyWfpSchema(asEnv(d1))
  const info = await d1.prepare(`PRAGMA table_info(htmlbox_boxes)`).all()
  const cols = info.results.map(r => r.name)
  assert.ok(cols.includes('wfp_status'), `wfp_status debe estar. cols: ${cols.join(',')}`)
  assert.ok(cols.includes('wfp_error'), `wfp_error debe estar. cols: ${cols.join(',')}`)
  // Las columnas preexistentes siguen intactas.
  assert.ok(cols.includes('id'))
  assert.ok(cols.includes('slug'))
})

test('applyWfpSchema: no-op si las columnas ya existen (idempotente en cualquier estado)', async () => {
  // El admin endpoint llama applyWfpSchema en CADA request. Verifico
  // que múltiples llamadas no fallen ni dupliquen columnas.
  const d1 = makeD1()
  d1._seedTable('htmlbox_boxes', {
    id: { type: 'TEXT' },
    wfp_status: { type: 'TEXT' },
    wfp_error: { type: 'TEXT' },
  })
  await applyWfpSchema(asEnv(d1))
  await applyWfpSchema(asEnv(d1))
  await applyWfpSchema(asEnv(d1))
  const info = await d1.prepare(`PRAGMA table_info(htmlbox_boxes)`).all()
  const cols = info.results.map(r => r.name)
  const wfpCount = cols.filter(c => c === 'wfp_status').length
  const errCount = cols.filter(c => c === 'wfp_error').length
  assert.equal(wfpCount, 1, 'wfp_status exactamente 1 vez')
  assert.equal(errCount, 1, 'wfp_error exactamente 1 vez')
})

test('ensureColumnD1: rechaza nombres de tabla/columna con SQL injection', async () => {
  const d1 = makeD1()
  await assert.rejects(
    () => ensureColumnD1(asEnv(d1), 'htmlbox_boxes; DROP TABLE x', 'wfp_status', `TEXT`),
    /nombre SQL inválido/
  )
  await assert.rejects(
    () => ensureColumnD1(asEnv(d1), 'htmlbox_boxes', 'wfp_status; --', `TEXT`),
    /nombre SQL inválido/
  )
  await assert.rejects(
    () => ensureColumnD1(asEnv(d1), 'MiTabla', 'col', `TEXT`),
    /nombre SQL inválido/
  )
})

test('applyWfpSchema: aplica wfp_status y wfp_error en htmlbox_boxes', async () => {
  const d1 = makeD1()
  await applyWfpSchema(asEnv(d1))
  const info = await d1.prepare(`PRAGMA table_info(htmlbox_boxes)`).all()
  const cols = info.results.map(r => r.name)
  assert.ok(cols.includes('wfp_status'))
  assert.ok(cols.includes('wfp_error'))
})

test('applyWfpSchema: idempotente (re-correr no rompe)', async () => {
  const d1 = makeD1()
  await applyWfpSchema(asEnv(d1))
  await applyWfpSchema(asEnv(d1))  // segunda llamada no debe tirar
  await applyWfpSchema(asEnv(d1))  // tercera tampoco
  const info = await d1.prepare(`PRAGMA table_info(htmlbox_boxes)`).all()
  const cols = info.results.map(r => r.name)
  assert.ok(cols.includes('wfp_status'))
  assert.ok(cols.includes('wfp_error'))
})

test('applyWfpSchema: si las columnas ya existen, es no-op (no ALTER duplicado)', async () => {
  const d1 = makeD1()
  // Simulamos que el schema base (0003_boxes.sql) ya corrió y creó la tabla
  // con todas las columnas, incluyendo las nuevas.
  d1._seedTable('htmlbox_boxes', {
    id: 'TEXT',
    wfp_status: `TEXT NOT NULL DEFAULT 'pending'`,
    wfp_error: `TEXT`,
  })
  // No debería tirar "duplicate column".
  await applyWfpSchema(asEnv(d1))
  // Las columnas siguen únicas.
  const info = await d1.prepare(`PRAGMA table_info(htmlbox_boxes)`).all()
  const wfpStatusCols = info.results.filter(r => r.name === 'wfp_status')
  assert.equal(wfpStatusCols.length, 1)
})
