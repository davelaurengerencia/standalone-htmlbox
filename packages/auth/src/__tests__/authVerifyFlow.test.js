// __tests__/authVerifyFlow.test.js — Paso 5: smoke test del flow auth-verify.
//
// Cubre la página "Verificando…" que el browser ve cuando abre el magic link.
// El flow:
//   1. Lee el token del query string
//   2. Hace peek al magic link en D1
//   3. Si válido → renderiza HTML con <script> que postea a /api/auth/consume
//   4. Si inválido → renderiza HTML con error
//
// Acá solo validamos que el HTML se renderiza bien. El flow auth-consume
// (que el <script> invoca) tiene sus propios tests.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFlowEngineApp } from 'flow-engine/app'

import authVerifyFlowJSON from '../flows/auth-verify.flow.json' with { type: 'json' }

function makeFakeD1(opts = {}) {
  const calls = []
  const stub = {
    prepare(sql) {
      const stmt = { _sql: sql }
      stmt.bind = (...args) => { stmt._args = args; return stmt }
      stmt.first = async () => {
        calls.push({ sql: stmt._sql, args: stmt._args })
        // peek token
        if (/SELECT email, used_at FROM htmlbox_magic_links/i.test(stmt._sql)) {
          if (opts.tokenValid === false) return null
          if (opts.tokenUsed) return { email: opts.tokenEmail || 'test@example.com', used_at: '2026-08-28 10:00:00' }
          return { email: opts.tokenEmail || 'test@example.com', used_at: null }
        }
        return null
      }
      stmt.run = async () => ({ meta: { changes: 1 } })
      stmt.all = async () => ({ results: [] })
      return stmt
    },
  }
  return { db: stub, calls }
}

async function runVerify(db, queryString = '') {
  const app = await createFlowEngineApp({
    runtime: 'worker',
    flows: { 'auth-verify': authVerifyFlowJSON },
    configNodes: [],
    mountPath: '/api/flows',
    httpNodeRoot: '/api/flows',
    exposeErrorDetails: true,
    defaultTenantId: 't',
    defaultProjectId: 'p',
  })
  const url = `http://flow-engine.local/api/flows/auth-verify${queryString}`
  const req = new Request(url, {
    method: 'GET',
    headers: { host: 'auth.localhost:8785' },
  })
  const env = { DB: db, HTMLBOX_ENV: 'development' }
  return await app.handleWorker(req, env, {})
}

test('auth-verify: token válido → renderiza HTML "Verificando…" con <script> de consume', async () => {
  const { db, calls } = makeFakeD1({ tokenValid: true, tokenEmail: 'valid@example.com' })
  const res = await runVerify(db, '?token=validtokenhex123')
  assert.equal(res.status, 200)
  const body = await res.text()
  assert.equal(res.headers.get('Content-Type'), 'text/html; charset=utf-8')
  // HTML contiene el título y el form
  assert.match(body, /Verificando tu link/)
  assert.match(body, /<p id="status">/)
  // Script que va a postear a /api/auth/consume
  assert.match(body, /\/api\/auth\/consume/)
  // Token interpolado en el script (con quotes por JSON.stringify)
  assert.match(body, /token:\s*"validtokenhex123"/)
  // data.destUrl redirige al destino
  assert.match(body, /data\.destUrl/)
  // D1: 1 SELECT a magic_links
  assert.equal(calls.length, 1)
  assert.match(calls[0].sql, /SELECT email, used_at FROM htmlbox_magic_links/i)
  assert.equal(calls[0].args[0], 'validtokenhex123', 'token pasado como bind')
})

test('auth-verify: token inválido (no existe o expiró) → renderiza HTML de error', async () => {
  const { db } = makeFakeD1({ tokenValid: false })
  const res = await runVerify(db, '?token=nonexistent')
  assert.equal(res.status, 200)
  const body = await res.text()
  assert.match(body, /Link no v\u00e1lido/)
  assert.match(body, /Motivo: invalid_or_expired_token/)
  assert.doesNotMatch(body, /api\/auth\/consume/, 'no debe tener el script de consume')
})

test('auth-verify: token ya usado → renderiza HTML de error con already_used', async () => {
  const { db } = makeFakeD1({ tokenUsed: true })
  const res = await runVerify(db, '?token=alreadusedtoken')
  assert.equal(res.status, 200)
  const body = await res.text()
  assert.match(body, /Link no v\u00e1lido/)
  assert.match(body, /Motivo: already_used/)
})

test('auth-verify: sin query string → renderiza error "invalid_token"', async () => {
  const { db, calls } = makeFakeD1({ tokenValid: false })
  const res = await runVerify(db, '')
  assert.equal(res.status, 200)
  const body = await res.text()
  assert.match(body, /Link no v\u00e1lido/)
  // peek_token runs with empty string token — returns null (no row with id='').
  assert.equal(calls.length, 1, 'igual ejecuta peek_token (con bind=empty string)')
  assert.equal(calls[0].args[0], '', 'token vacío como bind')
})

test('auth-verify: el HTML de éxito escapa correctamente el token (no XSS)', async () => {
  // El token viene de JSON.stringify que ya lo escapa. Pero validamos que
  // un token con chars raros no rompe el HTML.
  const tokenWithSpecialChars = 'abc"; </script><script>alert(1)</script>'
  const { db } = makeFakeD1({ tokenValid: true })
  const res = await runVerify(db, `?token=${encodeURIComponent(tokenWithSpecialChars)}`)
  const body = await res.text()
  // El token se inserta vía JSON.stringify, así que caracteres peligrosos se escapan.
  assert.match(body, /token:\s*".*alert\(1\)/, 'token interpolado con escape JSON')
  assert.ok(!body.includes('<script>alert(1)</script>'),
    'el <script> inyectado en el token NO debe ejecutarse (escape JSON)')
})
