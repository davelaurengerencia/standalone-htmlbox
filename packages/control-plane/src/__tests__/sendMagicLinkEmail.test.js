// __tests__/sendMagicLinkEmail.test.js — el bug del magic link del admin.
//
// Síntoma original (en dev): el user entraba a /admin/, pedía magic link,
// clickeaba el link, el control-plane lo autenticaba correctamente, pero al
// volver a /admin/ el modal de login reaparecía (cookie no se veía en
// /api/auth/me).
//
// Causa raíz: en dev el control-plane corre con --remote (D1 está en
// Cloudflare), así que el código corre en el Worker remoto
// 'htmlbox-control-plane.sivocloud-latam.workers.dev'. El magic link del
// email apuntaba a ese host — el browser al hacer click abría prod-like,
// no dev. Encima, el loginConfirmHtml hacía auto-POST a '/api/auth/consume'
// que en el browser resolvía al dev proxy 'controlplane.localhost:8781', y
// la Set-Cookie del control-plane remoto (con Domain='.sivocloud.dev') no
// coincidía con el host del browser (no se compartía cross-subdomain
// entre el apex de workers.dev y *.localhost).
//
// Fix: en dev, el magic link del email apunta al host del BROWSER (no al
// Worker remoto). El host del browser se obtiene de X-Forwarded-Host /
// Origin / Referer (en orden de prioridad). Si ninguno viene, fallback al
// Worker remoto (que en dev requiere editar el link manualmente — feo pero
// funcional).
//
// Estos tests cubren el path de detección del host del browser en dev.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sendMagicLinkEmail } from '../lib/email.js'

// ============ helpers ============

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

function getPreviewLink(result) {
  return result?.previewLink
}

// ============ DEV: detectar el host del browser ============

test('dev: con Referer, el magic link va al host del browser (HTTP, no al Worker)', async () => {
  const env = makeEnv()
  const req = makeRequest({
    headers: { Referer: 'http://controlplane.localhost:8781/admin/' },
  })
  const out = await sendMagicLinkEmail(env, req, { toEmail: 'a@x.com', tokenId: 'tok' })
  assert.match(getPreviewLink(out), /^http:\/\/controlplane\.localhost:8781\/api\/auth\/verify\?token=tok$/)
})

test('dev: con Origin (caso cross-origin), el magic link va al host del Origin', async () => {
  const env = makeEnv()
  const req = makeRequest({
    headers: { Origin: 'http://portal.localhost:8782' },
  })
  const out = await sendMagicLinkEmail(env, req, { toEmail: 'a@x.com', tokenId: 'tok' })
  assert.match(getPreviewLink(out), /^http:\/\/portal\.localhost:8782\/api\/auth\/verify\?token=tok$/)
})

test('dev: con X-Forwarded-Host (sin scheme), el link usa http del request', async () => {
  const env = makeEnv()
  const req = makeRequest({
    headers: { 'X-Forwarded-Host': 'controlplane.localhost:8781' },
  })
  const out = await sendMagicLinkEmail(env, req, { toEmail: 'a@x.com', tokenId: 'tok' })
  assert.match(getPreviewLink(out), /^https:\/\/controlplane\.localhost:8781\/api\/auth\/verify\?token=tok$/)
  // Usa https (protocol del Worker) — porque X-Forwarded-Host no trae scheme
  // y caemos al fallback reqUrl.protocol. En la práctica, este caso no se da
  // en dev (X-Forwarded-Host no se inyecta) pero documentado.
})

test('dev: con X-Forwarded-Host CON scheme, el link respeta el scheme del header', async () => {
  const env = makeEnv()
  const req = makeRequest({
    headers: { 'X-Forwarded-Host': 'http://controlplane.localhost:8781' },
  })
  const out = await sendMagicLinkEmail(env, req, { toEmail: 'a@x.com', tokenId: 'tok' })
  assert.match(getPreviewLink(out), /^http:\/\/controlplane\.localhost:8781\/api\/auth\/verify\?token=tok$/)
})

