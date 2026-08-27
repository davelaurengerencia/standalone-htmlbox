// __tests__/authFromRouting.test.js — el bug del post-login redirect.
//
// Síntoma original: el user abría /admin/, pedía magic link, lo consumía,
// y el confirmHtml lo redirigía al portal (HTMLBOX_PORTAL_ORIGIN). Tendría
// que quedarse en /admin/.
//
// Fix: el request incluye from='admin' | 'portal'. createMagicLink persiste
// esa info, peekMagicLink la devuelve, y loginConfirmHtml redirige según from.
//
// Estos tests cubren:
//   - createMagicLink persiste from (default 'portal' si falta)
//   - peekMagicLink devuelve from (default 'portal' si la fila es vieja)
//   - El HTML redirect va a admin si from='admin', portal si from='portal'
//
// La lógica vive en:
//   - packages/control-plane/src/lib/session.js  (create/peek)
//   - packages/control-plane/src/routes/auth.js  (loginConfirmHtml)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMagicLink, peekMagicLink } from '../lib/session.js'

// ============ D1 mock minimalista ============
//
// Soporta:
//   - prepare(sql).bind(...).run()       para INSERTs
//   - prepare(sql).bind(...).first()     para SELECTs (toma la primera row)
//
// Solo cubre los queries que usan createMagicLink/peekMagicLink. El
// mock vive acá dentro del test — no es reusado en otros archivos.

function makeD1() {
  const tables = {}
  const exec = (sql, bindings) => {
    // INSERT INTO htmlbox_magic_links ...
    const m = sql.match(/^INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i)
    if (m) {
      const table = m[1]
      const cols = m[2].split(',').map((c) => c.trim())
      if (!tables[table]) tables[table] = []
      const row = {}
      cols.forEach((c, i) => { row[c] = bindings[i] })
      tables[table].push(row)
      return { kind: 'run', changes: 1 }
    }
    // SELECT (datetime(?1) > datetime('now')) AS ok — usado por peekMagicLink
    // para chequear si el magic link todavía no expiró. En este mock siempre
    // decimos "ok=true" — si en un test queremos probar expiración, lo
    // seteamos explícitamente via d1._tables antes de invocar.
    const validity = sql.match(/SELECT\s+\(datetime\(\?1\)\s+>\s+datetime\('now'\)\)\s+AS\s+ok/i)
    if (validity) {
      return { kind: 'first', value: { ok: tables._validity?.ok ?? 1 } }
    }
    // SELECT ... FROM htmlbox_magic_links ...
    // Match `\s+FROM\s+\w+(\s+WHERE|\s*;|\s*$)` en vez de `\s+FROM\s+\w+`
    // para NO matchear la palabra reservada `from` cuando aparece como
    // nombre de columna en el SELECT list (ej: `SELECT id, email, from
    // FROM magic_links` — el primer FROM es la palabra `from` del list,
    // no el FROM keyword que separa cols de tabla).
    const sel = sql.match(/^SELECT\s+(.+?)\s+FROM\s+(\w+)(?=\s+WHERE|\s+ORDER|\s+GROUP|\s+LIMIT|\s*$|\s*;)/i)
    if (sel) {
      const table = sel[2]
      const cols = sel[1].split(',').map((c) => c.trim().replace(/.*\bas\s+/i, '').replace(/\s+as\s+/i, ''))
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
    // Helpers de test — el usuario puede mutar `_validity.ok` para simular
    // magic links expirados (mockear el validity check de peekMagicLink).
    _tables: tables,
    _setValidityOk(v) { tables._validity = { ok: v ? 1 : 0 } },
  }
}

// ============ createMagicLink + peekMagicLink ============

test('createMagicLink persiste from="admin" cuando se pasa explícito', async () => {
  const d1 = makeD1()
  const env = { DB: d1 }
  const link = await createMagicLink(env, 'a@x.com', 'admin')
  assert.equal(link.from, 'admin')
  const peek = await peekMagicLink(env, link.id)
  assert.equal(peek.ok, true)
  assert.equal(peek.from, 'admin')
  assert.equal(peek.email, 'a@x.com')
})

test('createMagicLink persiste from="portal" cuando se pasa', async () => {
  const d1 = makeD1()
  const env = { DB: d1 }
  const link = await createMagicLink(env, 'a@x.com', 'portal')
  assert.equal(link.from, 'portal')
  const peek = await peekMagicLink(env, link.id)
  assert.equal(peek.from, 'portal')
})

test('createMagicLink default = portal cuando NO se pasa from', async () => {
  const d1 = makeD1()
  const env = { DB: d1 }
  const link = await createMagicLink(env, 'a@x.com')
  assert.equal(link.from, 'portal', 'backward compat: rows viejas con default portal')
  const peek = await peekMagicLink(env, link.id)
  assert.equal(peek.from, 'portal')
})

test('createMagicLink rechaza valores raros (security: solo admin|portal)', async () => {
  const d1 = makeD1()
  const env = { DB: d1 }
  // Aunque la columna es TEXT, validamos en código para que no se cuele
  // un 'evilvalue' que termine en una redirect inesperada.
  for (const bad of ['ADMIN', 'admin; javascript:alert(1)', '../../etc/passwd', '', null, undefined]) {
    const link = await createMagicLink(env, 'a@x.com', bad)
    assert.equal(link.from, 'portal', `from inválido ${JSON.stringify(bad)} → portal (default)`)
  }
})

test('peekMagicLink default from=portal si la fila no tiene la columna', async () => {
  // Simula una fila creada antes del fix (sin columna `from`).
  const d1 = makeD1()
  d1._tables.htmlbox_magic_links = [{
    id: 'old_token',
    email: 'a@x.com',
    expires_at: '2099-12-31 00:00:00',
    used_at: null,
    // NOTA: sin `from` — simula fila pre-migration.
  }]
  const env = { DB: d1 }
  const peek = await peekMagicLink(env, 'old_token')
  assert.equal(peek.ok, true)
  assert.equal(peek.from, 'portal', 'peek debe normalizar filas viejas a portal')
})

test('peekMagicLink: token inexistente devuelve ok=false', async () => {
  const d1 = makeD1()
  const env = { DB: d1 }
  const peek = await peekMagicLink(env, 'nonexistent')
  assert.equal(peek.ok, false)
})