// __tests__/authRequestFlow.test.js — Paso 3: smoke test del flow auth-request.
//
// Ejecuta el flow contra el flow-engine real con bindings D1 y EMAIL
// mockeados en memoria. Valida:
//
//   1. Happy path: email válido + rate limit OK → magic link generado,
//      email "enviado" (capturado), _dev_preview presente, ok: true.
//   2. Email inválido → GENERIC_RESPONSE sin _dev_preview, ok: true,
//      email NO enviado.
//   3. Rate limit (3+ magic links recientes) → GENERIC_RESPONSE,
//      email NO enviado.
//
// Esto NO prueba contra D1 real ni contra EMAIL real — esos son el smoke
// e2e post-deploy del checklist §11.7. Acá validamos que la lógica del
// flow (nodos, wires, JSON shape, Fix 3 gate) funciona en aislación.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFlowEngineApp } from 'flow-engine/app'

// Cargar el flow como JSON (mismo import que worker.js)
import authRequestFlowJSON from '../flows/auth-request.flow.json' with { type: 'json' }

// ---- Mocks compartidos ----

// Fake D1: registra los SQLs ejecutados y devuelve respuestas según patrón.
function makeFakeD1(opts = {}) {
  const calls = []
  const stub = {
    prepare(sql) {
      const stmt = {
        bind(...args) {
          stmt._args = args
          stmt._sql = sql
          return stmt
        },
        async first() {
          calls.push({ type: 'first', sql: stmt._sql, args: stmt._args })
          // Rate limit count query
          if (/count\(\*\)/i.test(stmt._sql)) {
            return { n: opts.rateLimitCount ?? 0 }
          }
          return null
        },
        async run() {
          calls.push({ type: 'run', sql: stmt._sql, args: stmt._args })
          return { meta: { changes: 1, last_row_id: 1 } }
        },
        async all() {
          calls.push({ type: 'all', sql: stmt._sql, args: stmt._args })
          return { results: [] }
        },
      }
      return stmt
    },
  }
  return { db: stub, calls }
}

// Fake EMAIL: captura el .send() payload.
function makeFakeEMAIL(opts = {}) {
  const sent = []
  return {
    binding: {
      async send(payload) {
        sent.push(payload)
        if (opts.throwOnSend) throw new Error('mock EMAIL send failure')
        return { messageId: 'mock-msg-' + sent.length }
      },
    },
    sent,
  }
}

// El flow-engine runtime=worker extrae platformBindings DE env vía
// extractPlatformBindings(env). Por eso hay que poner DB y EMAIL en env
// para que los nodos cloudflare-* los lean vía ctx.platformBindings.
function makeEnv(db, emailBinding, envOverrides = {}) {
  return {
    DB: db,
    EMAIL: emailBinding,
    HTMLBOX_ENV: 'development',
    ...envOverrides,
  }
}

async function runFlow(db, emailBinding, envOverrides = {}, body = {}) {
  const app = await createFlowEngineApp({
    runtime: 'worker',
    flows: { 'auth-request': authRequestFlowJSON },
    configNodes: [],
    mountPath: '/api/flows',
    httpNodeRoot: '/api/flows',
    exposeErrorDetails: true,
    // En el Worker real, el monkey-patch de bootstrap.js inyecta
    // tenantId/projectId en cloudflare-email. Para tests directos al
    // flow-engine, pasamos los defaults al createFlowEngineApp — es
    // exactamente lo que hace el monkey-patch.
    defaultTenantId: 'single-tenant-dev',
    defaultProjectId: 'single-tenant-dev',
  })
  const req = new Request('http://flow-engine.local/api/flows/auth-request', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'host': 'auth.localhost:8785',
    },
    body: JSON.stringify(body),
  })
  const env = makeEnv(db, emailBinding, envOverrides)
  const res = await app.handleWorker(req, env, {})
  return res
}

// ---- Tests ----

test('auth-request flow: happy path con email válido', async () => {
  const { db, calls } = makeFakeD1({ rateLimitCount: 0 })
  const email = makeFakeEMAIL()
  const res = await runFlow(db, email.binding, {}, { email: 'test@example.com' })
  assert.equal(res.status, 200, 'happy path debe devolver 200')
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.ok(body.message, 'mensaje genérico presente')
  assert.ok(body._dev_preview, '_dev_preview presente en dev')
  assert.match(body._dev_preview, /^http:\/\/auth\.localhost:8785\/api\/auth\/verify\?token=[a-f0-9]{64}$/,
    'preview link usa el host del request (auth.localhost) y token hex 64 chars')
  // D1: 1 SELECT (rate limit) + 1 INSERT (magic link)
  assert.equal(calls.length, 2, 'D1 recibe 2 queries: rate limit + insert')
  assert.match(calls[0].sql, /count\(\*\)/i, 'primera query es rate limit')
  assert.match(calls[1].sql, /INSERT INTO htmlbox_magic_links/i, 'segunda query es insert')
  assert.equal(calls[1].args[0]?.length, 64, 'token id es 64 hex chars (32 bytes)')
  // EMAIL: se llamó una vez con el payload correcto
  assert.equal(email.sent.length, 1)
  const sentEmail = email.sent[0]
  assert.equal(sentEmail.subject, 'Tu link de ingreso a HTMLBox')
  assert.match(sentEmail.to[0], /test@example\.com/)
  assert.match(sentEmail.text, /http:\/\/auth\.localhost:8785\/api\/auth\/verify\?token=/)
  assert.match(sentEmail.html, /Ingresar a HTMLBox/)
})

