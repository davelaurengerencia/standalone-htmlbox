// __tests__/appDataApi.test.js — router de /api/app-data/{boxId}/tables/...
//
// Tests centrados en:
//   - parsing de URL
//   - gates de auth (sesión app-user)
//   - método no permitido → 405
//
// Lógica de DB se valida end-to-end con curl contra el dev server.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleAppDataApi } from '../src/lib/appDataApi.js'

const BOX_ID = 'lf6l61etomwk9fdl'

function makeReq(method, url) {
  return {
    method,
    url,
    headers: { get: () => null },
  }
}

function makeEnv() {
  return { HTMLBOX_CONTROL_PLANE_ORIGIN: 'https://controlplane.htmlbox.dev' }
}

test('router devuelve null para URL que no matchea', async () => {
  const url = new URL('https://htmlbox.dev/api/other/x')
  const r = await handleAppDataApi(makeReq('GET', 'https://htmlbox.dev/api/other/x'), makeEnv(), url)
  assert.equal(r, null)
})

test('router devuelve null para boxId con formato inválido', async () => {
  const url = new URL('https://htmlbox.dev/api/app-data/BAD/tables/ventas/rows')
  const r = await handleAppDataApi(makeReq('GET', 'https://htmlbox.dev/api/app-data/BAD/tables/ventas/rows'), makeEnv(), url)
  assert.equal(r, null)
})

test('router devuelve null para slug con mayúsculas', async () => {
  const url = new URL(`https://htmlbox.dev/api/app-data/${BOX_ID}/tables/Ventas/rows`)
  const r = await handleAppDataApi(makeReq('GET', url.toString()), makeEnv(), url)
  assert.equal(r, null)
})

test('método incorrecto en /rows → 405', async () => {
  const url = new URL(`https://htmlbox.dev/api/app-data/${BOX_ID}/tables/ventas/rows`)
  const r = await handleAppDataApi(makeReq('POST', url.toString()), makeEnv(), url)
  assert.equal(r.status, 405)
})

test('método incorrecto en /upsert → 405', async () => {
  const url = new URL(`https://htmlbox.dev/api/app-data/${BOX_ID}/tables/ventas/upsert`)
  const r = await handleAppDataApi(makeReq('GET', url.toString()), makeEnv(), url)
  assert.equal(r.status, 405)
})

test('op inválida (no rows/upsert) → null', async () => {
  const url = new URL(`https://htmlbox.dev/api/app-data/${BOX_ID}/tables/ventas/upload`)
  const r = await handleAppDataApi(makeReq('POST', url.toString()), makeEnv(), url)
  assert.equal(r, null)
})

test('router matchea /rows y /upsert para boxId válido', async () => {
  for (const op of ['rows', 'upsert']) {
    const method = op === 'rows' ? 'GET' : 'POST'
    const url = new URL(`https://htmlbox.dev/api/app-data/${BOX_ID}/tables/ventas/${op}`)
    const r = await handleAppDataApi(makeReq(method, url.toString()), makeEnv(), url)
    // Llega al router (matchea); el status puede ser 401 por falta de sesión app-user
    assert.notEqual(r, null)
    assert.ok([401, 404].includes(r.status), `esperaba 401 o 404, obtuve ${r.status}`)
  }
})

test('slug demasiado largo (>40 chars) → null', async () => {
  const longSlug = 'a'.repeat(50)
  const url = new URL(`https://htmlbox.dev/api/app-data/${BOX_ID}/tables/${longSlug}/rows`)
  const r = await handleAppDataApi(makeReq('GET', url.toString()), makeEnv(), url)
  assert.equal(r, null)
})

test('slug con caracter inválido (-) en posición 0 → null', async () => {
  const url = new URL(`https://htmlbox.dev/api/app-data/${BOX_ID}/tables/-ventas/rows`)
  const r = await handleAppDataApi(makeReq('GET', url.toString()), makeEnv(), url)
  assert.equal(r, null)
})