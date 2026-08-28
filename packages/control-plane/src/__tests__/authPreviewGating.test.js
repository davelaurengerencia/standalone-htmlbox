// __tests__/authPreviewGating.test.js — regression guard para el leak de
// `_dev_preview` que existía en prod-fallback.
//
// Bug original: cuando el envío de email fallaba en prod (modo `prod-fallback`
// mientras se terminan los DNS records del dominio), `postRequest` devolvía el
// `_dev_preview` con el magic link en la respuesta JSON. Un atacante podía
// hacer POST /api/auth/request con cualquier email y obtener el link de login
// de ese usuario — bypass de auth completo.
//
// Fix: gatear `includePreview` con `env.HTMLBOX_ENV !== 'production'`. En dev
// (HTMLBOX_ENV=development | 'dev' | undefined) el preview sigue funcionando
// para el ciclo de feedback. En prod nunca se expone.
//
// Tests cubren:
//   1. prod + email result con previewLink → respuesta SIN _dev_preview
//   2. development + email result con previewLink → respuesta CON _dev_preview
//   3. dev (HTMLBOX_ENV='dev') + previewLink → respuesta CON _dev_preview
//   4. prod + email result SIN previewLink → respuesta SIN _dev_preview (igual)
//   5. undefined HTMLBOX_ENV + previewLink → respuesta CON _dev_preview
//      (default dev-friendly para tests que no setean el var)
//   6. Mismo set para la ruta interna /api/internal/tenant-app-auth/request
//      (postTenantAppRequest en routes/internal.js — mismo bug, mismo fix).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
// here = packages/control-plane/src/__tests__/
// Importamos los handlers de los routes directamente. Como los tests previos
// hacen (authFirstUser.test.js / authFromRouting.test.js), podemos mockear
// env.DB con un wrapper que registra los SQLs — pero acá solo queremos
// verificar el shape del response, no la interacción con D1. Para eso
// alcanza con invocar el handler con env.DB stub que devuelve siempre
// `null` (no rate-limited, no existing magic link).

// ============ mocks compartidos ============

// Stub de D1: count() = 0 (no rate-limited), SELECT id/exists = null
// (no previous magic link), INSERT = success. Suficiente para llegar al
// `emailResult && includePreview`.
function makeStubDB() {
  return {
    prepare(sql) {
      const stmt = {
        bind() { return stmt },
        async first() {
          // count(*) para rate limit → 0
          // SELECT id/email/origin para peek → null (no link previo)
          if (/count\(\*\)/i.test(sql)) return { n: 0 }
          if (/exists/i.test(sql)) return null
          if (/SELECT/.test(sql)) return null
          return null
        },
        async run() {
          return { meta: { changes: 1 } }
        },
        async all() {
          return { results: [] }
        },
      }
      return stmt
    },
  }
}

function makeEnv({ env: envOverrides = {}, htmlbox_env } = {}) {
  const db = makeStubDB()
  return {
    HTMLBOX_ENV: htmlbox_env,
    DB: db,
    ...envOverrides,
  }
}

// Stub de MAIL.send para simular modo prod-fallback (sin binding).
function makeEnvWithoutMAIL(htmlbox_env) {
  return { ...makeEnv({ htmlbox_env }), MAIL: undefined }
}

// ============ auth.js / postRequest ============
// Cargamos el handler directamente. Como `auth.js` exporta `handleAuth`,
// podemos invocarlo con `(request, env, ctx, path)` igual que hace el router.

const authModule = await import('../routes/auth.js')

function makeRequest(body) {
  return new Request('http://localhost/api/auth/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function callPostRequest(env, email) {
  const req = makeRequest({ email })
  // handleAuth usa path para rutear. Pasamos path explícito.
  return await authModule.handleAuth(req, env, {}, '/api/auth/request')
}

// ============ tests ============

test('postRequest — prod + previewLink disponible → NO expone _dev_preview (fix leak)', async () => {
  // En prod, si MAIL.send no está binded, email.js cae a prod-fallback
  // y entrega { previewLink: magicLink, mode: 'prod-fallback' }. Antes ese
  // previewLink se exponía en la respuesta — bypass de auth. Con el gate
  // HTMLBOX_ENV==='production', la respuesta es GENERIC (sin preview).
  const env = {
    ...makeEnv({ htmlbox_env: 'production' }),
    HTMLBOX_EMAIL_MODE: 'prod',
    MAIL: undefined,
  }
  const res = await callPostRequest(env, 'attacker-target@example.com')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body._dev_preview, undefined,
    'prod NO debe filtrar magic link en la respuesta aunque email.send falle')
  // _email_mode tampoco se expone (es metadata de dev). El response es
  // literal GENERIC_RESPONSE = { ok, message }, sin campos de dev.
  assert.equal(body._email_mode, undefined,
    'prod tampoco expone _email_mode — respuesta = GENERIC_RESPONSE completa')
  assert.equal(body.ok, true)
  assert.equal(body.message, 'Si el email está registrado, recibirás un link.')
})

test('postRequest — development + previewLink disponible → expone _dev_preview', async () => {
  const env = {
    ...makeEnv({ htmlbox_env: 'development' }),
    HTMLBOX_EMAIL_MODE: 'dev',
  }
  const res = await callPostRequest(env, 'dev-user@example.com')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.ok(body._dev_preview, 'dev sí expone _dev_preview')
  assert.match(body._dev_preview, /\/api\/auth\/verify\?token=/)
  assert.equal(body._email_mode, 'dev')
})

