// __tests__/tenantAppUsersRoleCheck.test.js
//
// Anexo de Seguridad hallazgo 1 — el admin de usuarios centralizados no
// chequeaba rol. Estos tests verifican que:
//
//   - Sin sesión → 401 unauthenticated
//   - platform_owner → NO corta en 403 (rol implícito)
//   - User con membership 'owner' en workspace del tenant → NO corta
//   - User con membership 'editor' en workspace del tenant → NO corta
//   - User con membership 'viewer' solamente → 403 forbidden
//   - User sin membership en este tenant → 403 forbidden
//   - User de OTRO tenant (no platform_owner) → 403 forbidden
//
// Se usa GET /api/tenant-app-users porque corre el mismo path de auth (sin
// tocar body) y llega a listTenantAppUsers, que es seguro de testear.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleTenantAppUsers } from '../routes/tenantAppUsers.js'

// Mock único de D1 — maneja validateSession (JOIN sessions+users),
// resolveTenantForUser (SELECT tenants), y assertUserCanAdministerTenant
// (SELECT MAX(role) FROM memberships JOIN workspaces).
function d1Mock({ user, roleRank = 0, tenants = ['t1'] } = {}) {
  // Cloudflare D1: stmt.bind(...args).first()/.all()/.run() OR
  // stmt.first()/.all()/.run() cuando no hay args. El mock soporta ambos.
  return {
    DB: {
      prepare(sql) {
        const normalized = sql.replace(/\s+/g, ' ').trim()
        const builder = (args = []) => ({
          async first() {
            // validateSession: JOIN de sessions + users
            if (normalized.includes('FROM htmlbox_sessions') && normalized.includes('JOIN htmlbox_users')) {
              if (user && args[0] === 'sid_test') {
                return {
                  sid: args[0], expires_at: '2099-01-01 00:00:00',
                  user_id: user.id, email: user.email || `${user.id}@x`,
                  display_name: null,
                  tenant_id: user.tenant_id,
                  is_platform_owner: user.is_platform_owner ? 1 : 0,
                }
              }
              return null
            }
            // resolveTenantForUser (con ?tenant_id explícito)
            if (normalized.startsWith('SELECT id FROM htmlbox_tenants WHERE id = ?')) {
              return tenants.includes(args[0]) ? { id: args[0] } : null
            }
            // resolveTenantForUser (sin ?tenant_id, fallback primer tenant) — sin args
            if (normalized.startsWith('SELECT id FROM htmlbox_tenants ORDER BY created_at')) {
              return tenants[0] ? { id: tenants[0] } : null
            }
            // assertUserCanAdministerTenant (MAX de role)
            if (normalized.includes('htmlbox_memberships')) {
              return roleRank ? { role_rank: roleRank } : { role_rank: null }
            }
            return null
          },
          async all() { return { results: [] } },
          async run() { return { success: true, meta: { changes: 1 } } },
        })
        return {
          bind(...args) { return builder(args) },
          ...builder(),  // también soporta stmt.first() directo (sin args)
        }
      },
    },
  }
}

