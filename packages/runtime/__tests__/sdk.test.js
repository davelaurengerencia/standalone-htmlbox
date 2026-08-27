// __tests__/sdk.test.js — valida el SDK cliente.
//
// Mockeamos fetch global. El SDK se ejecuta cuando se importa (IIFE), así que
// importamos en un sandbox donde location/document están definidos.

import { test } from 'node:test'
import assert from 'node:assert/strict'

// Crear un sandbox DOM-like para cargar el SDK.
import vm from 'node:vm'
import fs from 'node:fs'
import path from 'node:path'

const SDK_PATH = new URL('../src/sdk/htmlbox-sdk.txt', import.meta.url)
const SDK_SOURCE = fs.readFileSync(SDK_PATH, 'utf8')

function loadSdk({ boxId = '', v = 'public', origin = 'https://htmlbox.dev' } = {}) {
  const sandbox = {
    location: { origin, search: `?boxId=${boxId}&v=${v}` },
    URLSearchParams,
    console,
    fetch: globalThis.fetch,
    setInterval: () => 0,
    clearInterval: () => {},
  }
  sandbox.window = sandbox
  sandbox.self = sandbox
  vm.createContext(sandbox)
  vm.runInContext(SDK_SOURCE, sandbox)
  return sandbox.window.HTMLBox
}

const fakeFetch = (url, init) => {
  return Promise.resolve(new Response(JSON.stringify({ ok: true, url, init: { method: init.method } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }))
}

// Reemplazamos fetch para todas las pruebas
test('SDK expone metadata', () => {
  globalThis.fetch = fakeFetch
  const sdk = loadSdk({ boxId: 'lf6l61etomwk9fdl', v: 'public', origin: 'https://htmlbox.dev' })
  assert.equal(sdk.boxId, 'lf6l61etomwk9fdl')
  assert.equal(sdk.visibility, 'public')
  assert.equal(sdk.runtimeOrigin, 'https://htmlbox.dev')
  assert.match(sdk.sdkVersion, /^0\./)
  assert.equal(typeof sdk.table, 'function')
  assert.equal(typeof sdk.flow, 'function')
})

test('table().rows() hace fetch a /api/data/{boxId}/tables/{slug}/rows', async () => {
  let lastUrl = null
  globalThis.fetch = async (url, init) => {
    lastUrl = url
    return new Response(JSON.stringify({ rows: [{ id: 1, name: 'A' }], count: 1 }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }
  const sdk = loadSdk({ boxId: 'lf6l61etomwk9fdl', origin: 'https://htmlbox.dev' })
  const r = await sdk.table('ventas').rows({ limit: 50 })
  assert.equal(lastUrl, 'https://htmlbox.dev/api/data/lf6l61etomwk9fdl/tables/ventas/rows?limit=50')
  assert.deepEqual(r.rows, [{ id: 1, name: 'A' }])
})

test('table().rows() con where lo serializa como JSON', async () => {
  let lastUrl = null
  globalThis.fetch = async (url) => {
    lastUrl = url
    return new Response(JSON.stringify({ rows: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  const sdk = loadSdk({ boxId: 'b1', origin: 'https://htmlbox.dev' })
  await sdk.table('ventas').rows({ where: { region: 'LATAM' } })
  assert.ok(lastUrl.endsWith('where=%7B%22region%22%3A%22LATAM%22%7D'))
})

test('table().upsert() POST con body JSON', async () => {
  let capturedInit = null
  globalThis.fetch = async (url, init) => {
    capturedInit = init
    return new Response(JSON.stringify({ ok: true, inserted: 2 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  const sdk = loadSdk({ boxId: 'b1', origin: 'https://htmlbox.dev' })
  const r = await sdk.table('x').upsert([{ a: 1 }, { a: 2 }])
  assert.equal(r.inserted, 2)
  assert.equal(capturedInit.method, 'POST')
  assert.match(capturedInit.headers['Content-Type'], /application\/json/)
  assert.deepEqual(JSON.parse(capturedInit.body), { rows: [{ a: 1 }, { a: 2 }] })
})

test('table().upsert() rechaza si rows no es array', async () => {
  globalThis.fetch = fakeFetch
  const sdk = loadSdk({ boxId: 'b1', origin: 'https://htmlbox.dev' })
  await assert.rejects(() => sdk.table('x').upsert({ a: 1 }), /rows debe ser array/)
})

test('table() rechaza slug vacío', () => {
  globalThis.fetch = fakeFetch
  const sdk = loadSdk({ boxId: 'b1', origin: 'https://htmlbox.dev' })
  assert.throws(() => sdk.table(''), /slug requerido/)
})

test('table().columns() hace fetch a /columns', async () => {
  let lastUrl = null
  globalThis.fetch = async (url) => {
    lastUrl = url
    return new Response(JSON.stringify({ slug: 'v', name: 'Ventas', columns: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  const sdk = loadSdk({ boxId: 'b1', origin: 'https://htmlbox.dev' })
  const c = await sdk.table('v').columns()
  assert.equal(c.slug, 'v')
  assert.equal(lastUrl, 'https://htmlbox.dev/api/data/b1/tables/v/columns')
})

test('fetch failure lanza error con status y body', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
  const sdk = loadSdk({ boxId: 'b1', origin: 'https://htmlbox.dev' })
  try {
    await sdk.table('v').rows()
    assert.fail('debe lanzar')
  } catch (err) {
    assert.equal(err.status, 401)
    assert.equal(err.body.error, 'unauthenticated')
  }
})