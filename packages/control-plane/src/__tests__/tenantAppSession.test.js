// __tests__/tenantAppSession.test.js — funciones puras de session.js (fase 3).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTenantAppSessionCookie,
  buildTenantAppClearCookie,
  getTenantAppSessionIdFromRequest,
  checkTenantAppAccess,
  TENANT_APP_SESSION_COOKIE_NAME,
} from '../lib/session.js'

test('TENANT_APP_SESSION_COOKIE_NAME es "hbx_tapp_sid"', () => {
  assert.equal(TENANT_APP_SESSION_COOKIE_NAME, 'hbx_tapp_sid')
})

test('buildTenantAppSessionCookie usa Path=/ (no scope por box)', () => {
  const req = { url: 'http://acme.localhost:8782/mybox', headers: { get: () => null } }
  const env = { HTMLBOX_SESSION_DOMAIN: '' }  // host-only en dev
  const c = buildTenantAppSessionCookie(req, 'abc', env)
  assert.match(c, /^hbx_tapp_sid=abc/)
  assert.match(c, /Path=\//)
  assert.match(c, /HttpOnly/)
  assert.match(c, /SameSite=Lax/)
  assert.match(c, /Max-Age=/)
  // Sin Domain en dev (localhost)
  assert.doesNotMatch(c, /Domain=/)
})

test('buildTenantAppSessionCookie agrega Domain en prod', () => {
  const req = { url: 'https://acme.sivocloud.dev/mybox', headers: { get: () => null } }
  const env = { HTMLBOX_SESSION_DOMAIN: '.sivocloud.dev' }
  const c = buildTenantAppSessionCookie(req, 'abc', env)
  assert.match(c, /Domain=\.sivocloud\.dev/)
})

test('buildTenantAppSessionCookie agrega Secure cuando secure=true', () => {
  const req = { url: 'https://acme.sivocloud.dev/mybox', headers: { get: () => null } }
  const env = { HTMLBOX_SESSION_DOMAIN: '.sivocloud.dev' }
  const c = buildTenantAppSessionCookie(req, 'abc', env)
  assert.match(c, /Secure/)
})

test('buildTenantAppSessionCookie NO usa Secure en localhost', () => {
  const req = { url: 'http://portal.localhost:8782/x', headers: { get: () => null } }
  const env = { HTMLBOX_SESSION_DOMAIN: '' }
  const c = buildTenantAppSessionCookie(req, 'abc', env)
  assert.doesNotMatch(c, /Secure/)
})

test('buildTenantAppClearCookie tiene Max-Age=0', () => {
  const req = { url: 'http://acme.localhost:8782/mybox', headers: { get: () => null } }
  const env = { HTMLBOX_SESSION_DOMAIN: '' }
  const c = buildTenantAppClearCookie(req, env)
  assert.match(c, /Max-Age=0/)
  assert.match(c, /Path=\//)
  assert.match(c, /HttpOnly/)
})

test('getTenantAppSessionIdFromRequest extrae el session id', () => {
  const req = { headers: { get: (k) => k.toLowerCase() === 'cookie' ? 'hbx_tapp_sid=zzz; sid=other; hbx_app_sid=app' : null } }
  assert.equal(getTenantAppSessionIdFromRequest(req), 'zzz')
})

test('getTenantAppSessionIdFromRequest devuelve null si no hay cookie', () => {
  const req = { headers: { get: () => null } }
  assert.equal(getTenantAppSessionIdFromRequest(req), null)
})

test('getTenantAppSessionIdFromRequest ignora otras cookies', () => {
  const req = { headers: { get: (k) => k.toLowerCase() === 'cookie' ? 'sid=plat; hbx_app_sid=app' : null } }
  assert.equal(getTenantAppSessionIdFromRequest(req), null)
})
// ─── Anexo de Seguridad hallazgo 3: defensa en profundidad en checkTenantAppAccess ─

// Mock minimal de un D1 bind (env.DB.prepare().bind().first()) que devuelve
// filas pre-armadas. Solo soporta la primera query de checkTenantAppAccess.
function mockD1Returning(rows) {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => rows,
          all: async () => ({ results: Array.isArray(rows) ? rows : [rows] }),
          run: async () => ({ success: true, meta: { changes: 1 } }),
        }),
        all: async () => ({ results: Array.isArray(rows) ? rows : [rows] }),
        first: async () => rows,
        run: async () => ({ success: true, meta: { changes: 1 } }),
      }),
    },
  }
}

test('anexo H3 — checkTenantAppAccess devuelve allowed cuando scope=tenant coincide con tenant del box', async () => {
  const env = mockD1Returning({ role: 'full' })
  const r = await checkTenantAppAccess(
    env, 'tu_1',
    { id: 'box1', tenant_id: 't1', workspace_id: 'ws1' },
  )
  assert.deepEqual(r, { allowed: true, role: 'full' })
})

test('anexo H3 — checkTenantAppAccess devuelve allowed con scope=box', async () => {
  const env = mockD1Returning({ role: 'read' })
  const r = await checkTenantAppAccess(
    env, 'tu_1',
    { id: 'box1', tenant_id: 't1', workspace_id: 'ws1' },
  )
  assert.deepEqual(r, { allowed: true, role: 'read' })
})

test('anexo H3 — checkTenantAppAccess deniega cuando hay cross-tenant (defense in depth)', async () => {
  // El mock NO devuelve ninguna fila — eso simula el caso donde un
  // tenant_app_user de OTRO tenant tiene una fila con scope_type='tenant'
  // apuntando a OTRO tenant distinto del box. Antes del fix, este caso
  // tenía que ser filtrado por el caller. Ahora el JOIN adentro de la
  // función lo filtra solo — la query no devuelve filas y la función
  // devuelve allowed=false.
  const env = mockD1Returning(null)
  const r = await checkTenantAppAccess(
    env, 'tu_from_other_tenant',
    { id: 'box1', tenant_id: 't1', workspace_id: 'ws1' },
  )
  assert.deepEqual(r, { allowed: false })
})

test('anexo H3 — el filtro u.tenant_id=$box.tenant_id se aplica en la query (unit)', async () => {
  // Verifica el SQL generado por checkTenantAppAccess — debe incluir la
  // cláusula de defensa en profundidad `AND u.tenant_id = ?4`. Si el query
  // cambia sin actualizar este test, alguien está intentando remover la
  // defensa.
  let capturedSql = null
  let capturedArgs = null
  const env = {
    DB: {
      prepare(sql) {
        capturedSql = sql
        return {
          bind: (...args) => {
            capturedArgs = args
            return { first: async () => null }
          },
        }
      },
    },
  }
  await checkTenantAppAccess(env, 'tu_1', { id: 'box1', tenant_id: 't1', workspace_id: 'ws1' })
  assert.match(capturedSql, /JOIN\s+htmlbox_tenant_app_users/, 'debe hacer JOIN contra la tabla de users')
  assert.match(capturedSql, /u\.tenant_id\s*=\s*\?4/, 'debe filtrar u.tenant_id = ?4 (defense in depth)')
  assert.equal(capturedArgs[3], 't1', 'el 4to bind es box.tenant_id')
})