test('dev: prioridad — XFH > Origin > Referer', async () => {
  const env = makeEnv()
  const req = makeRequest({
    headers: {
      'X-Forwarded-Host': 'http://xfh-host.example:1234',
      'Origin': 'http://origin-host.example:5678',
      'Referer': 'http://referer-host.example/admin/',
    },
  })
  const out = await sendMagicLinkEmail(env, req, { toEmail: 'a@x.com', tokenId: 'tok' })
  // XFH gana.
  assert.match(getPreviewLink(out), /^http:\/\/xfh-host\.example:1234\/api\/auth\/verify\?token=tok$/)
})

test('dev: sin headers, fallback al Worker remoto (el user edita el link manualmente)', async () => {
  const env = makeEnv()
  const req = makeRequest({ headers: {} })
  const out = await sendMagicLinkEmail(env, req, { toEmail: 'a@x.com', tokenId: 'tok' })
  // El Worker remoto está en workers.dev. Devuelve el link al Worker.
  assert.match(getPreviewLink(out), /^https:\/\/htmlbox-control-plane\.sivocloud-latam\.workers\.dev\/api\/auth\/verify\?token=tok$/)
})

test('dev: Referer con URL relativa no crashea', async () => {
  const env = makeEnv()
  const req = makeRequest({
    headers: { Referer: '/relative/path' },  // ← sin scheme
  })
  const out = await sendMagicLinkEmail(env, req, { toEmail: 'a@x.com', tokenId: 'tok' })
  // new URL() tira — el catch evita el crash. Cae al fallback.
  assert.ok(getPreviewLink(out))
})

// ============ PROD: siempre va al portal ============

test('prod: con HTMLBOX_PORTAL_ORIGIN=studio.sivocloud.dev, link va al portal de prod', async () => {
  const env = makeEnv({
    HTMLBOX_PORTAL_ORIGIN: 'https://studio.sivocloud.dev',
    HTMLBOX_PUBLIC_ORIGIN: 'https://controlplane.sivocloud.dev',
  })
  const req = makeRequest({
    headers: { Referer: 'https://controlplane.sivocloud.dev/admin/' },
  })
  const out = await sendMagicLinkEmail(env, req, { toEmail: 'a@x.com', tokenId: 'tok' })
  // En prod va al PORTAL (cross-subdomain con Domain=.sivocloud.dev).
  assert.equal(getPreviewLink(out), 'https://studio.sivocloud.dev/api/auth/verify?token=tok')
})

test('prod: el host del browser NO se usa aunque venga en headers', async () => {
  // En prod, portal y controlplane son subdomains de sivocloud.dev con
  // Domain=.sivocloud.dev. Cualquier host distinto del portal sería un
  // problema de routing (cookie domain mismatch). Por eso prod ignora
  // los headers del browser y siempre va al portal.
  const env = makeEnv({
    HTMLBOX_PORTAL_ORIGIN: 'https://studio.sivocloud.dev',
    HTMLBOX_PUBLIC_ORIGIN: 'https://controlplane.sivocloud.dev',
  })
  const req = makeRequest({
    headers: { 'X-Forwarded-Host': 'http://attacker.com' },
  })
  const out = await sendMagicLinkEmail(env, req, { toEmail: 'a@x.com', tokenId: 'tok' })
  assert.equal(getPreviewLink(out), 'https://studio.sivocloud.dev/api/auth/verify?token=tok')
})

// ============ defaults sin HTMLBOX_PORTAL_ORIGIN (fallback al request.url) ============

test('dev sin HTMLBOX_PORTAL_ORIGIN: fallback al control-plane remoto + headers del browser', async () => {
  // Sin la var, caemos a reqUrl como portalOrigin. Igual detecta isDev=false
  // (porque no tiene 'localhost') → fallback al Worker remoto. Esto es
  // defensivo — en prod siempre hay HTMLBOX_PORTAL_ORIGIN.
  const env = makeEnv({ HTMLBOX_PORTAL_ORIGIN: undefined })
  const req = makeRequest({
    headers: { Referer: 'http://controlplane.localhost:8781/admin/' },
  })
  const out = await sendMagicLinkEmail(env, req, { toEmail: 'a@x.com', tokenId: 'tok' })
  // Sin HTMLBOX_PORTAL_ORIGIN no detectamos dev → fallback al Worker.
  assert.match(getPreviewLink(out), /^https:\/\/htmlbox-control-plane\.sivocloud-latam\.workers\.dev/)
})