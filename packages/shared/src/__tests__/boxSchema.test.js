// src/__tests__/boxSchema.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BOX_BASE_SCHEMA_SQL, applyBoxSchema, physicalTableSqlFor } from '../boxSchema.js'

test('BOX_BASE_SCHEMA_SQL declara las 4 tablas base', () => {
  for (const t of ['htmlbox_tables', 'htmlbox_schema_log', 'htmlbox_files', 'htmlbox_runs']) {
    assert.match(BOX_BASE_SCHEMA_SQL, new RegExp(`CREATE TABLE IF NOT EXISTS ${t}`))
  }
})

test('physicalTableSqlFor genera DDL correcto', () => {
  const sql = physicalTableSqlFor('ventas')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS htmlbox_ventas/)
  assert.match(sql, /data_json TEXT/)
})

test('physicalTableSqlFor rechaza slug inválido', () => {
  assert.throws(() => physicalTableSqlFor('VENTAS'))
  assert.throws(() => physicalTableSqlFor('1no'))
  assert.throws(() => physicalTableSqlFor('a; DROP TABLE--'))
})

// applyBoxSchema no se testea contra libsql real aquí (requiere driver).
// Sólo verificamos que con un mock de cliente, llama execute() por cada stmt.
test('applyBoxSchema invoca execute() por cada sentencia', async () => {
  const calls = []
  const fakeClient = {
    async execute(sql) { calls.push(sql) },
  }
  await applyBoxSchema(fakeClient)
  // 4 CREATE TABLE + 3 CREATE INDEX = 7 sentencias
  assert.ok(calls.length >= 7, `esperaba >=7 sentencias, recibí ${calls.length}`)
  // Todas son CREATE TABLE htmlbox_<x> o CREATE INDEX (IF NOT EXISTS) idx_htmlbox_<x>
  const norm = calls.map((c) => c.replace(/\s+/g, ' ').trim())
  const ok = norm.every((c) =>
    /^CREATE\s+TABLE\s+(IF NOT EXISTS\s+)?htmlbox_/i.test(c) ||
    /^CREATE\s+INDEX\s+(IF NOT EXISTS\s+)?idx_htmlbox_/i.test(c),
  )
  assert.ok(ok, `sentencias inesperadas: ${norm.filter((c) => !(
    /^CREATE\s+TABLE\s+(IF NOT EXISTS\s+)?htmlbox_/i.test(c) ||
    /^CREATE\s+INDEX\s+(IF NOT EXISTS\s+)?idx_htmlbox_/i.test(c)
  )).join(' | ')}`)
})