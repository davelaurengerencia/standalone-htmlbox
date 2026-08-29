// __tests__/authConsumeFlow.test.js — Paso 4: smoke test del flow auth-consume.
//
// Cubre el path central de login: el browser abre el magic link, /api/auth/verify
// muestra la página "Verificando…", que postea a /api/auth/consume con el token.
// auth-consume flow:
//   1. Valida token (peek + check)
//   2. Marca usado
//   3. Busca o auto-provisiona el user
//   4. Crea sesión
//   5. Crea ticket de 60s
//   6. Devuelve { ok, user, destUrl } con Set-Cookie: sid=...
//
// Acá mockeamos D1 y EMAIL (no usados por este flow, pero el flow-engine los
// requiere vía ctx.platformBindings). Igual que en authRequestFlow.test.js,
// los bindings se inyectan via env.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFlowEngineApp } from 'flow-engine/app'

import authConsumeFlowJSON from '../flows/auth-consume.flow.json' with { type: 'json' }

// ---- Mock D1 con respuestas por SQL pattern ----
//
// IMPORTANTE: los métodos usan arrow functions + closure sobre `calls` (NO
// `this.calls.push`) — el flow-engine llama stmt.first() sin preservar el
// `this` binding, así que cualquier referencia a `this` adentro del método
// falla con "Cannot read properties of undefined". Patrón confirmado en
// authRequestFlow.test.js y replicado acá.

function makeFakeD1(opts = {}) {
  const calls = []
  const stub = {
    prepare(sql) {
      const stmt = { _sql: sql }
      stmt.bind = (...args) => {
        stmt._args = args
        return stmt
      }
      stmt.first = async () => {
        calls.push({ type: 'first', sql: stmt._sql, args: stmt._args })
        if (/SELECT email FROM htmlbox_magic_links/i.test(stmt._sql)) {
          if (opts.tokenValid === false) return null
          return { email: opts.tokenEmail || 'test@example.com' }
        }
        if (/SELECT id, is_platform_owner FROM htmlbox_users WHERE email/i.test(stmt._sql)) {
          if (opts.userExists) {
            return { id: opts.userId || 'user_existing', is_platform_owner: opts.userIsPlatformOwner ? 1 : 0 }
          }
          return null
        }
        if (/count\(\*\) AS n FROM htmlbox_users/i.test(stmt._sql)) {
          return { n: opts.userCount ?? 0 }
        }
        return null
      }
      stmt.run = async () => {
        calls.push({ type: 'run', sql: stmt._sql, args: stmt._args })
        return { meta: { changes: 1, last_row_id: 1 } }
      }
      stmt.all = async () => {
        calls.push({ type: 'all', sql: stmt._sql, args: stmt._args })
        return { results: [] }
      }
      return stmt
    },
  }
  return { db: stub, calls }
}

function makeEnv(db) {
  return {
    DB: db,
    HTMLBOX_ENV: 'development',
  }
}

async function runConsumeFlow(db, body, host = 'auth.localhost') {
  const app = await createFlowEngineApp({
    runtime: 'worker',
    flows: { 'auth-consume': authConsumeFlowJSON },
    configNodes: [],
    mountPath: '/api/flows',
    httpNodeRoot: '/api/flows',
    exposeErrorDetails: true,
    defaultTenantId: 't',
    defaultProjectId: 'p',
  })
  const req = new Request('http://flow-engine.local/api/flows/auth-consume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', host },
    body: JSON.stringify(body),
  })
  const env = makeEnv(db)
  return await app.handleWorker(req, env, {})
}

// ---- Tests ----

test('auth-consume: token inválido → 400 invalid_or_expired_token', async () => {
  const { db, calls } = makeFakeD1({ tokenValid: false })
  const res = await runConsumeFlow(db, { token: 'invalid-token' })
  assert.equal(res.status, 200, 'flow siempre devuelve 200 — el handler decide qué payload')
  const body = await res.json()
  assert.equal(body.error, 'invalid_or_expired_token')
  // Solo se ejecuta peek_token, no consume ni find_user ni el resto.
  const sqls = calls.map(c => c.sql)
  assert.equal(sqls.filter(s => /htmlbox_magic_links/i.test(s)).length, 1,
    'solo 1 query a magic_links (peek), sin consume ni update')
})

test('auth-consume: body sin token → 400 missing_token', async () => {
  const { db } = makeFakeD1({})
  const res = await runConsumeFlow(db, {})
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.error, 'missing_token')
})

