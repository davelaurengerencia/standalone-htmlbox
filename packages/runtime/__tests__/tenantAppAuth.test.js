// __tests__/tenantAppAuth.test.js — router de /api/tenant-app-auth/{boxId}/...
//
// Tests centrados en:
//   - parsing de URL
//   - proxy a control-plane (mockeado)
//   - gates anti-enumeración (respuesta genérica)
//   - cookie extraction

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleTenantAppAuth, getTenantAppSessionIdFromRequest } from '../src/lib/tenantAppAuth.js'

const BOX_ID = 'lf6l61etomwk9fdl'

function makeReq(method, url, headers = {}, body = null) {
  return {
    method,
    url,
    headers: {
      get: (k) => {
        const lk = k.toLowerCase()
        for (const hk of Object.keys(headers)) {
          if (hk.toLowerCase() === lk) return headers[hk]
        }
        return null
      },
    },
    json: async () => body,
  }
}

function makeEnv(overrides = {}) {
  return {
    HTMLBOX_CONTROL_PLANE_ORIGIN: 'https://controlplane.htmlbox.dev',
    HTMLBOX_INTERNAL_SECRET: 'test-secret',
    HTMLBOX_ENV: 'production',
    ...overrides,
  }
}

// ─── Router ──────────────────────────────────────────────────────────────

test('router devuelve null para URL que no matchea', async () => {
  const url = new URL('https://htmlbox.dev/api/other/x')
  const r = await handleTenantAppAuth(makeReq('GET', 'https://htmlbox.dev/api/other/x'), makeEnv(), url)
  assert.equal(r, null)
})

test('router devuelve null para boxId con formato inválido', async () => {
  const url = new URL('https://htmlbox.dev/api/tenant-app-auth/INVALID/me')
  const r = await handleTenantAppAuth(makeReq('GET', url.toString()), makeEnv(), url)
  assert.equal(r, null)
})

