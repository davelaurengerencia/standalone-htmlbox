// __tests__/dataApi.test.js — endpoint router de /api/data/{boxId}/tables/...

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleDataApi } from '../src/lib/dataApi.js'

const BOX_ID = 'lf6l61etomwk9fdl'

function makeEnv() {
  return { HTMLBOX_CONTROL_PLANE_ORIGIN: 'https://controlplane.sivocloud.dev' }
}

function mockControlPlane({ whoami = null, membership = null, boxDb = null } = {}) {
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.endsWith('/api/internal/whoami')) {
      if (!whoami) return new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
      return new Response(JSON.stringify(whoami), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (u.match(/\/api\/internal\/boxes\/[a-z0-9]+\/membership$/)) {
      if (!membership) return new Response(JSON.stringify({ membership: null }), { status: 403, headers: { 'Content-Type': 'application/json' } })
      // membership shape: { role: 'editor' } — endpoint lo envuelve en { membership: ... }
      return new Response(JSON.stringify({ membership }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (u.match(/\/api\/internal\/boxes\/[a-z0-9]+\/db$/)) {
      if (!boxDb) return new Response(JSON.stringify({ box: null }), { status: 404, headers: { 'Content-Type': 'application/json' } })
      return new Response(JSON.stringify({ box: boxDb }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('not found in mock', { status: 404 })
  }
}

test('router rechaza URL no reconocida', async () => {
  const url = new URL('https://sivocloud.dev/api/other/x')
  const r = await handleDataApi({ method: 'GET', url: 'https://sivocloud.dev/api/other/x' }, makeEnv(), url)
  assert.equal(r, null)
})

test('router devuelve null si boxId malformado (worker responde 404)', async () => {
  const url = new URL(`https://sivocloud.dev/api/data/BAD/tables`)
  const r = await handleDataApi({ method: 'GET', url: 'https://sivocloud.dev/api/data/BAD/tables' }, makeEnv(), url)
  assert.equal(r, null) // worker.js convierte null → 404
})

test('listTables sin sesión → 401', async () => {
  mockControlPlane()
  const url = new URL(`https://sivocloud.dev/api/data/${BOX_ID}/tables`)
  const req = { method: 'GET', url: 'https://sivocloud.dev/api/data/' + BOX_ID + '/tables', headers: { get: () => null } }
  const r = await handleDataApi(req, makeEnv(), url)
  assert.equal(r.status, 401)
})

test('listTables con sesión pero sin membresía → 403', async () => {
  mockControlPlane({
    whoami: { userId: 'u1', tenantId: 't1', isPlatformOwner: false },
    membership: null,
    boxDb: null,
  })
  const url = new URL(`https://sivocloud.dev/api/data/${BOX_ID}/tables`)
  const req = { method: 'GET', url: 'https://sivocloud.dev/api/data/' + BOX_ID + '/tables', headers: { get: () => 'sid=abc' } }
  const r = await handleDataApi(req, makeEnv(), url)
  assert.equal(r.status, 403)
})

test('listTables con sesión + membresía pero box sin DB → 404', async () => {
  mockControlPlane({
    whoami: { userId: 'u1', tenantId: 't1', isPlatformOwner: false },
    membership: { role: 'editor' },
    boxDb: null,
  })
  const url = new URL(`https://sivocloud.dev/api/data/${BOX_ID}/tables`)
  const req = { method: 'GET', url: 'https://sivocloud.dev/api/data/' + BOX_ID + '/tables', headers: { get: () => 'sid=abc' } }
  const r = await handleDataApi(req, makeEnv(), url)
  assert.equal(r.status, 404)
})

test('parser de routes', async () => {
  const regex = /^\/api\/data\/([a-z0-9]{16})\/tables(?:\/([a-z][a-z0-9_]{0,40}))?(?:\/(rows|columns|upsert|upload))?$/
  assert.match('/api/data/' + BOX_ID + '/tables', regex)
  assert.match('/api/data/' + BOX_ID + '/tables/ventas/rows', regex)
  assert.match('/api/data/' + BOX_ID + '/tables/ventas/columns', regex)
  assert.match('/api/data/' + BOX_ID + '/tables/ventas/upsert', regex)
  assert.match('/api/data/' + BOX_ID + '/tables/ventas/upload', regex)
  assert.doesNotMatch('/api/data/' + BOX_ID + '/tables/Ventas/rows', regex)
})