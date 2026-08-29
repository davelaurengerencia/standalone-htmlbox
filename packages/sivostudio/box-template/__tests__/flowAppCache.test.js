// box-template/__tests__/flowAppCache.test.js — tests del cache flow-engine.
//
// Cubre el fix de docs/htmlbox-spec-sivostudio-fix-flow-app-cache.md:
//   A. 2 requests seguidas al mismo boxId con mismo etag → solo1 createFlowEngineApp.
//   B. 2 requests mismo boxId, etag diferente (flow actualizado) → reconstruye.
//   C. 2 requests con boxId DISTINTO → ambos disparan createFlowEngineApp.
//   D. 2da request mismo boxId mismo etag → solo 1 R2.get() (la 2da solo R2.head()).
//
// Mocks: createFlowEngineApp + R2 (head + get) — inyectados vía deps.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFlowAppGetter } from '../lib/flowAppCache.js'

const VALID_BOX = 'abcdef0123456789'
const OTHER_BOX = '1111111111111111'
const STORED_FLOW = { 'mi-flow': [{ id: '1', type: 'http-in' }] }

// Mock de R2 — cuenta head() y get() por separado.
function mockR2({ etag = '"abc123"', flowJson = null, throwsOnGet = null } = {}) {
  const calls = { head: 0, get: 0 }
  return {
    calls,
    async head(key) {
      calls.head += 1
      if (flowJson === null) return null
      return { etag }
    },
    async get(key) {
      calls.get += 1
      if (throwsOnGet) throw throwsOnGet
      if (flowJson === null) return null
      return { text: async () => JSON.stringify(flowJson) }
    },
    async put() {},
  }
}

// Mock de loadStoredFlows — devuelve el flow configurado en el R2 mock.
function mockLoadFrom(r2) {
  return async (env, boxId) => {
    if (!env.STUDIO_R2) return {}
    const obj = await env.STUDIO_R2.get(`box-${boxId}/flow.json`)
    if (!obj) return {}
    try {
      return JSON.parse(await obj.text())
    } catch {
      return {}
    }
  }
}

// Helper: crea un createFlowEngineApp mock que cuenta invocaciones.
function mockCreate() {
  let count = 0
  let lastOpts = null
  const fn = async (opts) => {
    count += 1
    lastOpts = opts
    return { mockApp: true, opts }
  }
  fn.reset = () => { count = 0; lastOpts = null }
  fn.calls = () => count
  fn.lastOpts = () => lastOpts
  return fn
}

// === Test A: cache hit entre requests del mismo boxId ===

test('A: 2 requests mismo boxId mismo etag → solo 1 createFlowEngineApp', async () => {
  const r2 = mockR2({ etag: '"abc123"', flowJson: STORED_FLOW })
  const create = mockCreate()
  const getFlowApp = createFlowAppGetter({
    createFlowEngineApp: create,
    loadStoredFlows: mockLoadFrom(r2),
    cache: new Map(),
  })
  const app1 = await getFlowApp({ STUDIO_R2: r2 }, VALID_BOX)
  const app2 = await getFlowApp({ STUDIO_R2: r2 }, VALID_BOX)
  assert.equal(create.calls(), 1, 'solo 1 invocación de createFlowEngineApp')
  assert.deepEqual(app1, app2, 'misma instancia devuelta')
  assert.equal(r2.calls.head, 2, '2 HEAD requests (1 por request)')
  assert.equal(r2.calls.get, 1, 'solo 1 GET — la 2da hit cache')
})

// === Test B: cache invalidate cuando el etag cambia ===

test('B: 2 requests mismo boxId, etag cambia → 2 createFlowEngineApp', async () => {
  const create = mockCreate()
  // Primer round: etag v1
  const r2v1 = mockR2({ etag: '"v1"', flowJson: { f: [{ id: '1' }] } })
  const getFlowAppV1 = createFlowAppGetter({
    createFlowEngineApp: create,
    loadStoredFlows: mockLoadFrom(r2v1),
    cache: new Map(),
  })
  await getFlowAppV1({ STUDIO_R2: r2v1 }, VALID_BOX)
  assert.equal(create.calls(), 1)
  assert.equal(r2v1.calls.get, 1)

  // Segundo round: etag v2 (flow actualizado en R2)
  const r2v2 = mockR2({ etag: '"v2"', flowJson: { f: [{ id: '1' }, { id: '2' }] } })
  const getFlowAppV2 = createFlowAppGetter({
    createFlowEngineApp: create,
    loadStoredFlows: mockLoadFrom(r2v2),
    cache: new Map(), // cache limpio — simula isolate restart
  })
  await getFlowAppV2({ STUDIO_R2: r2v2 }, VALID_BOX)
  assert.equal(create.calls(), 2, 'segunda invocación porque el etag cambió')
  assert.equal(r2v2.calls.get, 1)
})

test('B-bonus: cache vivo detecta cambio de etag (mismo isolate, mismo cache)', async () => {
  const r2 = mockR2({ etag: '"v1"', flowJson: { v: 1 } })
  const create = mockCreate()
  const getFlowApp = createFlowAppGetter({
    createFlowEngineApp: create,
    loadStoredFlows: mockLoadFrom(r2),
    cache: new Map(),
  })
  await getFlowApp({ STUDIO_R2: r2 }, VALID_BOX)
  assert.equal(create.calls(), 1)

  // Simulamos que R2 ahora tiene v2 (sin reiniciar el cache — mismo isolate)
  r2.headResult = { etag: '"v2"' }
  r2.getResult = { text: async () => JSON.stringify({ v: 2 }) }

  // Override del mock head/get para la segunda request
  const origHead = r2.head
  const origGet = r2.get
  r2.head = async () => { r2.calls.head += 1; return { etag: '"v2"' } }
  r2.get = async () => { r2.calls.get += 1; return { text: async () => JSON.stringify({ v: 2 }) } }

  await getFlowApp({ STUDIO_R2: r2 }, VALID_BOX)
  assert.equal(create.calls(), 2, 'segunda invocación porque el etag cambió (sin restart del cache)')

  // Restaurar para no afectar otros tests
  r2.head = origHead
  r2.get = origGet
})

