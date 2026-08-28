// __tests__/authFirstUser.test.js — auto-promote del primer user a platform owner.
//
// Bug original: postConsume siempre creaba el user con is_platform_owner=0.
// El platform owner se auto-promueve por ser el primero en registrarse
// (no hay nadie que lo invite, así que tiene que poder crear tenants).
//
// Estos tests cubren el flujo de auto-provisioning en postConsume:
//   - D1 vacía → nuevo user con is_platform_owner=1
//   - D1 con un user existente → nuevo user con is_platform_owner=0
//   - User existente (ya en la DB) se respeta sin tocar is_platform_owner
//
// La lógica vive en packages/control-plane/src/routes/auth.js#postConsume.

import { test } from 'node:test'
import assert from 'node:assert/strict'

// ============ D1 mock minimalista ============

function makeD1() {
  const tables = {}

  // Helper: ejecuta el SQL contra el mock y devuelve { kind, value }.
  function exec(sql, args) {
    // SELECT count(*) AS n FROM <table>
    let m = sql.match(/^SELECT\s+count\(\*\)\s+AS\s+n\s+FROM\s+(\w+)/i)
    if (m) return { kind: 'first', value: { n: (tables[m[1]] || []).length } }

    // SELECT <cols> FROM <table> WHERE <col> = ?
    m = sql.match(/^SELECT\s+(.+?)\s+FROM\s+(\w+)\s+WHERE\s+(\w+)\s*=\s*\?/i)
    if (m) {
      let cols
      if (m[1].trim() === '*') {
        // SELECT *: devolver todas las columnas de la primera fila.
        const rows = tables[m[2]] || []
        const row = rows.find((r) => r[m[3]] === args[0])
        if (!row) return { kind: 'first', value: null }
        return { kind: 'first', value: { ...row } }
      } else {
        cols = m[1].split(',').map((c) => c.trim()
          .replace(/.*\bas\s+/i, '').replace(/\s+as\s+/i, '')
          .replace(/^"|"$/g, ''))
      }
      const whereCol = m[3]
      const whereVal = args[0]
      const rows = tables[m[2]] || []
      const row = rows.find((r) => r[whereCol] === whereVal)
      if (!row) return { kind: 'first', value: null }
      const out = {}
      cols.forEach((c) => { out[c] = row[c] })
      return { kind: 'first', value: out }
    }

    // INSERT INTO <table> (<cols>) VALUES (?,?,?)
    m = sql.match(/^INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i)
    if (m) {
      const table = m[1]
      const cols = m[2].split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
      if (!tables[table]) tables[table] = []
      const row = {}
      cols.forEach((c, i) => { row[c] = args[i] })
      tables[table].push(row)
      return { kind: 'run', value: { success: true, meta: { changes: 1 } } }
    }

    // UPDATE <table> SET <col> = ? WHERE <col> = ?
    m = sql.match(/^UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+(.+)$/i)
    if (m) {
      const table = m[1]
      const setClause = m[2]
      const whereClause = m[3]
      const colMatch = setClause.match(/^(\w+)\s*=\s*\?$/i)
      if (colMatch && whereClause.match(/^\w+\s*=\s*\?$/)) {
        const setCol = colMatch[1]
        const whereCol = whereClause.split(/\s*=\s*/)[0]
        const setVal = args[0]
        const whereVal = args[1]
        let changes = 0
        for (const row of (tables[table] || [])) {
          if (row[whereCol] === whereVal) {
            row[setCol] = setVal
            changes++
          }
        }
        return { kind: 'run', value: { success: true, meta: { changes } } }
      }
    }

    throw new Error(`Mock D1 no soporta: ${sql}`)
  }

  function makeStmt(args, sql) {
    return {
      run: async () => {
        const r = exec(sql, args)
        if (r.kind !== 'run') throw new Error(`expected run, got first: ${sql}`)
        return r.value
      },
      first: async () => {
        const r = exec(sql, args)
        if (r.kind !== 'first') throw new Error(`expected first, got run: ${sql}`)
        return r.value
      },
    }
  }

  return {
    prepare(sql) {
      return {
        bind(...args) { return makeStmt(args, sql) },
        // Algunos paths (y tests) llaman a .first()/.run() sin bind.
        first: (...args) => makeStmt(args, sql).first(),
        run: (...args) => makeStmt(args, sql).run(),
      }
    },
    _tables: tables,
  }
}

// ============ postConsume — la lógica que vamos a testear ============

