// __tests__/authFromRouting.test.js — el bug del post-login redirect.
//
// Síntoma original: el user abría /admin/, pedía magic link, lo consumía,
// y el confirmHtml lo redirigía al portal (HTMLBOX_PORTAL_ORIGIN). Tendría
// que quedarse en /admin/.
//
// Fix: el request incluye from='admin' | 'portal'. createMagicLink persiste
// esa info en la columna `origin` (antes se llamaba `from`, pero `from` es
// palabra reservada SQL — FROM keyword — y rompía INSERT/SELECT/ALTER con
// syntax error). peekMagicLink devuelve `origin`, y loginConfirmHtml
// redirige según origin.
//
// Estos tests cubren:
//   - createMagicLink persiste origin (default 'portal' si falta)
//   - peekMagicLink devuelve origin (default 'portal' si la fila es vieja)
//   - createMagicLink rechaza valores raros (security)
//
// La lógica vive en:
//   - packages/control-plane/src/lib/session.js  (create/peek)
//   - packages/control-plane/src/routes/auth.js  (loginConfirmHtml)
//   - packages/control-plane/src/lib/dbMigrations.js  (applyAuthSchema —
//     migración rename de 'from' → 'origin')

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMagicLink, peekMagicLink } from '../lib/session.js'

// ============ D1 mock minimalista ============
//
// Soporta:
//   - prepare(sql).bind(...).run()       para INSERTs
//   - prepare(sql).bind(...).first()     para SELECTs (toma la primera row)
//
// Solo cubre los queries que usan createMagicLink/peekMagicLink.

function makeD1() {
  const tables = {}
  const exec = (sql, bindings) => {
    // INSERT INTO htmlbox_magic_links (id, email, expires_at, origin) VALUES (...)
    const m = sql.match(/^INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)/i)
    if (m) {
      const table = m[1]
      const cols = m[2].split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
      if (!tables[table]) tables[table] = []
      const row = {}
      cols.forEach((c, i) => { row[c] = bindings[i] })
      tables[table].push(row)
      return { kind: 'run', changes: 1 }
    }
    // SELECT (datetime(?1) > datetime('now')) AS ok — usado por peekMagicLink.
    const validity = sql.match(/SELECT\s+\(datetime\(\?1\)\s+>\s+datetime\('now'\)\)\s+AS\s+ok/i)
    if (validity) {
      return { kind: 'first', value: { ok: tables._validity?.ok ?? 1 } }
    }
    // SELECT ... FROM htmlbox_magic_links ...
    const sel = sql.match(/^SELECT\s+(.+?)\s+FROM\s+(\w+)(?=\s+WHERE|\s+ORDER|\s+GROUP|\s+LIMIT|\s*$|\s*;)/i)
    if (sel) {
      const table = sel[2]
      const cols = sel[1].split(',').map((c) => c.trim().replace(/.*\bas\s+/i, '').replace(/\s+as\s+/i, '').replace(/^"|"$/g, ''))
      const rows = tables[table] || []
      const row = rows[0]
      if (!row) return { kind: 'first', value: null }
      const out = {}
      cols.forEach((c) => { out[c] = row[c] })
      return { kind: 'first', value: out }
    }
    throw new Error(`Mock D1 no soporta: ${sql}`)
  }
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            run: async () => {
              const r = exec(sql, args)
              if (r.kind !== 'run') throw new Error('expected run, got first')
              return { success: true, meta: { changes: r.changes } }
            },
            first: async () => {
              const r = exec(sql, args)
              if (r.kind !== 'first') throw new Error('expected first, got run')
              return r.value
            },
          }
        },
      }
    },
    _tables: tables,
    _setValidityOk(v) { tables._validity = { ok: v ? 1 : 0 } },
  }
}

// ============ createMagicLink + peekMagicLink ============

test('createMagicLink persiste origin="admin" cuando se pasa explícito', async () => {
  const d1 = makeD1()
  const env = { DB: d1 }
  const link = await createMagicLink(env, 'a@x.com', 'admin')
  assert.equal(link.origin, 'admin')
  const peek = await peekMagicLink(env, link.id)
  assert.equal(peek.ok, true)
  assert.equal(peek.origin, 'admin')
  assert.equal(peek.email, 'a@x.com')
})

test('createMagicLink persiste origin="portal" cuando se pasa', async () => {
  const d1 = makeD1()
  const env = { DB: d1 }
  const link = await createMagicLink(env, 'a@x.com', 'portal')
  assert.equal(link.origin, 'portal')
  const peek = await peekMagicLink(env, link.id)
  assert.equal(peek.origin, 'portal')
})

test('createMagicLink default = portal cuando NO se pasa origin', async () => {
  const d1 = makeD1()
  const env = { DB: d1 }
  const link = await createMagicLink(env, 'a@x.com')
  assert.equal(link.origin, 'portal', 'backward compat: rows viejas con default portal')
  const peek = await peekMagicLink(env, link.id)
  assert.equal(peek.origin, 'portal')
})

test('createMagicLink rechaza valores raros (security: solo admin|portal)', async () => {
  const d1 = makeD1()
  const env = { DB: d1 }
  for (const bad of ['ADMIN', 'admin; javascript:alert(1)', '../../etc/passwd', '', null, undefined]) {
    const link = await createMagicLink(env, 'a@x.com', bad)
    assert.equal(link.origin, 'portal', `origin inválido ${JSON.stringify(bad)} → portal (default)`)
  }
})

test('peekMagicLink default origin=portal si la fila no tiene la columna', async () => {
  // Simula una fila creada antes del fix (sin columna `origin`).
  const d1 = makeD1()
  d1._tables.htmlbox_magic_links = [{
    id: 'old_token',
    email: 'a@x.com',
    expires_at: '2099-12-31 00:00:00',
    used_at: null,
    // NOTA: sin `origin` — simula fila pre-migration.
  }]
  const env = { DB: d1 }
  const peek = await peekMagicLink(env, 'old_token')
  assert.equal(peek.ok, true)
  assert.equal(peek.origin, 'portal', 'peek debe normalizar filas viejas a portal')
})

test('peekMagicLink: token inexistente devuelve ok=false', async () => {
  const d1 = makeD1()
  const env = { DB: d1 }
  const peek = await peekMagicLink(env, 'nonexistent')
  assert.equal(peek.ok, false)
})

test('createMagicLink NO usa "from" como columna SQL (regression test del bug)', async () => {
  // Introspección sobre el source: si alguien cambia el código de vuelta
  // a `from`, este test falla — la idea es que el nombre SQL-safe quede
  // explícito en el código Y en el test.
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const url = await import('node:url')
  const here = path.dirname(url.fileURLToPath(import.meta.url))
  const sessionSource = await fs.readFile(path.join(here, '..', 'lib', 'session.js'), 'utf8')
  // INSERT y SELECT deben referenciar "origin" — NUNCA "from".
  assert.match(sessionSource, /INSERT INTO htmlbox_magic_links[^)]*\borigin\b/i,
    'INSERT debe usar columna origin (NO from — bug del FROM keyword SQL)')
  assert.match(sessionSource, /SELECT[^]*\borigin\b[^]*FROM htmlbox_magic_links/i,
    'SELECT debe usar columna origin (NO from)')
})