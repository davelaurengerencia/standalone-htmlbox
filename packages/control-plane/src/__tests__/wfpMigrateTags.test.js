// __tests__/wfpMigrateTags.test.js — tests del endpoint admin
// POST /api/internal/wfp/migrate-tags (routes/internal.js).
//
// Cubre:
//   - Gate de secreto (403 sin header)
//   - 503 cuando WFP no está configurado (sin token / sin account ID)
//   - Happy path: 2 boxes ready → 2 deploys OK → { total: 2, succeeded: 2, failed: [] }
//   - Best-effort: si un deploy falla, el otro igual se intenta, el resultado
//     lista el boxId + error del que falló
//   - Tags construidas con los campos correctos (tenant, box, ids, visibility, template)
//   - Filtra por wfp_status='ready' (no toca los 'failed')

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleInternal } from '../routes/internal.js'

const VALID_BOX_A = 'abcdef0123456789'
const VALID_BOX_B = '0123456789abcdef'

// D1 mock que devuelve `boxes` cuando el handler llama .all()/.first()
// (cualquier query cae en el mismo resultado — sirve para nuestros tests
// porque el endpoint solo hace UNA query y luego hace calls a deployBoxWorker
// que mockeamos vía globalThis.fetch).
function mockD1(boxes) {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => Array.isArray(boxes) ? boxes[0] : boxes,
          all: async () => ({ results: boxes }),
          run: async () => ({ success: true, meta: { changes: 1 } }),
        }),
        all: async () => ({ results: boxes }),
        first: async () => Array.isArray(boxes) ? boxes[0] : boxes,
        run: async () => ({ success: true, meta: { changes: 1 } }),
      }),
    },
  }
}

function makeRequest(secret) {
  const headers = {}
  if (secret) headers['X-HTMLBox-Internal-Secret'] = secret
  return new Request('http://localhost/api/internal/wfp/migrate-tags', { method: 'POST', headers })
}

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// ============ Auth ============

test('migrate-tags: 403 sin header X-HTMLBox-Internal-Secret', async () => {
  const env = mockD1([])
  env.WFP_DEPLOY_TOKEN = 'tok'
  env.HTMLBOX_CLOUDFLARE_ACCOUNT_ID = 'acct'
  const res = await handleInternal(makeRequest(null), env, null, '/api/internal/wfp/migrate-tags', 'POST')
  assert.equal(res.status, 403)
  const body = await res.json()
  assert.equal(body.error, 'forbidden')
})

test('migrate-tags: 403 con secret incorrecto', async () => {
  const env = mockD1([])
  env.HTMLBOX_INTERNAL_SECRET = 'real-secret'
  env.WFP_DEPLOY_TOKEN = 'tok'
  env.HTMLBOX_CLOUDFLARE_ACCOUNT_ID = 'acct'
  const res = await handleInternal(makeRequest('wrong'), env, null, '/api/internal/wfp/migrate-tags', 'POST')
  assert.equal(res.status, 403)
})

// ============ Configuración faltante ============

test('migrate-tags: 503 si falta WFP_DEPLOY_TOKEN', async () => {
  const env = mockD1([])
  env.HTMLBOX_INTERNAL_SECRET = 'sec'
  env.HTMLBOX_CLOUDFLARE_ACCOUNT_ID = 'acct'
  // sin WFP_DEPLOY_TOKEN
  const res = await handleInternal(makeRequest('sec'), env, null, '/api/internal/wfp/migrate-tags', 'POST')
  assert.equal(res.status, 503)
  const body = await res.json()
  assert.equal(body.error, 'wfp_not_configured')
  assert.match(body.detail, /WFP_DEPLOY_TOKEN/)
})

test('migrate-tags: 503 si falta HTMLBOX_CLOUDFLARE_ACCOUNT_ID', async () => {
  const env = mockD1([])
  env.HTMLBOX_INTERNAL_SECRET = 'sec'
  env.WFP_DEPLOY_TOKEN = 'tok'
  // sin HTMLBOX_CLOUDFLARE_ACCOUNT_ID
  const res = await handleInternal(makeRequest('sec'), env, null, '/api/internal/wfp/migrate-tags', 'POST')
  assert.equal(res.status, 503)
  const body = await res.json()
  assert.match(body.detail, /HTMLBOX_CLOUDFLARE_ACCOUNT_ID/)
})

// ============ Happy path ============