test('auth-consume: user existente no-platform-owner → sesión + cookie + destUrl=studio', async () => {
  const { db, calls } = makeFakeD1({
    tokenValid: true,
    tokenEmail: 'tenant@example.com',
    userExists: true,
    userId: 'user_existing_123',
    userIsPlatformOwner: false,
  })
  const res = await runConsumeFlow(db, { token: 'valid-token' }, 'auth.localhost')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.user.email, 'tenant@example.com')
  assert.match(body.destUrl, /^http:\/\/studio\.localhost\/auth\/exchange\?st=[a-f0-9]{64}$/,
    'destUrl usa subdominio studio (no platform_owner) + http (localhost) + ticket hex 64')
  // Set-Cookie presente con sid
  const setCookie = res.headers.get('Set-Cookie')
  assert.ok(setCookie, 'Set-Cookie header presente')
  assert.match(setCookie, /^sid=[a-f0-9]{64}/, 'cookie sid con token hex 64')
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Lax/)
  assert.match(setCookie, /Path=\//)
  // NO lleva Secure porque es localhost
  assert.doesNotMatch(setCookie, /Secure/, 'no Secure flag en localhost')
  // Verificar queries ejecutadas
  const sqls = calls.map(c => c.sql)
  assert.ok(sqls.some(s => /htmlbox_magic_links WHERE id = .+ AND used_at IS NULL/i.test(s)),
    'se ejecutó peek_token')
  assert.ok(sqls.some(s => /^UPDATE htmlbox_magic_links SET used_at/i.test(s)),
    'se ejecutó consume_token (UPDATE)')
  assert.ok(sqls.some(s => /SELECT id, is_platform_owner FROM htmlbox_users/i.test(s)),
    'se ejecutó find_user')
  assert.ok(sqls.some(s => /INSERT INTO htmlbox_sessions/i.test(s)),
    'se ejecutó create_session')
  assert.ok(sqls.some(s => /INSERT INTO htmlbox_login_tickets/i.test(s)),
    'se ejecutó insert_ticket')
  // NO se ejecutó count_users ni insert_user (user ya existía)
  assert.ok(!sqls.some(s => /count\(\*\) AS n FROM htmlbox_users/i.test(s)),
    'no se ejecutó count_users (path de user existente)')
  assert.ok(!sqls.some(s => /INSERT INTO htmlbox_users/i.test(s)),
    'no se ejecutó insert_user (path de user existente)')
})

test('auth-consume: user NO existe + count=0 → auto-provisiona como platform_owner + destUrl=controlplane', async () => {
  const { db, calls } = makeFakeD1({
    tokenValid: true,
    tokenEmail: 'first@example.com',
    userExists: false,
    userCount: 0, // primer user de la plataforma
  })
  const res = await runConsumeFlow(db, { token: 'valid-token' }, 'auth.sivocloud.dev')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.match(body.destUrl, /^https:\/\/controlplane\.sivocloud\.dev\/auth\/exchange\?st=/,
    'primer user → platform_owner → destUrl apunta a controlplane (con https en prod)')
  const sqls = calls.map(c => c.sql)
  // Sí se ejecutó count_users y insert_user
  assert.ok(sqls.some(s => /count\(\*\) AS n FROM htmlbox_users/i.test(s)),
    'se ejecutó count_users (path de user nuevo)')
  assert.ok(sqls.some(s => /INSERT INTO htmlbox_users/i.test(s)),
    'se ejecutó insert_user')
  // El bind de insert_user debe llevar is_platform_owner=1 (primer user)
  const insertCall = calls.find(c => /^INSERT INTO htmlbox_users/i.test(c.sql))
  assert.equal(insertCall.args[2], 1, 'is_platform_owner=1 en el bind (primer user)')
  // El Set-Cookie lleva Secure porque es prod (https)
  const setCookie = res.headers.get('Set-Cookie')
  assert.match(setCookie, /Secure/, 'Secure flag en prod (https)')
})

test('auth-consume: user NO existe + count>0 → auto-provisiona como tenant + destUrl=studio', async () => {
  const { db, calls } = makeFakeD1({
    tokenValid: true,
    tokenEmail: 'newuser@example.com',
    userExists: false,
    userCount: 5, // ya hay 5 users
  })
  const res = await runConsumeFlow(db, { token: 'valid-token' }, 'auth.localhost')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.match(body.destUrl, /^http:\/\/studio\.localhost\/auth\/exchange\?st=/,
    'segundo+ user → tenant → destUrl apunta a studio')
  const insertCall = calls.find(c => /^INSERT INTO htmlbox_users/i.test(c.sql))
  assert.equal(insertCall.args[2], 0, 'is_platform_owner=0 en el bind (no es el primero)')
})

test('auth-consume: session cookie tiene 30 días de Max-Age', async () => {
  const { db } = makeFakeD1({ tokenValid: true, userExists: true, userId: 'u1' })
  const res = await runConsumeFlow(db, { token: 'valid' })
  const setCookie = res.headers.get('Set-Cookie')
  assert.match(setCookie, /Max-Age=2592000/, 'Max-Age = 30 días en segundos')
})