test('auth-request flow: email inválido → GENERIC_RESPONSE, sin email enviado, sin insert', async () => {
  const { db, calls } = makeFakeD1({ rateLimitCount: 0 })
  const email = makeFakeEMAIL()
  const res = await runFlow(db, email.binding, {}, { email: 'not-an-email' })

  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body._dev_preview, undefined, 'sin preview si email es inválido')
  assert.equal(email.sent.length, 0, 'NO se envía email si la validación falla')
  // Igual ejecuta rate limit + check_rate + skip_switch (porque el flow
  // no puede branchear desde validate sin un switch intermedio — la rama
  // skip corta ahí). Verifica que D1 recibe rate limit + NADA más
  // (no insert porque skip_switch lo manda a apply_fix3 → out).
  assert.equal(calls.length, 1, 'D1 recibe SOLO rate limit (sin insert)')
  assert.match(calls[0].sql, /count\(\*\)/i, 'única query es rate limit')
})

test('auth-request flow: rate limit alcanzado → GENERIC_RESPONSE, sin email', async () => {
  const { db, calls } = makeFakeD1({ rateLimitCount: 3 })
  const email = makeFakeEMAIL()
  const res = await runFlow(db, email.binding, {}, { email: 'spammer@x.com' })

  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body._dev_preview, undefined)
  assert.equal(email.sent.length, 0, 'NO se envía email cuando rate limit corta')
  assert.equal(calls.length, 1, 'rate limit corta antes del INSERT')
})

test('auth-request flow: HTMLBOX_ENV=production → NO expone _dev_preview', async () => {
  const { db, calls } = makeFakeD1({ rateLimitCount: 0 })
  const email = makeFakeEMAIL()
  const req = new Request('http://flow-engine.local/api/flows/auth-request', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'host': 'auth.sivocloud.dev',
    },
    body: JSON.stringify({ email: 'prod-user@sivocloud.dev' }),
  })
  const env = makeEnv(db, email.binding, { HTMLBOX_ENV: 'production' })
  const app = await createFlowEngineApp({
    runtime: 'worker',
    flows: { 'auth-request': authRequestFlowJSON },
    configNodes: [],
    mountPath: '/api/flows',
    httpNodeRoot: '/api/flows',
    exposeErrorDetails: true,
    defaultTenantId: 'single-tenant-dev',
    defaultProjectId: 'single-tenant-dev',
  })
  const res = await app.handleWorker(req, env, {})

  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body._dev_preview, undefined,
    'PROD NUNCA expone _dev_preview (Fix 3 — seguridad)')
  assert.match(body.message, /registrado/)
  assert.equal(email.sent.length, 1, 'en prod el email se envía real')
  assert.match(email.sent[0].to[0], /prod-user/)
})

test('auth-request flow: host prod (.sivocloud.dev) genera https magic link', async () => {
  const { db } = makeFakeD1({ rateLimitCount: 0 })
  const email = makeFakeEMAIL()
  const req = new Request('http://flow-engine.local/api/flows/auth-request', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'host': 'auth.sivocloud.dev',
    },
    body: JSON.stringify({ email: 'user@sivocloud.dev' }),
  })
  const env = makeEnv(db, email.binding, { HTMLBOX_ENV: 'development' })
  const app = await createFlowEngineApp({
    runtime: 'worker',
    flows: { 'auth-request': authRequestFlowJSON },
    configNodes: [],
    mountPath: '/api/flows',
    httpNodeRoot: '/api/flows',
    exposeErrorDetails: true,
    defaultTenantId: 'single-tenant-dev',
    defaultProjectId: 'single-tenant-dev',
  })
  const res = await app.handleWorker(req, env, {})

  const body = await res.json()
  assert.ok(body._dev_preview, 'dev expone preview')
  assert.match(body._dev_preview, /^https:\/\/auth\.sivocloud\.dev\/api\/auth\/verify\?token=/,
    'host prod → https, no http')
})
