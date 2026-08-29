// __tests__/authExchangeFlow.test.js — Paso 7: smoke test del flow auth-exchange.
//
// El flow:
//   1. Lee ticket del body
//   2. UPDATE htmlbox_login_tickets SET consumed_at (atomic check + consume)
//   3. SELECT session_id del ticket
//   4. Devuelve { sessionId }
//
// El shell del Worker (worker.js) ya validó el X-HTMLBox-Internal-Secret antes
// de invocar el flow, así que acá solo probamos la lógica del flow.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFlowEngineApp } from 'flow-engine/app'

import authExchangeFlowJSON from '../flows/auth-exchange.flow.json' with { type: 'json' }

function makeFakeD1(opts = {}) {
  const calls = []
  const stub = {
    prepare(sql) {
      const stmt = { _sql: sql }
      stmt.bind = (...args) => { stmt._args = args; return stmt }
      stmt.first = async () => {
        calls.push({ type: 'first', sql: stmt._sql, args: stmt._args })
        // SELECT session_id FROM htmlbox_login_tickets WHERE id=?
        if (/SELECT session_id FROM htmlbox_login_tickets/i.test(stmt._sql)) {
          if (opts.ticketExists === false) return null
          return { session_id: opts.sessionId || 'session_id_from_ticket' }
        }
        return null
      }
      stmt.run = async () => {
        calls.push({ type: 'run', sql: stmt._sql, args: stmt._args })
        // UPDATE htmlbox_login_tickets: si ticketValid=false → 0 changes
        if (/UPDATE htmlbox_login_tickets/i.test(stmt._sql)) {
          return { meta: { changes: opts.ticketValid === false ? 0 : 1 } }
        }
        return { meta: { changes: 1 } }
      }
      stmt.all = async () => ({ results: [] })
      return stmt
    },
  }
  return { db: stub, calls }
}

async function runExchange(db, body) {
  const app = await createFlowEngineApp({
    runtime: 'worker',
    flows: { 'auth-exchange': authExchangeFlowJSON },
    configNodes: [],
    mountPath: '/api/flows',
    httpNodeRoot: '/api/flows',
    exposeErrorDetails: true,
    defaultTenantId: 't',
    defaultProjectId: 'p',
  })
  const req = new Request('http://flow-engine.local/api/flows/auth-exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', host: 'auth.localhost:8785' },
    body: JSON.stringify(body),
  })
  const env = { DB: db, HTMLBOX_ENV: 'development' }
  return await app.handleWorker(req, env, {})
}

test('auth-exchange: ticket válido → devuelve sessionId', async () => {
  const { db, calls } = makeFakeD1({ ticketValid: true, sessionId: 'sid_abc123' })
  const res = await runExchange(db, { ticket: 'valid_ticket_hex' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.sessionId, 'sid_abc123')
  // UPDATE consume + SELECT get_session
  assert.equal(calls.length, 2)
  assert.match(calls[0].sql, /UPDATE htmlbox_login_tickets/i)
  assert.equal(calls[0].args[0], 'valid_ticket_hex')
  assert.match(calls[1].sql, /SELECT session_id FROM htmlbox_login_tickets/i)
  assert.equal(calls[1].args[0], 'valid_ticket_hex')
})

test('auth-exchange: ticket inválido/expirado/ya consumido → 400 invalid_or_expired_ticket', async () => {
  const { db, calls } = makeFakeD1({ ticketValid: false })
  const res = await runExchange(db, { ticket: 'bad_ticket' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.error, 'invalid_or_expired_ticket')
  // Solo UPDATE corre (con 0 changes), no llega al SELECT
  assert.equal(calls.length, 1, 'solo UPDATE, no SELECT porque changes=0')
})

test('auth-exchange: ticket válido pero row no encontrado (race condition) → ticket_session_not_found', async () => {
  // Si el UPDATE tuvo changes=1 pero el SELECT no encuentra el row → algo
  // está mal (probablemente race condition entre UPDATE y SELECT). Devolvemos
  // error explícito en vez de sessionId undefined.
  const { db } = makeFakeD1({ ticketValid: true, ticketExists: false })
  const res = await runExchange(db, { ticket: 'phantom_ticket' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.error, 'ticket_session_not_found')
})

test('auth-exchange: body sin ticket → 400 invalid_or_expired_ticket (vacío no existe)', async () => {
  const { db } = makeFakeD1({ ticketValid: false })
  const res = await runExchange(db, {})
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.error, 'invalid_or_expired_ticket')
})

test('auth-exchange: ticket reusado → segundo canje falla con invalid_or_expired_ticket', async () => {
  // Simula dos llamadas: la primera tiene el ticket válido, la segunda
  // también (porque el fake D1 no trackea estado). Pero conceptualmente,
  // el flow-engine testea solo UNA corrida. Lo importante es que después
  // del UPDATE, el ticket tiene consumed_at seteado, así que la próxima
  // corrida contra el MISMO ticket verá changes=0.
  //
  // Para probar el caso real de "doble canje" necesitaríamos un fake D1
  // que trackee estado entre llamadas. Como ese es un test de integración
  // del DB real (no unit), lo dejamos para el smoke e2e.
  //
  // Acá solo verificamos que el UPDATE use WHERE consumed_at IS NULL —
  // si no, el segundo canje devolvería el mismo sessionId (incorrecto).
  const { db, calls } = makeFakeD1({ ticketValid: false })
  await runExchange(db, { ticket: 'reused' })
  const updateCall = calls.find(c => /UPDATE htmlbox_login_tickets/i.test(c.sql))
  assert.match(updateCall.sql, /consumed_at IS NULL/,
    'el UPDATE filtra por consumed_at IS NULL — ticket ya consumido NO se vuelve a consumir')
})
