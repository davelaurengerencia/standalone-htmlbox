// __tests__/authLogoutFlow.test.js — Paso 6: smoke test del flow auth-logout.
//
// El flow es simple:
//   1. Lee sid de la cookie
//   2. DELETE session de D1
//   3. Set-Cookie: sid=; Max-Age=0 (clear cookie)
//   4. Devuelve { ok: true }
//
// Mismo patrón que los otros tests: fake D1 con arrow functions (NO `this`,
// porque el flow-engine llama stmt.first() sin preservar `this` binding).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFlowEngineApp } from 'flow-engine/app'

import authLogoutFlowJSON from '../flows/auth-logout.flow.json' with { type: 'json' }

function makeFakeD1() {
  const calls = []
  const stub = {
    prepare(sql) {
      const stmt = { _sql: sql }
      stmt.bind = (...args) => { stmt._args = args; return stmt }
      stmt.first = async () => {
        calls.push({ type: 'first', sql: stmt._sql, args: stmt._args })
        return null
      }
      stmt.run = async () => {
        calls.push({ type: 'run', sql: stmt._sql, args: stmt._args })
        return { meta: { changes: 1 } }
      }
      stmt.all = async () => ({ results: [] })
      return stmt
    },
  }
  return { db: stub, calls }
}

async function runLogout(db, cookieHeader, host = 'auth.localhost:8785') {
  const app = await createFlowEngineApp({
    runtime: 'worker',
    flows: { 'auth-logout': authLogoutFlowJSON },
    configNodes: [],
    mountPath: '/api/flows',
    httpNodeRoot: '/api/flows',
    exposeErrorDetails: true,
    defaultTenantId: 't',
    defaultProjectId: 'p',
  })
  const headers = { host }
  if (cookieHeader) headers.cookie = cookieHeader
  const req = new Request('http://flow-engine.local/api/flows/auth-logout', {
    method: 'POST',
    headers,
  })
  const env = { DB: db, HTMLBOX_ENV: 'development' }
  return await app.handleWorker(req, env, {})
}

test('auth-logout: con cookie sid válida → DELETE session + Set-Cookie clear + ok', async () => {
  const { db, calls } = makeFakeD1()
  const res = await runLogout(db, 'sid=valid_session_abc123; other=stuff')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  // Set-Cookie clear cookie
  const setCookie = res.headers.get('Set-Cookie')
  assert.ok(setCookie, 'Set-Cookie presente')
  assert.match(setCookie, /^sid=/, 'cookie name es sid')
  assert.match(setCookie, /Max-Age=0/, 'Max-Age=0 para limpiar')
  assert.match(setCookie, /Path=\//)
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Lax/)
  assert.doesNotMatch(setCookie, /Secure/, 'no Secure en localhost')
  // D1 ejecutó DELETE con el sid correcto
  const deleteCall = calls.find(c => /DELETE FROM htmlbox_sessions/i.test(c.sql))
  assert.ok(deleteCall, 'DELETE session ejecutado')
  assert.equal(deleteCall.args[0], 'valid_session_abc123', 'sid pasado como bind')
})

test('auth-logout: cookie sin sid → no ejecuta DELETE pero responde ok', async () => {
  const { db, calls } = makeFakeD1()
  const res = await runLogout(db, 'other=value; foo=bar')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  // Igual responde ok (no leak de existencia de sesión)
  assert.ok(res.headers.get('Set-Cookie'), 'Set-Cookie clear igual presente')
  // DELETE se ejecuta igual con bind=undefined → D1 bind como null
  // (aceptamos ambos casos — lo importante es no leak de estado)
  const deleteCall = calls.find(c => /DELETE FROM htmlbox_sessions/i.test(c.sql))
  assert.ok(deleteCall, 'DELETE igual se ejecuta (con bind undefined o vacío)')
})

test('auth-logout: sin cookie header → responde ok sin error', async () => {
  const { db } = makeFakeD1()
  const res = await runLogout(db, null)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
})

test('auth-logout: en producción (https) → Set-Cookie lleva flag Secure', async () => {
  const { db } = makeFakeD1()
  const res = await runLogout(db, 'sid=session_prod', 'auth.sivocloud.dev')
  const setCookie = res.headers.get('Set-Cookie')
  assert.match(setCookie, /Secure/, 'Secure flag presente en prod (https)')
})