test('postRequest — HTMLBOX_ENV="dev" + previewLink → expone _dev_preview', async () => {
  const env = {
    ...makeEnv({ htmlbox_env: 'dev' }),
    HTMLBOX_EMAIL_MODE: 'dev',
  }
  const res = await callPostRequest(env, 'dev-user@example.com')
  const body = await res.json()
  assert.ok(body._dev_preview, 'HTMLBOX_ENV="dev" también es dev-friendly')
})

test('postRequest — prod + sin previewLink → respuesta sigue sin _dev_preview (no regresión)', async () => {
  // Si algún día prod puede enviar mail correctamente, previewLink sería
  // null/undefined y nunca debería aparecer. Verificamos que el branch
  // `!includePreview` sigue funcionando.
  const env = {
    ...makeEnv({ htmlbox_env: 'production' }),
    HTMLBOX_EMAIL_MODE: 'prod',
    MAIL: { send: async () => ({}) },  // envía OK → previewLink undefined
  }
  const res = await callPostRequest(env, 'prod-user@example.com')
  const body = await res.json()
  assert.equal(body._dev_preview, undefined)
  assert.equal(body.ok, true)
})

test('postRequest — HTMLBOX_ENV undefined + previewLink → expone _dev_preview (default dev-friendly)', async () => {
  // Sin la var (caso tests viejos o wrangler config sin el var) → default
  // es dev-friendly: muestra preview. Esto preserva el comportamiento
  // previo para tests existentes.
  const env = {
    ...makeEnv({ htmlbox_env: undefined }),
    HTMLBOX_EMAIL_MODE: 'dev',
  }
  const res = await callPostRequest(env, 'test-user@example.com')
  const body = await res.json()
  assert.ok(body._dev_preview, 'sin HTMLBOX_ENV → default dev-friendly')
})

// ============ internal.js / postTenantAppRequest ============
// Misma lógica. Cargamos el módulo y construimos el req manualmente.

const internalModule = await import('../routes/internal.js')

function makeTenantAppRequest(body, internalSecret) {
  return new Request('http://localhost/api/internal/tenant-app-auth/request', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-HTMLBox-Internal-Secret': internalSecret || 'test-secret',
    },
    body: JSON.stringify(body),
  })
}

async function callPostTenantAppRequest(env, body) {
  const req = makeTenantAppRequest(body)
  return await internalModule.handleInternal(req, env, {}, '/api/internal/tenant-app-auth/request', 'POST')
}

// Stub env con HTMLBOX_INTERNAL_SECRET + tenant + app-user lookups
function makeInternalEnv({ htmlbox_env, appUserExists = true, tenantExists = true }) {
  const db = {
    prepare(sql) {
      const stmt = {
        bind() { return stmt },
        async first() {
          if (/count\(\*\)/i.test(sql)) return { n: 0 }
          if (/htmlbox_tenant_app_users/i.test(sql)) {
            return appUserExists
              ? { id: 'user_test', email: 'appuser@example.com', disabled_at: null }
              : null
          }
          if (/htmlbox_tenants/i.test(sql)) {
            return tenantExists ? { name: 'Test Tenant' } : null
          }
          return null
        },
        async run() { return { meta: { changes: 1 } } },
        async all() { return { results: [] } },
      }
      return stmt
    },
  }
  return {
    HTMLBOX_ENV: htmlbox_env,
    DB: db,
    HTMLBOX_INTERNAL_SECRET: 'test-secret',
    MAIL: undefined,  // sin MAIL → email.js cae a prod-fallback con previewLink
  }
}

test('postTenantAppRequest — prod + previewLink → NO expone _dev_preview', async () => {
  const env = makeInternalEnv({ htmlbox_env: 'production' })
  const res = await callPostTenantAppRequest(env, {
    tenantId: 'tenant_test',
    email: 'appuser@example.com',
    magicLinkBase: 'http://localhost/t/tenant/',
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body._dev_preview, undefined,
    'app-user: prod-fallback NO debe filtrar magic link')
  assert.equal(body.ok, true)
})

test('postTenantAppRequest — development + previewLink → expone _dev_preview', async () => {
  const env = makeInternalEnv({ htmlbox_env: 'development' })
  const res = await callPostTenantAppRequest(env, {
    tenantId: 'tenant_test',
    email: 'appuser@example.com',
    magicLinkBase: 'http://localhost/t/tenant/',
  })
  const body = await res.json()
  assert.ok(body._dev_preview, 'app-user dev sí expone _dev_preview')
})

// ============ static guard: nadie reverte el gate ============

test('auth.js y internal.js siguen gateando con env.HTMLBOX_ENV (regression)', async () => {
  const authSrc = await fs.readFile(
    path.resolve(here, '..', 'routes', 'auth.js'),
    'utf8'
  )
  const internalSrc = await fs.readFile(
    path.resolve(here, '..', 'routes', 'internal.js'),
    'utf8'
  )
  // El gate debe estar presente en ambas rutas. Si alguien lo borra, este
  // test atrapa el cambio.
  assert.match(authSrc, /env\.HTMLBOX_ENV\s*===\s*['"]production['"]/,
    'auth.js debe gatear _dev_preview con HTMLBOX_ENV === "production"')
  assert.match(internalSrc, /env\.HTMLBOX_ENV\s*===\s*['"]production['"]/,
    'internal.js debe gatear _dev_preview con HTMLBOX_ENV === "production"')
})