// Mirror literal del bloque de auto-provisioning en auth.js#postConsume.
// Si cambia allá, hay que cambiar acá.
async function postConsumeProvisioning(env, email) {
  // 1. SELECT user existente.
  let user = await env.DB.prepare(
    `SELECT id, email, display_name, tenant_id, is_platform_owner FROM htmlbox_users WHERE email = ?1`
  ).bind(email).first()
  if (user) return { user, wasProvisioned: false }

  // 2. ¿Es el primer user?
  const countRow = await env.DB.prepare(
    `SELECT count(*) AS n FROM htmlbox_users`
  ).first()
  const isFirstUser = (countRow?.n ?? 0) === 0

  // 3. INSERT.
  const newId = `user_${Math.random().toString(36).slice(2, 22)}`
  await env.DB.prepare(
    `INSERT INTO htmlbox_users (id, email, is_platform_owner) VALUES (?1, ?2, ?3)`
  ).bind(newId, email, isFirstUser ? 1 : 0).run()

  user = { id: newId, email, display_name: null, tenant_id: null, is_platform_owner: isFirstUser ? 1 : 0 }
  return { user, wasProvisioned: true }
}

// ============ Tests ============

test('D1 vacía → primer user auto-promovido a platform_owner=1', async () => {
  const d1 = makeD1()
  const env = { DB: d1 }
  const { user, wasProvisioned } = await postConsumeProvisioning(env, 'first@x.com')
  assert.equal(wasProvisioned, true)
  assert.equal(user.is_platform_owner, 1)
  // Verifico que la fila en la DB tiene is_platform_owner=1.
  const stored = await d1.prepare('SELECT * FROM htmlbox_users WHERE email = ?1').bind('first@x.com').first()
  assert.equal(stored.is_platform_owner, 1)
})

test('D1 con 1 user existente → nuevo user queda con is_platform_owner=0', async () => {
  const d1 = makeD1()
  d1._tables.htmlbox_users = [
    { id: 'user_existing', email: 'first@x.com', is_platform_owner: 1, tenant_id: null, display_name: null },
  ]
  const env = { DB: d1 }
  const { user, wasProvisioned } = await postConsumeProvisioning(env, 'second@x.com')
  assert.equal(wasProvisioned, true)
  assert.equal(user.is_platform_owner, 0)
})

test('D1 con muchos users → todos los nuevos quedan en is_platform_owner=0', async () => {
  const d1 = makeD1()
  d1._tables.htmlbox_users = [
    { id: 'u1', email: 'a@x.com', is_platform_owner: 1, tenant_id: null, display_name: null },
    { id: 'u2', email: 'b@x.com', is_platform_owner: 0, tenant_id: null, display_name: null },
    { id: 'u3', email: 'c@x.com', is_platform_owner: 0, tenant_id: null, display_name: null },
  ]
  const env = { DB: d1 }
  const { user } = await postConsumeProvisioning(env, 'd@x.com')
  assert.equal(user.is_platform_owner, 0, 'members no se auto-promueven')
})

test('User ya existe → SELECT lo trae, no se hace INSERT, is_platform_owner se preserva', async () => {
  const d1 = makeD1()
  d1._tables.htmlbox_users = [
    { id: 'user_old', email: 'old@x.com', is_platform_owner: 0, tenant_id: null, display_name: null },
  ]
  const env = { DB: d1 }
  const { user, wasProvisioned } = await postConsumeProvisioning(env, 'old@x.com')
  assert.equal(wasProvisioned, false, 'no se provisiona de nuevo')
  assert.equal(user.id, 'user_old')
  assert.equal(user.is_platform_owner, 0, 'preserva el valor original — no se pisa')
  assert.equal(d1._tables.htmlbox_users.length, 1, 'no se duplicó la fila')
})

test('User con is_platform_owner=1 ya en DB → SELECT lo trae sin tocar', async () => {
  const d1 = makeD1()
  d1._tables.htmlbox_users = [
    { id: 'user_existing', email: 'p@x.com', is_platform_owner: 1, tenant_id: null, display_name: null },
  ]
  const env = { DB: d1 }
  const { user, wasProvisioned } = await postConsumeProvisioning(env, 'p@x.com')
  assert.equal(wasProvisioned, false)
  assert.equal(user.is_platform_owner, 1)
})

test('Race: dos signups consecutivos en DB vacía → el segundo queda en 0', async () => {
  // Simula el race window del comentario en auth.js. Los dos signups son
  // secuenciales (no paralelos), pero ambos ven la DB en estados
  // diferentes (vacía / con 1 fila). El segundo se auto-provisiona con
  // is_platform_owner=0.
  const d1 = makeD1()
  const env = { DB: d1 }
  const r1 = await postConsumeProvisioning(env, 'first@x.com')
  assert.equal(r1.user.is_platform_owner, 1, 'primer request → 1')
  const r2 = await postConsumeProvisioning(env, 'second@x.com')
  assert.equal(r2.user.is_platform_owner, 0, 'segundo request → 0')
  assert.equal(d1._tables.htmlbox_users.length, 2)
})