function makeReq({ method, path, cookie = 'sid=sid_test' } = {}) {
  return {
    method,
    url: `https://studio.sivocloud.dev${path}`,
    headers: {
      get: (k) => {
        if (k.toLowerCase() === 'cookie') return cookie
        return null
      },
    },
    json: async () => ({}),
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────

test('anexo H1 — sin cookie de sesión → 401', async () => {
  const env = d1Mock({ user: { id: 'u1', tenant_id: 't1', is_platform_owner: false }, tenants: ['t1'] })
  const req = makeReq({ cookie: '' })
  const r = await handleTenantAppUsers(req, env, null, '/api/tenant-app-users', 'GET')
  assert.equal(r.status, 401)
})

test('anexo H1 — platform_owner (implícito owner) → NO 403 (puede llegar a la lista)', async () => {
  const env = d1Mock({
    user: { id: 'u_platform', tenant_id: null, is_platform_owner: true },
    tenants: ['t1'],
  })
  const req = makeReq({ method: 'GET', path: '/api/tenant-app-users' })
  const r = await handleTenantAppUsers(req, env, null, '/api/tenant-app-users', 'GET')
  // listTenantAppUsers corre y trata de listar (devuelve { users: [] } en
  // mock sin filas — eso es 200 OK). Lo que nos importa: NO cortó en 403.
  assert.notEqual(r.status, 403, `platform_owner no debe recibir 403; recibió ${r.status}`)
})

test('anexo H1 — user con membership owner (rank=3) → NO corta en 403 forbidden', async () => {
  const env = d1Mock({
    user: { id: 'u1', tenant_id: 't1', is_platform_owner: false },
    roleRank: 3, tenants: ['t1'],
  })
  const req = makeReq({ method: 'GET', path: '/api/tenant-app-users' })
  const r = await handleTenantAppUsers(req, env, null, '/api/tenant-app-users', 'GET')
  assert.notEqual(r.status, 403, `owner rank=3 debe pasar el role check; recibió ${r.status}`)
})

test('anexo H1 — user con membership editor (rank=2) → NO corta en 403 forbidden', async () => {
  const env = d1Mock({
    user: { id: 'u1', tenant_id: 't1', is_platform_owner: false },
    roleRank: 2, tenants: ['t1'],
  })
  const req = makeReq({ method: 'GET', path: '/api/tenant-app-users' })
  const r = await handleTenantAppUsers(req, env, null, '/api/tenant-app-users', 'GET')
  assert.notEqual(r.status, 403, `editor rank=2 debe pasar el role check; recibió ${r.status}`)
})

test('anexo H1 — user con membership viewer (rank=1) SOLAMENTE → 403 forbidden', async () => {
  const env = d1Mock({
    user: { id: 'u_viewer', tenant_id: 't1', is_platform_owner: false },
    roleRank: 1, tenants: ['t1'],
  })
  const req = makeReq({ method: 'GET', path: '/api/tenant-app-users' })
  const r = await handleTenantAppUsers(req, env, null, '/api/tenant-app-users', 'GET')
  assert.equal(r.status, 403, `viewer debe recibir 403; recibió ${r.status}`)
  const body = await r.json()
  assert.equal(body.error, 'forbidden')
})

test('anexo H1 — user sin membership en este tenant (rank=0) → 403 forbidden', async () => {
  const env = d1Mock({
    user: { id: 'u_other', tenant_id: 't1', is_platform_owner: false },
    roleRank: 0, tenants: ['t1'],
  })
  const req = makeReq({ method: 'GET', path: '/api/tenant-app-users' })
  const r = await handleTenantAppUsers(req, env, null, '/api/tenant-app-users', 'GET')
  assert.equal(r.status, 403, `usuario sin membership debe recibir 403; recibió ${r.status}`)
})

test('anexo H1 — user de tenant sin memberships en su propio tenant → 403 forbidden', async () => {
  // user pertenece a 't_other', roleRank=0 → no tiene rol owner/editor en
  // ningún workspace de 't_other' (el que resolveTenantForUser le asigna
  // implícitamente). Debe cortar en 403.
  const env = d1Mock({
    user: { id: 'u_orphanish', tenant_id: 't_other', is_platform_owner: false },
    roleRank: 0, tenants: ['t_other'],
  })
  const req = makeReq({ method: 'GET', path: '/api/tenant-app-users' })
  const r = await handleTenantAppUsers(req, env, null, '/api/tenant-app-users', 'GET')
  assert.equal(r.status, 403, `usuario sin membership debe recibir 403; recibió ${r.status}`)
})

test('anexo H1 — user con tenant_id=null (recién creado) → 400 user_has_no_tenant', async () => {
  // Un user sin tenant no puede operar sobre /api/tenant-app-users. El
  // helper resolveTenantForUser detecta la falta de tenant y devuelve 400
  // ANTES de tocar el rol (que en este caso es ortogonal).
  const env = d1Mock({
    user: { id: 'u_orphan', tenant_id: null, is_platform_owner: false },
    roleRank: 0, tenants: ['t1'],
  })
  const req = makeReq({ method: 'GET', path: '/api/tenant-app-users' })
  const r = await handleTenantAppUsers(req, env, null, '/api/tenant-app-users', 'GET')
  assert.equal(r.status, 400, `user sin tenant debe recibir 400; recibió ${r.status}`)
  const body = await r.json()
  assert.equal(body.error, 'user_has_no_tenant')
})

test('anexo H1 — platform_owner con ?tenant_id inválido → 404 tenant_not_found', async () => {
  // El platform_owner PUEDE especificar ?tenant_id. Si el id no existe,
  // es 404 (no 403): le estamos diciendo "ese tenant no existe", no
  // "no tenés permiso". Esto es coherente con que platform_owner tiene
  // acceso a todos los tenants.
  const env = d1Mock({
    user: { id: 'u_platform', tenant_id: null, is_platform_owner: true },
    tenants: ['t1'],  // 't_ghost' no existe
  })
  const req = {
    method: 'GET',
    url: 'https://studio.sivocloud.dev/api/tenant-app-users?tenant_id=t_ghost',
    headers: { get: (k) => k.toLowerCase() === 'cookie' ? 'sid=sid_test' : null },
    json: async () => ({}),
  }
  const r = await handleTenantAppUsers(req, env, null, '/api/tenant-app-users', 'GET')
  assert.equal(r.status, 404)
})

test('anexo H1 — grantAccess con viewer → 403, no llega al INSERT', async () => {
  const env = d1Mock({
    user: { id: 'u_viewer', tenant_id: 't1', is_platform_owner: false },
    roleRank: 1, tenants: ['t1'],
  })
  let insertCalled = false
  const origPrepare = env.DB.prepare
  env.DB.prepare = (sql) => {
    if (/INSERT INTO htmlbox_tenant_app_access/.test(sql)) insertCalled = true
    return origPrepare(sql)
  }
  const req = makeReq({ method: 'POST', path: '/api/tenant-app-users/tu_1/access' })
  req.json = async () => ({ scope_type: 'tenant' })
  const r = await handleTenantAppUsers(req, env, null, '/api/tenant-app-users/tu_1/access', 'POST')
  assert.equal(r.status, 403)
  assert.equal(insertCalled, false, 'NO debe llegar al INSERT — corta antes')
})
