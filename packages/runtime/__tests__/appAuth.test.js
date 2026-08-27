// __tests__/appAuth.test.js — funciones puras de appAuth.js (sin DB).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  APP_SESSION_COOKIE,
  APP_SESSION_TTL_SECONDS,
  APP_MAGIC_LINK_TTL_MS,
  randomToken,
  buildAppSessionCookie,
  buildAppClearCookie,
  getAppSessionIdFromRequest,
  shouldUseSecureCookie,
  cookiePathForBox,
  verifyConfirmHtml,
  verifyErrorHtml,
} from '../src/lib/appAuth.js'

test('APP_SESSION_COOKIE es "hbx_app_sid" (distinto de "sid" de plataforma)', () => {
  assert.equal(APP_SESSION_COOKIE, 'hbx_app_sid')
})

test('APP_SESSION_TTL_SECONDS = 30 días', () => {
  assert.equal(APP_SESSION_TTL_SECONDS, 30 * 24 * 60 * 60)
})

test('APP_MAGIC_LINK_TTL_MS = 15 min', () => {
  assert.equal(APP_MAGIC_LINK_TTL_MS, 15 * 60 * 1000)
})

test('randomToken() devuelve hex de 64 chars', () => {
  const t = randomToken()
  assert.equal(t.length, 64)
  assert.match(t, /^[0-9a-f]{64}$/)
})

test('randomToken() genera tokens distintos', () => {
  const a = randomToken()
  const b = randomToken()
  assert.notEqual(a, b)
})

test('buildAppSessionCookie incluye Path, HttpOnly, SameSite, no Secure en dev', () => {
  const c = buildAppSessionCookie('abc123', '/mybox', false)
  assert.match(c, /^hbx_app_sid=abc123/)
  assert.match(c, /Path=\/mybox/)
  assert.match(c, /HttpOnly/)
  assert.match(c, /SameSite=Lax/)
  assert.match(c, /Max-Age=/)
  assert.doesNotMatch(c, /Secure/)
})

test('buildAppSessionCookie agrega Secure cuando secure=true', () => {
  const c = buildAppSessionCookie('abc123', '/mybox', true)
  assert.match(c, /Secure/)
})

test('buildAppClearCookie tiene Max-Age=0', () => {
  const c = buildAppClearCookie('/mybox', false)
  assert.match(c, /Max-Age=0/)
  assert.match(c, /Path=\/mybox/)
})

test('getAppSessionIdFromRequest extrae el session id', () => {
  const req = { headers: { get: (k) => k.toLowerCase() === 'cookie' ? 'hbx_app_sid=zzz; sid=other' : null } }
  assert.equal(getAppSessionIdFromRequest(req), 'zzz')
})

test('getAppSessionIdFromRequest devuelve null si no hay cookie', () => {
  const req = { headers: { get: () => null } }
  assert.equal(getAppSessionIdFromRequest(req), null)
})

test('getAppSessionIdFromRequest ignora otras cookies (sid=)', () => {
  const req = { headers: { get: (k) => k.toLowerCase() === 'cookie' ? 'sid=plat' : null } }
  assert.equal(getAppSessionIdFromRequest(req), null)
})

test('shouldUseSecureCookie — HTMLBOX_COOKIE_SECURE=true gana siempre', () => {
  const req = { url: 'http://localhost/x' }
  const env = { HTMLBOX_COOKIE_SECURE: 'true' }
  assert.equal(shouldUseSecureCookie(req, env), true)
})

test('shouldUseSecureCookie — localhost no usa Secure', () => {
  const req = { url: 'http://controlplane.localhost:8781/x' }
  assert.equal(shouldUseSecureCookie(req, {}), false)
})

test('shouldUseSecureCookie — https real usa Secure', () => {
  const req = { url: 'https://portal.htmlbox.dev/x' }
  assert.equal(shouldUseSecureCookie(req, {}), true)
})

test('cookiePathForBox — usa Referer cuando matchea boxSlug', () => {
  const boxInfo = { boxSlug: 'mybox', visibility: 'private' }
  const req = {
    headers: { get: (k) => k.toLowerCase() === 'referer' ? 'https://acme.htmlbox.dev/mybox/' : null },
  }
  assert.equal(cookiePathForBox(boxInfo, 'abc123', req), '/mybox')
})

test('cookiePathForBox — usa Referer /t/{tenant}/{boxSlug}', () => {
  const boxInfo = { boxSlug: 'mybox', visibility: 'private' }
  const req = {
    headers: { get: (k) => k.toLowerCase() === 'referer' ? 'https://htmlbox.dev/t/acme/mybox' : null },
  }
  assert.equal(cookiePathForBox(boxInfo, 'abc123', req), '/t/acme/mybox')
})

test('cookiePathForBox — fallback a /{boxSlug} sin Referer', () => {
  const boxInfo = { boxSlug: 'mybox', visibility: 'private' }
  const req = { headers: { get: () => null } }
  assert.equal(cookiePathForBox(boxInfo, 'abc123', req), '/mybox')
})

test('cookiePathForBox — Referer malformado no rompe', () => {
  const boxInfo = { boxSlug: 'mybox', visibility: 'private' }
  const req = { headers: { get: (k) => k.toLowerCase() === 'referer' ? 'http://[invalid' : null } }
  assert.equal(cookiePathForBox(boxInfo, 'abc123', req), '/mybox')
})

test('verifyConfirmHtml escapa caracteres peligrosos en returnPath', () => {
  const html = verifyConfirmHtml('abcdef1234567890', 'tok', '/"><script>alert(1)</script>')
  // El payload XSS literal NO debe aparecer completo (sin los delimitadores
  // < > ", el <script> queda como texto inocuo dentro de un string literal)
  assert.doesNotMatch(html, /<script>alert/)
  // El returnPath saneado (sin < > ") queda en la asignación location.href
  assert.match(html, /window\.location\.href\s*=\s*"\/scriptalert\(1\)\/script"/)
})

test('verifyErrorHtml tiene mensajes por reason', () => {
  for (const r of ['missing_token', 'invalid_token', 'already_used', 'expired']) {
    const h = verifyErrorHtml(r)
    assert.match(h, /<!doctype html>/)
    assert.match(h, /<h1[^>]*>/)
  }
})