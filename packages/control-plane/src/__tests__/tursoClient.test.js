// src/__tests__/tursoClient.test.js — sanity check de la abstracción Turso.
//
// En modo local sin sqld corriendo, `createBoxDatabase` falla con mensaje
// claro. Verificamos que el path "cloud" produce una URL bien formada y
// fakea respuestas de la Platform API.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBoxDatabase, tursoMode } from '../lib/tursoClient.js'

test('tursoMode respeta var', () => {
  assert.equal(tursoMode({ HTMLBOX_TURSO_MODE: 'cloud' }), 'cloud')
  assert.equal(tursoMode({ HTMLBOX_TURSO_MODE: 'LOCAL' }), 'local')
  assert.equal(tursoMode({}), 'local') // default
})

test('createBoxDatabase (local) falla claro si sqld no está arriba', async () => {
  // Apuntamos a un puerto que NO está escuchando — error claro.
  const env = {
    HTMLBOX_TURSO_MODE: 'local',
    HTMLBOX_TURSO_DEV_URL: 'http://127.0.0.1:1', // unreachable
  }
  await assert.rejects(
    () => createBoxDatabase(env, 'abc1234567890123'),
    /sqld no responde/,
  )
})

test('createBoxDatabase (cloud) arma URL libsql:// válida', async () => {
  // Patcheamos el fetch global antes de instanciar nada.
  const originalFetch = globalThis.fetch
  let lastCreateBody = null
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.includes('/databases') && init?.method === 'POST' && !u.includes('/auth/tokens')) {
      lastCreateBody = JSON.parse(init.body)
      return new Response(JSON.stringify({
        database: { hostname: `htmlbox-box-abc.turso.io`, name: lastCreateBody.name },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (u.includes('/auth/tokens') && init?.method === 'POST') {
      return new Response(JSON.stringify({ tokens: [{ jwt: 'fake-jwt' }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('not mocked: ' + u, { status: 404 })
  }

  try {
    const env = {
      HTMLBOX_TURSO_MODE: 'cloud',
      HTMLBOX_TURSO_PLATFORM_TOKEN: 'tok',
      HTMLBOX_TURSO_ORG: 'myorg',
    }

    const out = await createBoxDatabase(env, 'abc1234567890123')
    assert.equal(out.url, 'libsql://htmlbox-box-abc.turso.io')
    assert.equal(out.token, 'fake-jwt')
    assert.equal(lastCreateBody.name, 'htmlbox-box-abc1234567890123')
    assert.equal(lastCreateBody.group, 'htmlbox')
  } finally {
    globalThis.fetch = originalFetch
  }
})