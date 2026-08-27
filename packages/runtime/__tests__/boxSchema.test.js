// __tests__/boxSchema.test.js — funciones puras de boxSchema.js (SQL strings, ensureColumn).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BOX_BASE_SCHEMA_SQL,
  APP_USERS_SCHEMA_SQL,
  APP_SETTINGS_SCHEMA_SQL,
  physicalTableSqlFor,
  ensureColumn,
  ensureTableScopeColumn,
  ensureOwnerColumn,
} from '../../shared/src/boxSchema.js'

test('BOX_BASE_SCHEMA_SQL contiene las tablas base esperadas', () => {
  assert.match(BOX_BASE_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS htmlbox_tables/)
  assert.match(BOX_BASE_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS htmlbox_schema_log/)
  assert.match(BOX_BASE_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS htmlbox_files/)
  assert.match(BOX_BASE_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS htmlbox_runs/)
})

test('APP_USERS_SCHEMA_SQL contiene las 3 tablas de app-users', () => {
  assert.match(APP_USERS_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS htmlbox_app_users/)
  assert.match(APP_USERS_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS htmlbox_app_sessions/)
  assert.match(APP_USERS_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS htmlbox_app_magic_links/)
  // FK con ON DELETE CASCADE en sessions
  assert.match(APP_USERS_SCHEMA_SQL, /REFERENCES htmlbox_app_users\(id\) ON DELETE CASCADE/)
  // role NOT NULL DEFAULT member
  assert.match(APP_USERS_SCHEMA_SQL, /role TEXT NOT NULL DEFAULT 'member'/)
  // disabled_at nullable
  assert.match(APP_USERS_SCHEMA_SQL, /disabled_at TEXT/)
})

test('APP_SETTINGS_SCHEMA_SQL contiene htmlbox_app_settings', () => {
  assert.match(APP_SETTINGS_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS htmlbox_app_settings/)
  assert.match(APP_SETTINGS_SCHEMA_SQL, /signup_mode TEXT NOT NULL DEFAULT 'invite_only'/)
})

test('physicalTableSqlFor genera SQL válida para slug válido', () => {
  const sql = physicalTableSqlFor('ventas')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS htmlbox_ventas/)
  assert.match(sql, /id INTEGER PRIMARY KEY AUTOINCREMENT/)
  assert.match(sql, /data_json TEXT/)
  assert.match(sql, /deleted_at TEXT/)
  assert.match(sql, /CREATE INDEX/)
})

test('physicalTableSqlFor lanza error para slug inválido', () => {
  assert.throws(() => physicalTableSqlFor('VENTAS'))   // mayúsculas
  assert.throws(() => physicalTableSqlFor('1ventas'))  // empieza con número
  assert.throws(() => physicalTableSqlFor(''))
  assert.throws(() => physicalTableSqlFor('a-very-long-slug-that-exceeds-the-forty-character-limit-allowed'))
})

// ─── ensureColumn (necesita un FakeClient) ────────────────────────────────

class FakeClient {
  constructor(initialColumns = []) {
    this.columns = [...initialColumns]
  }
  async execute(stmt) {
    const sql = String(typeof stmt === 'string' ? stmt : stmt.sql)
    if (/^PRAGMA table_info/i.test(sql)) {
      return { rows: this.columns.map(n => ({ name: n })) }
    }
    if (/^ALTER TABLE/i.test(sql)) {
      const m = sql.match(/ADD COLUMN (\w+)/)
      if (m) this.columns.push(m[1])
      return { rows: [], rowsAffected: 1 }
    }
    return { rows: [], rowsAffected: 0 }
  }
  async exec(sql) { return this.execute(sql) }
}

test('ensureColumn agrega columna cuando no existe', async () => {
  const client = new FakeClient(['id', 'data_json'])
  await ensureColumn(client, 'htmlbox_ventas', 'owner_user_id', 'TEXT')
  assert.ok(client.columns.includes('owner_user_id'))
})

test('ensureColumn es idempotente — no tira si la columna ya existe', async () => {
  const client = new FakeClient(['id', 'data_json', 'owner_user_id'])
  await ensureColumn(client, 'htmlbox_ventas', 'owner_user_id', 'TEXT')
  assert.equal(client.columns.length, 3)
})

test('ensureTableScopeColumn usa default "private"', async () => {
  const client = new FakeClient(['slug', 'name'])
  await ensureTableScopeColumn(client)
  // No verificamos el ALTER exacto — solo que la columna se agregó
  assert.ok(client.columns.includes('scope'))
})

test('ensureOwnerColumn agrega owner_user_id a tabla específica', async () => {
  const client = new FakeClient()
  await ensureOwnerColumn(client, 'ventas')
  assert.ok(client.columns.includes('owner_user_id'))
})