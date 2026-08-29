// box-template/lib/handlers.test.js — tests unitarios de los handlers del box worker.
//
// Mocks: env.STUDIO_R2 (R2) y request objects. Sin red real, sin wrangler.
//
// Cubre:
//   - dispatchZone: routing de paths (con y sin prefijo /box/:boxId)
//   - getBoxId: validación del header
//   - handleApp: lee R2, fallback a placeholder, 503 sin binding
//   - handleEditorApi: POST frontend/flow/variables/deploy
//   - loadStoredFlows: parseo defensivo

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dispatchZone,
  getBoxId,
  handleApp,
  handleEditorApi,
  handleEditorFrontend,
  loadStoredFlows,
  BOX_ID_HEADER,
} from './handlers.js'

const VALID_BOX = 'abcdef0123456789'

function mockR2({ keys = {}, errors = {} } = {}) {
  const r2 = {
    // Acceso directo a keys para asserts: r2.store[`box-abc/...`].
    store: keys,
    async get(key) {
      if (errors[key]) throw errors[key]
      if (!(key in keys)) return null
      const value = keys[key]
      if (typeof value === 'string') return { text: async () => value }
      return value
    },
    async put(key, value, _opts) {
      keys[key] = value
    },
  }
  return r2
}

// === dispatchZone ===

test('dispatchZone: /box/:boxId/* → zone app, subpath /', () => {
  const r = dispatchZone('/box/abcdef0123456789/')
  assert.equal(r.zone, 'app')
  assert.equal(r.subpath, '/')
})

test('dispatchZone: /box/:boxId/editor/frontend', () => {
  const r = dispatchZone('/box/abcdef0123456789/editor/frontend')
  assert.equal(r.zone, 'editor-frontend')
  assert.equal(r.subpath, '/editor/frontend')
})

test('dispatchZone: /box/:boxId/editor/api/flow', () => {
  const r = dispatchZone('/box/abcdef0123456789/editor/api/flow')
  assert.equal(r.zone, 'editor-api')
  assert.equal(r.subpath, '/editor/api/flow')
})

test('dispatchZone: /box/:boxId/api/echo', () => {
  const r = dispatchZone('/box/abcdef0123456789/api/echo')
  assert.equal(r.zone, 'api')
  assert.equal(r.subpath, '/api/echo')
})

test('dispatchZone: /box/:boxId/some/unknown → app (catch-all)', () => {
  const r = dispatchZone('/box/abcdef0123456789/some/unknown')
  assert.equal(r.zone, 'app')
  assert.equal(r.subpath, '/some/unknown')
})

test('dispatchZone: sin prefijo /box/ — funciona igual (caso raro, defensivo)', () => {
  const r = dispatchZone('/editor/frontend')
  assert.equal(r.zone, 'editor-frontend')
})

// === getBoxId ===

test('getBoxId: válido → devuelve boxId', () => {
  const req = new Request('https://x/', { headers: { [BOX_ID_HEADER]: VALID_BOX } })
  assert.equal(getBoxId(req), VALID_BOX)
})

test('getBoxId: header ausente → null', () => {
  assert.equal(getBoxId(new Request('https://x/')), null)
})

test('getBoxId: boxId corto → null', () => {
  const req = new Request('https://x/', { headers: { [BOX_ID_HEADER]: 'corto' } })
  assert.equal(getBoxId(req), null)
})

test('getBoxId: boxId con mayúsculas → null (patrón lowercase only)', () => {
  const req = new Request('https://x/', { headers: { [BOX_ID_HEADER]: 'ABCdef0123456789' } })
  assert.equal(getBoxId(req), null)
})

// === handleApp ===

test('handleApp: sin R2 → placeholder', async () => {
  const res = await handleApp({}, VALID_BOX)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('Content-Type'), /text\/html/)
  const html = await res.text()
  assert.match(html, /Box vacío/)
  assert.doesNotMatch(res.headers.get('Cache-Control') || '', /no-cache/)
})

test('handleApp: con R2 sin el key → placeholder', async () => {
  const env = { STUDIO_R2: mockR2({ keys: {} }) }
  const res = await handleApp(env, VALID_BOX)
  assert.equal(res.status, 200)
  assert.match(await res.text(), /Box vacío/)
})

test('handleApp: con R2 + HTML guardado → lo sirve con Cache-Control: no-cache', async () => {
  const html = '<h1>Hola mundo</h1>'
  const env = { STUDIO_R2: mockR2({ keys: { [`box-${VALID_BOX}/frontend.html`]: html } }) }
  const res = await handleApp(env, VALID_BOX)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('Content-Type'), /text\/html/)
  assert.equal(res.headers.get('Cache-Control'), 'no-cache')
  assert.equal(await res.text(), html)
})

// === handleEditorApi ===

test('handleEditorApi: sin R2 → 503 no_storage', async () => {
  const req = new Request('https://x/editor/api/frontend', { method: 'POST', body: '<h1>x</h1>' })
  const res = await handleEditorApi(req, {}, VALID_BOX, '/editor/api/frontend')
  assert.equal(res.status, 503)
  const body = await res.json()
  assert.equal(body.error, 'no_storage')
})

