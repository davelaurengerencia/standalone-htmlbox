// __tests__/dataApi.bulk.test.js — endpoint POST /api/data/{boxId}/tables/bulk-create
//
// Usa mock.module (Node 22+) para stubear boxDb.js y así evitar conexiones
// reales a Turso. El script `test` en package.json habilita
// --experimental-test-module-mocks.

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

const BOX_ID = 'lf6l61etomwk9fdl'

function makeEnv() {
  return { HTMLBOX_CONTROL_PLANE_ORIGIN: 'https://controlplane.sivocloud.dev' }
}

function makeRequest({ method = 'POST', url, body = null } = {}) {
  const headers = { get: (k) => (k === 'Cookie' ? 'sid=abc' : null) }
  return {
    method,
    url,
    headers,
    json: async () => body,
    text: async () => (body ? JSON.stringify(body) : ''),
  }
}

function makeFakeClient({ failOnSlug = null } = {}) {
  return {
    execute: async (stmt, args2) => {
      let sqlText, bindArgs
      if (typeof stmt === 'string') { sqlText = stmt; bindArgs = args2 }
      else if (stmt && typeof stmt === 'object') { sqlText = stmt.sql ?? ''; bindArgs = stmt.args }
      else throw new Error('client.execute: primer arg must be string u objeto')

      if (failOnSlug && sqlText.includes(`htmlbox_${failOnSlug}`)) {
        throw new Error('invalid_column_name')
      }

      if (/^\s*(CREATE TABLE|CREATE INDEX)/i.test(sqlText)) {
        return { rows: [], columns: [], rowsAffected: 0 }
      }
      if (/^\s*SELECT name FROM htmlbox_tables/i.test(sqlText)) {
        return { rows: bindArgs?.[0] ? [{ name: bindArgs[0] }] : [], columns: [], rowsAffected: 0 }
      }
      if (/^\s*INSERT INTO htmlbox_tables/i.test(sqlText)) {
        return { rows: [], columns: [], rowsAffected: 1, lastInsertRowid: 1 }
      }
      if (/^\s*INSERT INTO htmlbox_files/i.test(sqlText)) {
        return { rows: [], columns: [], rowsAffected: 1, lastInsertRowid: 1 }
      }
      if (/^\s*INSERT INTO htmlbox_/i.test(sqlText)) {
        return { rows: [], columns: [], rowsAffected: 1, lastInsertRowid: 1 }
      }
      return { rows: [], columns: [], rowsAffected: 0 }
    },
  }
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
      return new Response(JSON.stringify({ membership }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (u.match(/\/api\/internal\/boxes\/[a-z0-9]+\/db$/)) {
      if (!boxDb) return new Response(JSON.stringify({ box: null }), { status: 404, headers: { 'Content-Type': 'application/json' } })
      return new Response(JSON.stringify({ box: boxDb }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('not found in mock', { status: 404 })
  }
}

let activeClient = makeFakeClient()

mock.module('../src/lib/boxDb.js', {
  namedExports: {
    resolveBoxDb: async () => ({
      boxId: BOX_ID,
      url: 'libsql://fake',
      token: 'fake',
      tenantSlug: 't1',
      boxSlug: 'b1',
      visibility: 'private',
    }),
    getBoxClient: async () => activeClient,
    invalidate: async () => {},
    selectRows: async () => [],
  },
})

const { handleDataApi } = await import('../src/lib/dataApi.js')

test('bulk-create valida auth y crea múltiples tablas', async () => {
  activeClient = makeFakeClient()
  mockControlPlane({
    whoami: { userId: 'u1', tenantId: 't1', isPlatformOwner: false },
    membership: { role: 'editor' },
    boxDb: { id: BOX_ID, tenant_slug: 't1', slug: 'b1', turso_db_url: 'libsql://fake', turso_db_token: 'fake', visibility: 'private' },
  })

  const req = makeRequest({
    url: `https://sivocloud.dev/api/data/${BOX_ID}/tables/bulk-create`,
    body: {
      tables: [
        {
          slug: 'productos',
          name: 'Productos',
          columns: [{ name: 'sku', type: 'string' }, { name: 'price', type: 'number' }],
          sample_rows: [{ sku: 'SKU-001', price: 45000 }, { sku: 'SKU-002', price: 12000 }, { sku: 'SKU-003', price: 9999 }],
        },
        {
          slug: 'clientes',
          name: 'Clientes',
          columns: [{ name: 'email', type: 'string' }],
          sample_rows: [{ email: 'a@x.com' }, { email: 'b@x.com' }, { email: 'c@x.com' }],
        },
      ],
    },
  })
  const url = new URL(req.url)
  const r = await handleDataApi(req, makeEnv(), url)

  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.errors, [])
  assert.equal(body.created.length, 2)
  assert.deepEqual(body.created[0], { slug: 'productos', inserted: 3, columns: 2 })
  assert.deepEqual(body.created[1], { slug: 'clientes', inserted: 3, columns: 1 })
})

test('bulk-create rechaza slugs inválidos', async () => {
  activeClient = makeFakeClient()
  mockControlPlane({
    whoami: { userId: 'u1', tenantId: 't1', isPlatformOwner: false },
    membership: { role: 'editor' },
    boxDb: { id: BOX_ID, tenant_slug: 't1', slug: 'b1', turso_db_url: 'libsql://fake', turso_db_token: 'fake', visibility: 'private' },
  })

  const req = makeRequest({
    url: `https://sivocloud.dev/api/data/${BOX_ID}/tables/bulk-create`,
    body: {
      tables: [
        {
          slug: 'Bad-Slug',
          name: 'Productos',
          columns: [{ name: 'sku', type: 'string' }],
          sample_rows: [{ sku: 'X' }],
        },
      ],
    },
  })
  const url = new URL(req.url)
  const r = await handleDataApi(req, makeEnv(), url)

  assert.equal(r.status, 400)
  const body = await r.json()
  assert.equal(body.error, 'invalid_slug')
})

test('bulk-create rechaza rol viewer', async () => {
  activeClient = makeFakeClient()
  mockControlPlane({
    whoami: { userId: 'u1', tenantId: 't1', isPlatformOwner: false },
    membership: { role: 'viewer' },
    boxDb: { id: BOX_ID, tenant_slug: 't1', slug: 'b1', turso_db_url: 'libsql://fake', turso_db_token: 'fake', visibility: 'private' },
  })

  const viewerBody = {
    tables: [
      {
        slug: 'productos',
        name: 'P',
        columns: [{ name: 'sku', type: 'string' }],
        sample_rows: [{ sku: '1' }],
      },
    ],
  }
  const req = makeRequest({
    url: `https://sivocloud.dev/api/data/${BOX_ID}/tables/bulk-create`,
    body: viewerBody,
  })
  const url = new URL(req.url)
  const r = await handleDataApi(req, makeEnv(), url)

  assert.equal(r.status, 403)
  const body = await r.json()
  assert.equal(body.error, 'forbidden_role')
})

test('bulk-create maneja errores parciales', async () => {
  activeClient = makeFakeClient({ failOnSlug: 'ventas' })
  mockControlPlane({
    whoami: { userId: 'u1', tenantId: 't1', isPlatformOwner: false },
    membership: { role: 'editor' },
    boxDb: { id: BOX_ID, tenant_slug: 't1', slug: 'b1', turso_db_url: 'libsql://fake', turso_db_token: 'fake', visibility: 'private' },
  })

  const req = makeRequest({
    url: `https://sivocloud.dev/api/data/${BOX_ID}/tables/bulk-create`,
    body: {
      tables: [
        {
          slug: 'productos',
          name: 'Productos',
          columns: [{ name: 'sku', type: 'string' }],
          sample_rows: [{ sku: 'SKU-001' }],
        },
        {
          slug: 'ventas',
          name: 'Ventas',
          columns: [{ name: 'weird column', type: 'string' }],
          sample_rows: [{ 'weird column': 'x' }],
        },
      ],
    },
  })
  const url = new URL(req.url)
  const r = await handleDataApi(req, makeEnv(), url)

  assert.equal(r.status, 207)
  const body = await r.json()
  assert.equal(body.ok, false)
  assert.equal(body.created.length, 1)
  assert.equal(body.created[0].slug, 'productos')
  assert.equal(body.errors.length, 1)
  assert.equal(body.errors[0].slug, 'ventas')
})