test('auth-consume: el ticket insertado tiene expires_at ~60s en el futuro', async () => {
  const { db, calls } = makeFakeD1({ tokenValid: true, userExists: true })
  const before = Date.now()
  await runConsumeFlow(db, { token: 'valid' })
  const ticketInsert = calls.find(c => /INSERT INTO htmlbox_login_tickets/i.test(c.sql))
  assert.ok(ticketInsert, 'insert_ticket ejecutado')
  const expiresAt = ticketInsert.args[2] // formato 'YYYY-MM-DD HH:MM:SS'
  // Parseamos manualmente — el formato es determinístico.
  const parsed = Date.parse(expiresAt.replace(' ', 'T') + 'Z')
  const delta = parsed - before
  // ~60s, ±5s de tolerancia por tiempo de ejecución.
  assert.ok(delta > 55_000 && delta < 70_000, `ticket expires_at ~60s futuro (delta=${delta}ms)`)
})
test('auth-consume: HTMLBOX_CONTROLPLANE_ORIGIN/STUDIO_ORIGIN seteados → destUrl con puerto correcto', async () => {
  // Simula dev donde controlplane está en :8781 y studio en :8782.
  const { db, calls } = makeFakeD1({ tokenValid: true, userExists: true, userId: 'u_po', userIsPlatformOwner: true })
  const app = await createFlowEngineApp({
    runtime: 'worker',
    flows: { 'auth-consume': authConsumeFlowJSON },
    configNodes: [],
    mountPath: '/api/flows',
    httpNodeRoot: '/api/flows',
    exposeErrorDetails: true,
    defaultTenantId: 't', defaultProjectId: 'p',
  })
  const req = new Request('http://flow-engine.local/api/flows/auth-consume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', host: 'auth.localhost' },
    body: JSON.stringify({ token: 'valid-token' }),
  })
  const env = { DB: db, HTMLBOX_ENV: 'development', HTMLBOX_CONTROLPLANE_ORIGIN: 'http://controlplane.localhost:8781', HTMLBOX_STUDIO_ORIGIN: 'http://studio.localhost:8782' }
  const res = await app.handleWorker(req, env, {})
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.match(body.destUrl, /^http:\/\/controlplane\.localhost:8781\/auth\/exchange\?st=/, 'controlplane con puerto 8781')
})

test('auth-consume: HTMLBOX_STUDIO_ORIGIN seteado → tenant va a studio con puerto', async () => {
  const { db } = makeFakeD1({ tokenValid: true, userExists: true, userId: 'u_tenant', userIsPlatformOwner: false })
  const app = await createFlowEngineApp({
    runtime: 'worker',
    flows: { 'auth-consume': authConsumeFlowJSON },
    configNodes: [],
    mountPath: '/api/flows',
    httpNodeRoot: '/api/flows',
    exposeErrorDetails: true,
    defaultTenantId: 't', defaultProjectId: 'p',
  })
  const req = new Request('http://flow-engine.local/api/flows/auth-consume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', host: 'auth.localhost' },
    body: JSON.stringify({ token: 'valid-token' }),
  })
  const env = { DB: db, HTMLBOX_ENV: 'development', HTMLBOX_CONTROLPLANE_ORIGIN: 'http://controlplane.localhost:8781', HTMLBOX_STUDIO_ORIGIN: 'http://studio.localhost:8782' }
  const res = await app.handleWorker(req, env, {})
  const body = await res.json()
  assert.match(body.destUrl, /^http:\/\/studio\.localhost:8782\/auth\/exchange\?st=/, 'studio con puerto 8782')
})

test('auth-consume: sin overrides → destUrl sin puerto (caso prod)', async () => {
  const { db } = makeFakeD1({ tokenValid: true, userExists: true })
  const app = await createFlowEngineApp({
    runtime: 'worker',
    flows: { 'auth-consume': authConsumeFlowJSON },
    configNodes: [],
    mountPath: '/api/flows',
    httpNodeRoot: '/api/flows',
    exposeErrorDetails: true,
    defaultTenantId: 't', defaultProjectId: 'p',
  })
  const req = new Request('http://flow-engine.local/api/flows/auth-consume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', host: 'auth.sivocloud.dev' },
    body: JSON.stringify({ token: 'valid-token' }),
  })
  const env = { DB: db, HTMLBOX_ENV: 'production' }
  const res = await app.handleWorker(req, env, {})
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.match(body.destUrl, /^https:\/\/studio\.sivocloud\.dev\/auth\/exchange\?st=/, 'studio sin puerto (prod 443)')
})
