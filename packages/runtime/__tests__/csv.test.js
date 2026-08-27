// __tests__/csv.test.js — parser CSV.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv } from '../src/lib/csv.js'

test('parseCsv básico: headers + una fila', () => {
  const r = parseCsv('name,age\nAlice,30\n')
  assert.deepEqual(r.headers, ['name', 'age'])
  assert.equal(r.rowCount, 1)
  assert.deepEqual(r.rows[0], { name: 'Alice', age: '30' })
})

test('parseCsv campos con comillas', () => {
  const r = parseCsv('name,description\nFoo,"hola, mundo"\n')
  assert.deepEqual(r.rows[0], { name: 'Foo', description: 'hola, mundo' })
})

test('parseCsv comillas escapadas', () => {
  const r = parseCsv('name,note\nBob,"dijo ""hola"""\n')
  assert.deepEqual(r.rows[0], { name: 'Bob', note: 'dijo "hola"' })
})

test('parseCsv \\r\\n', () => {
  const r = parseCsv('a,b\r\n1,2\r\n3,4\r\n')
  assert.equal(r.rowCount, 2)
  assert.deepEqual(r.rows[0], { a: '1', b: '2' })
})

test('parseCsv string vacío', () => {
  const r = parseCsv('')
  assert.deepEqual(r.headers, [])
  assert.equal(r.rowCount, 0)
})

test('parseCsv campos con saltos de línea entre comillas', () => {
  const r = parseCsv('a,b\nfoo,"l1\nl2"\nbar,x\n')
  assert.equal(r.rowCount, 2)
  assert.equal(r.rows[0].b, 'l1\nl2')
})

test('parseCsv rechaza input no-string', () => {
  assert.ok(parseCsv(null).error)
  assert.ok(parseCsv(42).error)
})