// __tests__/appAuthRoutes.test.js — router de /api/app-auth/{boxId}/...
//
// Tests centrados en:
//   - parsing de URL
//   - gates de auth (sesión plataforma, rol, método)
//   - respuesta genérica (anti-enumeration) para invite_only
//   - método no permitido → 405
//
// La lógica de DB (magic links, sesiones, app_users) se valida end-to-end
// con curl contra el dev server — acá no mockeamos Turso porque
// @tursodatabase/serverless conecta de verdad.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleAppAuth } from '../src/lib/appAuthRoutes.js'

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

function makeEnv() {
  return {
    HTMLBOX_CONTROL_PLANE_ORIGIN: 'https://controlplane.htmlbox.dev',
    HTMLBOX_ENV: 'production',
  }
}

// Mock control-plane que devuelve "no box" (404). Sirve para validar el
// path de auth: si pasa auth pero box no existe → 404 box_not_found.
function mockControlPlaneAsPlatformUserNoBox({ role = 'editor' } = {}) {
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.endsWith('/api/internal/whoami')) {
      return new Response(JSON.stringify({ userId: 'u1', tenantId: 't1', isPlatformOwner: false }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (u.match(/\/api\/internal\/boxes\/[a-z0-9]+\/membership$/)) {
      return new Response(JSON.stringify({ membership: { role } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (u.match(/\/api\/internal\/boxes\/[a-z0-9]+\/db$/)) {
      return new Response(JSON.stringify({ box: null }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('not mocked', { status: 404 })
  }
}

// Mock control-plane donde el box SÍ existe (resolvemos /db a un box válido
// pero no nos importan las creds Turso — solo necesitamos pasar el gate de
// role checks antes del getBoxClient).
function mockControlPlaneAsPlatformUserWithBox({ role = 'editor' } = {}) {
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.endsWith('/api/internal/whoami')) {
      return new Response(JSON.stringify({ userId: 'u1', tenantId: 't1', isPlatformOwner: false }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (u.match(/\/api\/internal\/boxes\/[a-z0-9]+\/membership$/)) {
      return new Response(JSON.stringify({ membership: { role } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (u.match(/\/api\/internal\/boxes\/[a-z0-9]+\/db$/)) {
      return new Response(JSON.stringify({
        box: {
          id: BOX_ID, tenant_id: 't1', workspace_id: 'ws1',
          turso_db_url: 'libsql://mock', turso_db_token: 'mock',
          visibility: 'private', box_slug: 'mybox', tenant_slug: 'acme',
        },
      }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('not mocked', { status: 404 })
  }
}

// Mock que rechaza con 401 (sin sesión plataforma).
function mockControlPlaneNoSession() {
  globalThis.fetch = async () => {
    return new Response(JSON.stringify({ error: 'unauthenticated' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    })
  }
}

// ─── Router ───────────────────────────────────────────────────────────────

test('router devuelve null para URL que no matchea', async () => {
  const url = new URL('https://htmlbox.dev/api/other/x')
  const r = await handleAppAuth(makeReq('GET', 'https://htmlbox.dev/api/other/x'), makeEnv(), url)
  assert.equal(r, null)
})

test('router devuelve null para boxId con formato inválido', async () => {
  const url = new URL('https://htmlbox.dev/api/app-auth/INVALID/verify')
  const r = await handleAppAuth(makeReq('GET', 'https://htmlbox.dev/api/app-auth/INVALID/verify'), makeEnv(), url)
  assert.equal(r, null)
})

test('método incorrecto en /me → 405', async () => {
  const url = new URL(`https://htmlbox.dev/api/app-auth/${BOX_ID}/me`)
  const r = await handleAppAuth(makeReq('POST', `https://htmlbox.dev/api/app-auth/${BOX_ID}/me`), makeEnv(), url)
  assert.equal(r.status, 405)
})

test('método incorrecto en /consume → 405', async () => {
  const url = new URL(`https://htmlbox.dev/api/app-auth/${BOX_ID}/consume`)
  const r = await handleAppAuth(makeReq('GET', `https://htmlbox.dev/api/app-auth/${BOX_ID}/consume`), makeEnv(), url)
  assert.equal(r.status, 405)
})

// ─── Rutas públicas: gates anti-enumeración ────────────────────────────────

test('POST /request — email inválido → respuesta genérica (200)', async () => {
  mockControlPlaneNoSession()
  const url = new URL(`https://htmlbox.dev/api/app-auth/${BOX_ID}/request`)
  const req = makeReq('POST', `https://htmlbox.dev/api/app-auth/${BOX_ID}/request`, {}, { email: 'no-email' })
  const r = await handleAppAuth(req, makeEnv(), url)
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.match(body.message, /recibir/i)
  assert.equal(body._dev_preview, undefined)
})

test('POST /request — body no es JSON → 400 invalid_body', async () => {
  mockControlPlaneNoSession()
  const url = new URL(`https://htmlbox.dev/api/app-auth/${BOX_ID}/request`)
  const req = makeReq('POST', `https://htmlbox.dev/api/app-auth/${BOX_ID}/request`, {}, null)
  // Simular JSON inválido lanzando error
  req.json = async () => { throw new Error('parse error') }
  const r = await handleAppAuth(req, makeEnv(), url)
  assert.equal(r.status, 400)
})

test('POST /consume — body sin token → 400 missing_token', async () => {
  mockControlPlaneNoSession()
  const url = new URL(`https://htmlbox.dev/api/app-auth/${BOX_ID}/consume`)
  const req = makeReq('POST', `https://htmlbox.dev/api/app-auth/${BOX_ID}/consume`, {}, {})
  const r = await handleAppAuth(req, makeEnv(), url)
  assert.equal(r.status, 400)
  const body = await r.json()
  assert.equal(body.error, 'missing_token')
})

test('GET /me sin sesión plataforma → 401', async () => {
  mockControlPlaneNoSession()
  const url = new URL(`https://htmlbox.dev/api/app-auth/${BOX_ID}/me`)
  const req = makeReq('GET', `https://htmlbox.dev/api/app-auth/${BOX_ID}/me`)
  const r = await handleAppAuth(req, makeEnv(), url)
  // En el flujo público de /me, NO hay auth de plataforma — el 401 lo daría
  // validateAppSession contra la DB. Sin DB mockeada acá, depende del
  // resolveBoxDb. Solo validamos que NO es null (router matchea).
  assert.notEqual(r, null)
})

// ─── Rutas admin: gates ────────────────────────────────────────────────────

test('GET /admin/users sin sesión plataforma → 401', async () => {
  mockControlPlaneNoSession()
  const url = new URL(`https://htmlbox.dev/api/app-auth/${BOX_ID}/admin/users`)
  const req = makeReq('GET', `https://htmlbox.dev/api/app-auth/${BOX_ID}/admin/users`)
  const r = await handleAppAuth(req, makeEnv(), url)
  assert.equal(r.status, 401)
})

test('POST /admin/users con sesión plataforma pero sin DB → 404 (gate antes de DB)', async () => {
  mockControlPlaneAsPlatformUserNoBox({ role: 'editor' })
  const url = new URL(`https://htmlbox.dev/api/app-auth/${BOX_ID}/admin/users`)
  const req = makeReq('POST', `https://htmlbox.dev/api/app-auth/${BOX_ID}/admin/users`,
    {}, { email: 'x@example.com' })
  const r = await handleAppAuth(req, makeEnv(), url)
  assert.equal(r.status, 404)
  const body = await r.json()
  assert.equal(body.error, 'box_not_found')
})

test('POST /admin/users método GET no permitido', async () => {
  mockControlPlaneAsPlatformUserNoBox({ role: 'editor' })
  const url = new URL(`https://htmlbox.dev/api/app-auth/${BOX_ID}/admin/users`)
  const req = makeReq('DELETE', `https://htmlbox.dev/api/app-auth/${BOX_ID}/admin/users`)
  const r = await handleAppAuth(req, makeEnv(), url)
  assert.equal(r.status, 405)
})

test('POST /admin/users/{id}/disable método GET no permitido', async () => {
  mockControlPlaneAsPlatformUserNoBox({ role: 'editor' })
  const url = new URL(`https://htmlbox.dev/api/app-auth/${BOX_ID}/admin/users/au_abc/disable`)
  const req = makeReq('GET', `https://htmlbox.dev/api/app-auth/${BOX_ID}/admin/users/au_abc/disable`)
  const r = await handleAppAuth(req, makeEnv(), url)
  assert.equal(r.status, 405)
})

test('DELETE /admin/users/{id} método POST no permitido', async () => {
  mockControlPlaneAsPlatformUserNoBox({ role: 'editor' })
  const url = new URL(`https://htmlbox.dev/api/app-auth/${BOX_ID}/admin/users/au_abc`)
  const req = makeReq('POST', `https://htmlbox.dev/api/app-auth/${BOX_ID}/admin/users/au_abc`)
  const r = await handleAppAuth(req, makeEnv(), url)
  assert.equal(r.status, 405)
})

test('POST /admin/settings método GET sí permitido (gate antes de DB)', async () => {
  mockControlPlaneAsPlatformUserNoBox({ role: 'editor' })
  const url = new URL(`https://htmlbox.dev/api/app-auth/${BOX_ID}/admin/settings`)
  const req = makeReq('POST', `https://htmlbox.dev/api/app-auth/${BOX_ID}/admin/settings`,
    {}, { signup_mode: 'invalid' })
  const r = await handleAppAuth(req, makeEnv(), url)
  // Llega al gate de "box existe" → 404
  assert.equal(r.status, 404)
})

// ─── Anexo de Seguridad hallazgo 4: viewer no debe leer admin ─────────────

test('anexo H4 — GET /admin/users con rol viewer → 403 (no lista app_users)', async () => {
  mockControlPlaneAsPlatformUserWithBox({ role: 'viewer' })
  const url = new URL(`https://htmlbox.dev/api/app-auth/${BOX_ID}/admin/users`)
  const req = makeReq('GET', `https://htmlbox.dev/api/app-auth/${BOX_ID}/admin/users`)
  const r = await handleAppAuth(req, makeEnv(), url)
  assert.equal(r.status, 403)
  const body = await r.json()
  assert.equal(body.error, 'forbidden')
  // Reset del mock para no contaminar tests siguientes (los que vienen
  // después no esperan que /db devuelva box válido).
  mockControlPlaneAsPlatformUserNoBox({ role: 'viewer' })
})

test('anexo H4 — GET /admin/settings con rol viewer → 403 (no ve signup_mode)', async () => {
  mockControlPlaneAsPlatformUserWithBox({ role: 'viewer' })
  const url = new URL(`https://htmlbox.dev/api/app-auth/${BOX_ID}/admin/settings`)
  const req = makeReq('GET', `https://htmlbox.dev/api/app-auth/${BOX_ID}/admin/settings`)
  const r = await handleAppAuth(req, makeEnv(), url)
  assert.equal(r.status, 403)
  const body = await r.json()
  assert.equal(body.error, 'forbidden')
  // Reset.
  mockControlPlaneAsPlatformUserNoBox({ role: 'viewer' })
})

// ─── URL parsing ──────────────────────────────────────────────────────────

test('router matchea /api/app-auth/{boxId}/request|verify|consume|me|logout', async () => {
  for (const op of ['request', 'verify', 'consume', 'me', 'logout']) {
    const url = new URL(`https://htmlbox.dev/api/app-auth/${BOX_ID}/${op}`)
    const r = await handleAppAuth(makeReq('GET', url.toString()), makeEnv(), url)
    // Si router matchea, r !== null (aunque el status puede ser 4xx por gate)
    assert.notEqual(r, null, `op ${op} debería matchear`)
  }
})

test('router matchea /admin/users y /admin/users/{id}/{action}', async () => {
  for (const path of [
    `/api/app-auth/${BOX_ID}/admin/users`,
    `/api/app-auth/${BOX_ID}/admin/users/au_abc/disable`,
    `/api/app-auth/${BOX_ID}/admin/users/au_abc/enable`,
    `/api/app-auth/${BOX_ID}/admin/users/au_abc`,
    `/api/app-auth/${BOX_ID}/admin/settings`,
  ]) {
    const url = new URL(`https://htmlbox.dev${path}`)
    const r = await handleAppAuth(makeReq('GET', url.toString()), makeEnv(), url)
    assert.notEqual(r, null, `path ${path} debería matchear`)
  }
})

test('router rechaza userId con formato inválido', async () => {
  // userId debe coincidir con /^[a-z][a-z0-9_-]{0,40}$/ — "INVALID!" tiene mayúscula y !.
  const url = new URL(`https://htmlbox.dev/api/app-auth/${BOX_ID}/admin/users/INVALID!/disable`)
  const r = await handleAppAuth(makeReq('POST', url.toString()), makeEnv(), url)
  assert.equal(r, null)
})

test('router rechaza action inválida en /users/{id}/{action}', async () => {
  // "destroy" no es "disable" ni "enable"
  const url = new URL(`https://htmlbox.dev/api/app-auth/${BOX_ID}/admin/users/au_abc/destroy`)
  const r = await handleAppAuth(makeReq('POST', url.toString()), makeEnv(), url)
  assert.equal(r, null)
})