// === Test C: boxIds distintos en el mismo isolate ===

test('C: 2 requests boxIds distintos → ambos crean su propia app (no cross-contamination)', async () => {
  const r2a = mockR2({ etag: '"ea"', flowJson: { a: 1 } })
  const r2b = mockR2({ etag: '"eb"', flowJson: { b: 2 } })
  const create = mockCreate()
  // Un mismo getFlowApp con cache compartido entre boxIds.
  const sharedCache = new Map()
  const getFlowApp = createFlowAppGetter({
    createFlowEngineApp: create,
    loadStoredFlows: (env, boxId) => {
      // Carga desde el R2 mock correcto según boxId.
      return env.STUDIO_R2 === r2a ? mockLoadFrom(r2a)(env, boxId) : mockLoadFrom(r2b)(env, boxId)
    },
    cache: sharedCache,
  })
  const appA = await getFlowApp({ STUDIO_R2: r2a }, VALID_BOX)
  const appB = await getFlowApp({ STUDIO_R2: r2b }, OTHER_BOX)
  assert.equal(create.calls(), 2, 'cada boxId tiene su propia app')
  assert.notDeepEqual(appA, appB)
  // Verificamos que la segunda llamada usó el flow del OTHER_BOX.
  assert.deepEqual(create.lastOpts().flows, { b: 2 })
  // El cache tiene 2 entradas.
  assert.equal(sharedCache.size, 2)
})

// === Test D: 2da request solo hace HEAD, no GET ===

test('D: 3 requests mismo boxId mismo etag → 3 HEAD, 1 GET', async () => {
  const r2 = mockR2({ etag: '"abc123"', flowJson: STORED_FLOW })
  const create = mockCreate()
  const getFlowApp = createFlowAppGetter({
    createFlowEngineApp: create,
    loadStoredFlows: mockLoadFrom(r2),
    cache: new Map(),
  })
  await getFlowApp({ STUDIO_R2: r2 }, VALID_BOX)
  await getFlowApp({ STUDIO_R2: r2 }, VALID_BOX)
  await getFlowApp({ STUDIO_R2: r2 }, VALID_BOX)
  assert.equal(r2.calls.head, 3, '3 HEAD requests (1 por cada request)')
  assert.equal(r2.calls.get, 1, 'solo 1 GET — el cache ahorró 2 GETs')
})

// === Edge cases ===

test('edge: sin R2 binding → no cache hit, crea app cada vez (degradación)', async () => {
  const create = mockCreate()
  const getFlowApp = createFlowAppGetter({
    createFlowEngineApp: create,
    cache: new Map(),
  })
  const app1 = await getFlowApp({}, VALID_BOX)
  const app2 = await getFlowApp({}, VALID_BOX)
  assert.equal(create.calls(), 2, 'sin R2 no hay etag → siempre reconstruye')
  assert.deepEqual(app1, app2, 'mismo contenido pero instancias distintas')
})

test('edge: flow no existe en R2 (HEAD null) → cache miss cada vez', async () => {
  const r2 = mockR2({ flowJson: null })
  const create = mockCreate()
  const getFlowApp = createFlowAppGetter({
    createFlowEngineApp: create,
    loadStoredFlows: mockLoadFrom(r2),
    cache: new Map(),
  })
  await getFlowApp({ STUDIO_R2: r2 }, VALID_BOX)
  await getFlowApp({ STUDIO_R2: r2 }, VALID_BOX)
  assert.equal(create.calls(), 2, 'HEAD null → etag null → cache miss')
})

test('edge: configNodes y mountPath se pasan correctamente', async () => {
  const r2 = mockR2({ etag: '"e"', flowJson: {} })
  const create = mockCreate()
  const getFlowApp = createFlowAppGetter({
    createFlowEngineApp: create,
    loadStoredFlows: mockLoadFrom(r2),
    cache: new Map(),
  })
  await getFlowApp({ STUDIO_R2: r2 }, VALID_BOX)
  const opts = create.lastOpts()
  assert.deepEqual(opts.configNodes, [], 'configNodes REQUERIDO por flow-engine runtime=worker')
  assert.equal(opts.mountPath, '/editor/backend')
  assert.equal(opts.httpNodeRoot, '/api')
  assert.equal(opts.runtime, 'worker')
  assert.ok(opts.platformBindings, 'platformBindings presente')
  assert.deepEqual(opts.flows, {}, 'flows vacío (no había flow en R2)')
})

test('edge: HEAD throw → fallback a get (no rompe)', async () => {
  const r2 = {
    calls: { head: 0, get: 0 },
    async head() {
      r2.calls.head += 1
      throw new Error('R2 HEAD 500')
    },
    async get(key) {
      r2.calls.get += 1
      return { text: async () => JSON.stringify(STORED_FLOW) }
    },
  }
  const create = mockCreate()
  const getFlowApp = createFlowAppGetter({
    createFlowEngineApp: create,
    loadStoredFlows: mockLoadFrom(r2),
    cache: new Map(),
  })
  // HEAD throw → catch + etag null → cache miss → recrea.
  await getFlowApp({ STUDIO_R2: r2 }, VALID_BOX)
  assert.equal(create.calls(), 1)
  assert.equal(r2.calls.head, 1)
  assert.equal(r2.calls.get, 1)
})