test('router matchea las 5 operaciones', async () => {
  // Configuramos un mock que devuelve box válido (con tenant_id) para que el
  // router no corte en resolveBoxDb antes del match.
  globalThis.fetch = async (url) => {
    if (url.endsWith('/db')) {
      return new Response(JSON.stringify({
        box: { id: BOX_ID, slug: 'mybox', visibility: 'private', tenant_id: 't1', tenant_slug: 'acme', turso_db_url: 'libsql://test', turso_db_token: 'tok' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.endsWith('/api/internal/tenant-app-auth/access')) {
      return new Response(JSON.stringify({ allowed: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('not mocked', { status: 404 })
  }
  for (const op of ['request', 'verify', 'consume', 'me', 'logout']) {
    const method = op === 'request' || op === 'consume' || op === 'logout' ? 'POST' : 'GET'
    const url = new URL(`https://htmlbox.dev/api/tenant-app-auth/${BOX_ID}/${op}`)
    const r = await handleTenantAppAuth(makeReq(method, url.toString()), makeEnv(), url)
    assert.notEqual(r, null, `op ${op} debería matchear`)
  }
})

test('método incorrecto → 405', async () => {
  const url = new URL(`https://htmlbox.dev/api/tenant-app-auth/${BOX_ID}/me`)
  const r = await handleTenantAppAuth(makeReq('POST', url.toString()), makeEnv(), url)
  assert.equal(r.status, 405)
})

// ─── POST /request: gate anti-enumeración ────────────────────────────────

test('POST /request — body no es JSON → respuesta genérica', async () => {
  // Mock que devuelve que box no existe (404)
  globalThis.fetch = async (url) => {
    if (url.endsWith('/db')) {
      return new Response(JSON.stringify({ box: null }), { status: 404, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('not mocked', { status: 404 })
  }
  const url = new URL(`https://htmlbox.dev/api/tenant-app-auth/${BOX_ID}/request`)
  const req = makeReq('POST', url.toString(), {}, null)
  req.json = async () => { throw new Error('parse error') }
  const r = await handleTenantAppAuth(req, makeEnv(), url)
  // Si el box no existe, devuelve 404 (no respuesta genérica).
  assert.equal(r.status, 404)
})

test('POST /request — box existe + email inválido → respuesta genérica', async () => {
  let proxied = false
  globalThis.fetch = async (url) => {
    if (url.endsWith('/db')) {
      return new Response(JSON.stringify({
        box: { id: BOX_ID, slug: 'mybox', visibility: 'private', tenant_id: 't1', tenant_slug: 'acme', turso_db_url: 'libsql://test', turso_db_token: 'tok' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.endsWith('/api/internal/tenant-app-auth/request')) {
      proxied = true
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('not mocked', { status: 404 })
  }
  const url = new URL(`https://htmlbox.dev/api/tenant-app-auth/${BOX_ID}/request`)
  const req = makeReq('POST', url.toString(), {}, { email: 'no-email' })
  const r = await handleTenantAppAuth(req, makeEnv(), url)
  assert.equal(r.status, 200)
  // proxy igual se llama — la respuesta genérica es de control-plane
  assert.ok(proxied)
})

test('POST /request — en production, strip _dev_preview del response', async () => {
  globalThis.fetch = async (url) => {
    if (url.endsWith('/db')) {
      return new Response(JSON.stringify({
        box: { id: BOX_ID, slug: 'mybox', visibility: 'private', tenant_id: 't1', tenant_slug: 'acme', turso_db_url: 'libsql://test', turso_db_token: 'tok' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.endsWith('/api/internal/tenant-app-auth/request')) {
      return new Response(JSON.stringify({ ok: true, _dev_preview: 'http://example.com/...' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('not mocked', { status: 404 })
  }
  const url = new URL(`https://htmlbox.dev/api/tenant-app-auth/${BOX_ID}/request`)
  const req = makeReq('POST', url.toString(), {}, { email: 'x@y.com' })
  const r = await handleTenantAppAuth(req, makeEnv({ HTMLBOX_ENV: 'production' }), url)
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body._dev_preview, undefined)
})

test('POST /request — en dev, conserva _dev_preview', async () => {
  globalThis.fetch = async (url) => {
    if (url.endsWith('/db')) {
      return new Response(JSON.stringify({
        box: { id: BOX_ID, slug: 'mybox', visibility: 'private', tenant_id: 't1', tenant_slug: 'acme', turso_db_url: 'libsql://test', turso_db_token: 'tok' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.endsWith('/api/internal/tenant-app-auth/request')) {
      return new Response(JSON.stringify({ ok: true, _dev_preview: 'http://example.com/...' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('not mocked', { status: 404 })
  }
  const url = new URL(`https://htmlbox.dev/api/tenant-app-auth/${BOX_ID}/request`)
  const req = makeReq('POST', url.toString(), {}, { email: 'x@y.com' })
  const r = await handleTenantAppAuth(req, makeEnv({ HTMLBOX_ENV: 'development' }), url)
  const body = await r.json()
  assert.ok(body._dev_preview)
})

// ─── GET /me ─────────────────────────────────────────────────────────────

test('GET /me — sin cookie hbx_tapp_sid → tenantAppUser: null', async () => {
  const url = new URL(`https://htmlbox.dev/api/tenant-app-auth/${BOX_ID}/me`)
  const r = await handleTenantAppAuth(makeReq('GET', url.toString()), makeEnv(), url)
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.tenantAppUser, null)
})

test('GET /me — con cookie + access denied → tenantAppUser: null', async () => {
  globalThis.fetch = async (url) => {
    if (url.endsWith('/api/internal/tenant-app-auth/access')) {
      return new Response(JSON.stringify({ allowed: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('not mocked', { status: 404 })
  }
  const url = new URL(`https://htmlbox.dev/api/tenant-app-auth/${BOX_ID}/me`)
  const req = makeReq('GET', url.toString(), { Cookie: 'hbx_tapp_sid=abc' })
  const r = await handleTenantAppAuth(req, makeEnv(), url)
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.tenantAppUser, null)
})

test('GET /me — con cookie + access granted → devuelve tenantAppUser', async () => {
  globalThis.fetch = async (url) => {
    if (url.endsWith('/api/internal/tenant-app-auth/access')) {
      return new Response(JSON.stringify({
        allowed: true,
        role: 'full',
        tenantAppUser: { id: 'tu_123', email: 'boss@acme.com', tenant_id: 't1' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('not mocked', { status: 404 })
  }
  const url = new URL(`https://htmlbox.dev/api/tenant-app-auth/${BOX_ID}/me`)
  const req = makeReq('GET', url.toString(), { Cookie: 'hbx_tapp_sid=abc' })
  const r = await handleTenantAppAuth(req, makeEnv(), url)
  const body = await r.json()
  assert.equal(body.tenantAppUser.email, 'boss@acme.com')
  assert.equal(body.role, 'full')
})

// ─── POST /logout ────────────────────────────────────────────────────────

test('POST /logout devuelve Set-Cookie Max-Age=0', async () => {
  const url = new URL(`https://htmlbox.dev/api/tenant-app-auth/${BOX_ID}/logout`)
  const r = await handleTenantAppAuth(makeReq('POST', url.toString()), makeEnv(), url)
  assert.equal(r.status, 200)
  assert.match(r.headers.get('Set-Cookie') || '', /Max-Age=0/)
})

// ─── getTenantAppSessionIdFromRequest ────────────────────────────────────

test('getTenantAppSessionIdFromRequest extrae el session id', () => {
  const req = { headers: { get: (k) => k.toLowerCase() === 'cookie' ? 'hbx_tapp_sid=zzz; sid=other' : null } }
  assert.equal(getTenantAppSessionIdFromRequest(req), 'zzz')
})

test('getTenantAppSessionIdFromRequest devuelve null si no hay cookie', () => {
  const req = { headers: { get: () => null } }
  assert.equal(getTenantAppSessionIdFromRequest(req), null)
})

test('getTenantAppSessionIdFromRequest ignora otras cookies', () => {
  const req = { headers: { get: (k) => k.toLowerCase() === 'cookie' ? 'sid=plat' : null } }
  assert.equal(getTenantAppSessionIdFromRequest(req), null)
})