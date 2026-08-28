// __tests__/magicLinkUrl.test.js — el detector de host del browser para el
// magic link URL.
//
// Lógica migrada de lib/email.js::sendMagicLinkEmail a lib/magic-link.js
// durante Fase 3. Reglas:
//   1. browserHost es localhost (XFH/Origin/Referer) → usar localhost.
//   2. isDev (portal OR reqUrl contiene localhost) && browserHost → usar browser.
//   3. isDev && !browserHost → fallback a reqUrl.host.
//   4. !isDev (prod) → usar portalOrigin hardcodeado.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildMagicLinkUrl } from '../lib/magic-link.js'

function makeEnv(overrides = {}) {
  return {
    HTMLBOX_PORTAL_ORIGIN: 'http://portal.localhost:8782',
    HTMLBOX_PUBLIC_ORIGIN: 'http://controlplane.localhost:8781',
    HTMLBOX_EMAIL_MODE: 'dev',
    ...overrides,
  }
}

function makeRequest({ url, headers = {} } = {}) {
  return new Request(url || 'https://htmlbox-control-plane.sivocloud-latam.workers.dev/api/auth/request', { headers })
}

test('dev: con Referer, el magic link va al host del browser', () => {
  const env = makeEnv()
  const req = makeRequest({ headers: { Referer: 'http://controlplane.localhost:8781/admin/' } })
  const url = buildMagicLinkUrl(req, env, 'tok')
  assert.match(url, /^http:\/\/controlplane\.localhost:8781\/api\/auth\/verify\?token=tok$/)
})

test('dev: con Origin cross-origin, link al host del Origin', () => {
  const env = makeEnv()
  const req = makeRequest({ headers: { Origin: 'http://portal.localhost:8782' } })
  const url = buildMagicLinkUrl(req, env, 'tok')
  assert.match(url, /^http:\/\/portal\.localhost:8782\/api\/auth\/verify\?token=tok$/)
})

test('dev: X-Forwarded-Host CON scheme respeta el scheme del header', () => {
  const env = makeEnv()
  const req = makeRequest({ headers: { 'X-Forwarded-Host': 'http://controlplane.localhost:8781' } })
  const url = buildMagicLinkUrl(req, env, 'tok')
  assert.match(url, /^http:\/\/controlplane\.localhost:8781\/api\/auth\/verify\?token=tok$/)
})

test('dev: prioridad — XFH > Origin > Referer', () => {
  const env = makeEnv()
  const req = makeRequest({
    headers: {
      'X-Forwarded-Host': 'http://xfh-host.example:1234',
      'Origin': 'http://origin-host.example:5678',
      'Referer': 'http://referer-host.example/admin/',
    },
  })
  const url = buildMagicLinkUrl(req, env, 'tok')
  assert.match(url, /^http:\/\/xfh-host\.example:1234\/api\/auth\/verify\?token=tok$/)
})

test('dev: sin headers, fallback al Worker remoto (limitación documentada)', () => {
  const env = makeEnv()
  const req = makeRequest({ headers: {} })
  const url = buildMagicLinkUrl(req, env, 'tok')
  assert.match(url, /^https:\/\/htmlbox-control-plane\.sivocloud-latam\.workers\.dev\/api\/auth\/verify\?token=tok$/)
})

test('dev: Referer con URL relativa no crashea', () => {
  const env = makeEnv()
  const req = makeRequest({ headers: { Referer: '/relative/path' } })
  const url = buildMagicLinkUrl(req, env, 'tok')
  assert.ok(url)
})

test('prod: con HTMLBOX_PORTAL_ORIGIN=studio.sivocloud.dev → link al portal de prod', () => {
  const env = makeEnv({
    HTMLBOX_PORTAL_ORIGIN: 'https://studio.sivocloud.dev',
    HTMLBOX_PUBLIC_ORIGIN: 'https://controlplane.sivocloud.dev',
  })
  const req = makeRequest({ headers: { Referer: 'https://controlplane.sivocloud.dev/admin/' } })
  const url = buildMagicLinkUrl(req, env, 'tok')
  assert.equal(url, 'https://studio.sivocloud.dev/api/auth/verify?token=tok')
})

test('prod: origin="admin" → link al admin origin', () => {
  const env = makeEnv({
    HTMLBOX_PORTAL_ORIGIN: 'https://studio.sivocloud.dev',
    HTMLBOX_PUBLIC_ORIGIN: 'https://controlplane.sivocloud.dev',
  })
  const req = makeRequest({ headers: {} })
  const url = buildMagicLinkUrl(req, env, 'tok', { origin: 'admin' })
  assert.equal(url, 'https://controlplane.sivocloud.dev/api/auth/verify?token=tok')
})

test('prod: XFH atacante NO se usa (defensa contra XFH injection)', () => {
  const env = makeEnv({
    HTMLBOX_PORTAL_ORIGIN: 'https://studio.sivocloud.dev',
    HTMLBOX_PUBLIC_ORIGIN: 'https://controlplane.sivocloud.dev',
  })
  const req = makeRequest({ headers: { 'X-Forwarded-Host': 'http://attacker.com' } })
  const url = buildMagicLinkUrl(req, env, 'tok')
  assert.equal(url, 'https://studio.sivocloud.dev/api/auth/verify?token=tok')
})

test('Fix 2: browserHost localhost gana sobre portalOrigin prod', () => {
  const env = makeEnv({
    HTMLBOX_PORTAL_ORIGIN: 'https://studio.sivocloud.dev',
    HTMLBOX_PUBLIC_ORIGIN: 'https://controlplane.sivocloud.dev',
  })
  const req = makeRequest({ headers: { Origin: 'http://studio.localhost:8782' } })
  const url = buildMagicLinkUrl(req, env, 'tok')
  assert.equal(url, 'http://studio.localhost:8782/api/auth/verify?token=tok')
})