test('migrate-tags: 2 boxes ready → 2 deploys OK + tags correctas', async () => {
  const boxes = [
    {
      id: VALID_BOX_A,
      slug: 'mi-dashboard',
      visibility: 'public',
      template: 'empty',
      tenant_id: 'tenant_id_aaa',
      tenant_slug: 'david',
    },
    {
      id: VALID_BOX_B,
      slug: 'segundo-box',
      visibility: 'private',
      template: 'custom',
      tenant_id: 'tenant_id_bbb',
      tenant_slug: 'acme',
    },
  ]
  const env = mockD1(boxes)
  env.WFP_INTERNAL_SECRET = 'sec'
  env.HTMLBOX_INTERNAL_SECRET = 'sec'
  env.WFP_DEPLOY_TOKEN = 'tok'
  env.HTMLBOX_CLOUDFLARE_ACCOUNT_ID = 'acct-id'

  const fetchCalls = []
  const orig = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init })
    return jsonRes({ success: true })
  }

  try {
    const res = await handleInternal(makeRequest('sec'), env, null, '/api/internal/wfp/migrate-tags', 'POST')
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.total, 2)
    assert.equal(body.succeeded, 2)
    assert.deepEqual(body.failed, [])
    assert.equal(fetchCalls.length, 2)

    // Verificamos que cada PUT llevó las tags correctas (1ra box).
    const form = fetchCalls[0].init.body
    assert.ok(form instanceof FormData, 'body debe ser FormData')
    const parts = {}
    for (const [name, value] of form.entries()) {
      if (value instanceof Blob) parts[name] = await value.text()
      else parts[name] = String(value)
    }
    const meta = JSON.parse(parts.metadata)
    assert.deepEqual(meta.tags, [
      'tenant:david',
      'box:mi-dashboard',
      'tenant-id:tenant_id_aaa',
      `box-id:${VALID_BOX_A}`,
      'visibility:public',
      'template:empty',
    ])
    // El URL apunta al script correcto.
    assert.match(fetchCalls[0].url, /\/workers\/dispatch\/namespaces\/htmlbox-boxes\/scripts\/box-abcdef0123456789$/)

    // 2da box: tags distintas (otro tenant, otro slug, otro template).
    const form2 = fetchCalls[1].init.body
    const parts2 = {}
    for (const [name, value] of form2.entries()) {
      if (value instanceof Blob) parts2[name] = await value.text()
      else parts2[name] = String(value)
    }
    const meta2 = JSON.parse(parts2.metadata)
    assert.deepEqual(meta2.tags, [
      'tenant:acme',
      'box:segundo-box',
      'tenant-id:tenant_id_bbb',
      `box-id:${VALID_BOX_B}`,
      'visibility:private',
      'template:custom',
    ])
  } finally {
    globalThis.fetch = orig
  }
})

test('migrate-tags: 0 boxes ready → 0 deploys, response válido', async () => {
  const env = mockD1([])
  env.HTMLBOX_INTERNAL_SECRET = 'sec'
  env.WFP_DEPLOY_TOKEN = 'tok'
  env.HTMLBOX_CLOUDFLARE_ACCOUNT_ID = 'acct-id'

  const orig = globalThis.fetch
  let called = false
  globalThis.fetch = async () => { called = true; return jsonRes({ success: true }) }

  try {
    const res = await handleInternal(makeRequest('sec'), env, null, '/api/internal/wfp/migrate-tags', 'POST')
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.total, 0)
    assert.equal(body.succeeded, 0)
    assert.deepEqual(body.failed, [])
    assert.equal(called, false, 'no debe llamar a Cloudflare si no hay boxes')
  } finally {
    globalThis.fetch = orig
  }
})

// ============ Best-effort: un deploy falla, el otro sigue ============

test('migrate-tags: si un deploy falla, el otro igual se intenta y failed[] lo reporta', async () => {
  const boxes = [
    { id: VALID_BOX_A, slug: 'a', visibility: 'private', template: 'empty', tenant_id: 't1', tenant_slug: 'david' },
    { id: VALID_BOX_B, slug: 'b', visibility: 'public', template: 'empty', tenant_id: 't2', tenant_slug: 'acme' },
  ]
  const env = mockD1(boxes)
  env.HTMLBOX_INTERNAL_SECRET = 'sec'
  env.WFP_DEPLOY_TOKEN = 'tok'
  env.HTMLBOX_CLOUDFLARE_ACCOUNT_ID = 'acct-id'

  const orig = globalThis.fetch
  let n = 0
  globalThis.fetch = async (url) => {
    n++
    if (url.includes(VALID_BOX_A)) {
      return new Response('{"errors":[{"message":"simulated 502"}]}', { status: 502, headers: { 'Content-Type': 'application/json' } })
    }
    return jsonRes({ success: true })
  }

  try {
    const res = await handleInternal(makeRequest('sec'), env, null, '/api/internal/wfp/migrate-tags', 'POST')
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.total, 2)
    assert.equal(body.succeeded, 1)
    assert.equal(body.failed.length, 1)
    assert.equal(body.failed[0].boxId, VALID_BOX_A)
    assert.match(body.failed[0].error, /Cloudflare respondió 502/)
    assert.equal(n, 2, 'ambos boxes se intentaron (best-effort)')
  } finally {
    globalThis.fetch = orig
  }
})

// ============ Filtro por wfp_status ============

test('migrate-tags: el SQL filtra por wfp_status = \'ready\' (no toca los failed)', async () => {
  let capturedSql = null
  const env = {
    DB: {
      prepare(sql) {
        capturedSql = sql
        return {
          bind: () => ({ all: async () => ({ results: [] }) }),
          all: async () => ({ results: [] }),
        }
      },
    },
    HTMLBOX_INTERNAL_SECRET: 'sec',
    WFP_DEPLOY_TOKEN: 'tok',
    HTMLBOX_CLOUDFLARE_ACCOUNT_ID: 'acct-id',
  }
  const res = await handleInternal(makeRequest('sec'), env, null, '/api/internal/wfp/migrate-tags', 'POST')
  assert.equal(res.status, 200)
  assert.match(capturedSql, /wfp_status\s*=\s*'ready'/, 'debe filtrar wfp_status = ready')
})

// ============ Método incorrecto ============

test('migrate-tags: GET → 404 (solo POST está implementado)', async () => {
  const env = mockD1([])
  env.HTMLBOX_INTERNAL_SECRET = 'sec'
  env.WFP_DEPLOY_TOKEN = 'tok'
  env.HTMLBOX_CLOUDFLARE_ACCOUNT_ID = 'acct-id'
  const res = await handleInternal(
    new Request('http://localhost/api/internal/wfp/migrate-tags', { method: 'GET', headers: { 'X-HTMLBox-Internal-Secret': 'sec' } }),
    env, null, '/api/internal/wfp/migrate-tags', 'GET'
  )
  assert.equal(res.status, 404)
})