test('handleEditorApi: POST /editor/api/frontend guarda HTML en R2', async () => {
  const r2 = mockR2()
  const req = new Request('https://x/editor/api/frontend', {
    method: 'POST',
    body: '<h1>Mi app</h1>',
  })
  const res = await handleEditorApi(req, { STUDIO_R2: r2 }, VALID_BOX, '/editor/api/frontend')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.size, '<h1>Mi app</h1>'.length)
  assert.equal(r2.store[`box-${VALID_BOX}/frontend.html`], '<h1>Mi app</h1>')
})

test('handleEditorApi: POST /editor/api/frontend con body vacío → 400', async () => {
  const r2 = mockR2()
  const req = new Request('https://x/editor/api/frontend', { method: 'POST', body: '' })
  const res = await handleEditorApi(req, { STUDIO_R2: r2 }, VALID_BOX, '/editor/api/frontend')
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.error, 'empty_body')
})

test('handleEditorApi: POST /editor/api/flow guarda JSON parseado en R2', async () => {
  const r2 = mockR2()
  const flowJson = [{ id: '1', type: 'http-in', name: 'Start' }]
  const req = new Request('https://x/editor/api/flow', {
    method: 'POST',
    body: JSON.stringify(flowJson),
  })
  const res = await handleEditorApi(req, { STUDIO_R2: r2 }, VALID_BOX, '/editor/api/flow')
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(r2.store[`box-${VALID_BOX}/flow.json`]), flowJson)
})

test('handleEditorApi: POST /editor/api/flow con JSON inválido → 400', async () => {
  const r2 = mockR2()
  const req = new Request('https://x/editor/api/flow', { method: 'POST', body: '{not json' })
  const res = await handleEditorApi(req, { STUDIO_R2: r2 }, VALID_BOX, '/editor/api/flow')
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.error, 'invalid_json')
})

test('handleEditorApi: POST /editor/api/variables guarda con HTTP metadata correcto', async () => {
  const r2 = mockR2()
  const vars = { vars: { apiKey: '...' }, secrets: {} }
  const req = new Request('https://x/editor/api/variables', {
    method: 'POST',
    body: JSON.stringify(vars),
  })
  const res = await handleEditorApi(req, { STUDIO_R2: r2 }, VALID_BOX, '/editor/api/variables')
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(r2.store[`box-${VALID_BOX}/vars.json`]), vars)
})

test('handleEditorApi: POST /editor/api/variables sin vars → 400', async () => {
  const r2 = mockR2()
  const req = new Request('https://x/editor/api/variables', {
    method: 'POST',
    body: JSON.stringify({ secrets: {} }),
  })
  const res = await handleEditorApi(req, { STUDIO_R2: r2 }, VALID_BOX, '/editor/api/variables')
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.error, 'vars_must_be_object')
})

test('handleEditorApi: POST /editor/api/deploy → no-op con nota', async () => {
  const r2 = mockR2()
  const req = new Request('https://x/editor/api/deploy', { method: 'POST', body: '{}' })
  const res = await handleEditorApi(req, { STUDIO_R2: r2 }, VALID_BOX, '/editor/api/deploy')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.match(body.note, /no-op/)
  // No debe haber escrito nada en R2.
  assert.deepEqual(Object.keys(r2.store), [])
})

test('handleEditorApi: path desconocido → 404', async () => {
  const r2 = mockR2()
  const req = new Request('https://x/editor/api/unknown', { method: 'POST', body: '{}' })
  const res = await handleEditorApi(req, { STUDIO_R2: r2 }, VALID_BOX, '/editor/api/unknown')
  assert.equal(res.status, 404)
})

// === loadStoredFlows ===

test('loadStoredFlows: sin R2 → {}', async () => {
  assert.deepEqual(await loadStoredFlows({}, VALID_BOX), {})
})

test('loadStoredFlows: R2 sin el key → {}', async () => {
  const env = { STUDIO_R2: mockR2() }
  assert.deepEqual(await loadStoredFlows(env, VALID_BOX), {})
})

test('loadStoredFlows: R2 con JSON parseado → objeto', async () => {
  const flows = { miFlow: [{ id: '1', type: 'http-in' }] }
  const env = { STUDIO_R2: mockR2({ keys: { [`box-${VALID_BOX}/flow.json`]: JSON.stringify(flows) } }) }
  assert.deepEqual(await loadStoredFlows(env, VALID_BOX), flows)
})

test('loadStoredFlows: JSON corrupto → {} (degradación elegante)', async () => {
  const env = { STUDIO_R2: mockR2({ keys: { [`box-${VALID_BOX}/flow.json`]: '{not json' } }) }
  assert.deepEqual(await loadStoredFlows(env, VALID_BOX), {})
})

// === handleEditorFrontend ===

test('handleEditorFrontend: devuelve el HTML pasado como string', async () => {
  const res = handleEditorFrontend('<html>studio</html>')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('Content-Type'), /text\/html/)
  assert.equal(await res.text(), '<html>studio</html>')
})