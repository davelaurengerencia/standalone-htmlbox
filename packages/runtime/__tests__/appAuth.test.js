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

test('cookiePathForBox — devuelve Path determinístico /api/app-auth/{boxId} (anexo H2)', () => {
  // La decisión (Anexo de Seguridad hallazgo 2) es NO depender del header
  // Referer (que en el flujo real nunca vale porque el fetch a /consume sale
  // de /verify, no de la URL pública del box). Path = /api/app-auth/{boxId}
  // funciona para los 3 modos de ruteo: los endpoints auth son SIEMPRE ese
  // path, y boxId es único globalmente (sin colisión entre boxes con mismo
  // boxSlug).
  const boxInfo = { boxSlug: 'mybox', tenantSlug: 'acme', visibility: 'private' }
  const req = { headers: { get: () => null } }
  assert.equal(cookiePathForBox(boxInfo, 'abc123def456ghij', req), '/api/app-auth/abc123def456ghij')
})

test('cookiePathForBox — ignora boxSlug del Referer (la cookie NO viaja a la página pública)', () => {
  // Garantía: el Path NO es /{boxSlug}. Eso evita la colisión con la que el
  // Anexo de Seguridad llamó la atención — dos boxes con mismo slug bajo
  // mismo host pisándose la cookie entre sí.
  const boxInfo = { boxSlug: 'mybox', visibility: 'private' }
  const req = {
    headers: { get: (k) => k.toLowerCase() === 'referer' ? 'https://acme.htmlbox.dev/mybox/' : null },
  }
  const path = cookiePathForBox(boxInfo, 'abc123def456ghij', req)
  assert.notEqual(path, '/mybox', 'nunca devuelve el path público del box')
  assert.equal(path, '/api/app-auth/abc123def456ghij')
})

test('cookiePathForBox — ignora /t/... del Referer (también funciona en path-based)', () => {
  const boxInfo = { boxSlug: 'mybox', visibility: 'private' }
  const req = {
    headers: { get: (k) => k.toLowerCase() === 'referer' ? 'https://htmlbox.dev/t/acme/mybox' : null },
  }
  const path = cookiePathForBox(boxInfo, 'abc123def456ghij', req)
  assert.notEqual(path, '/t/acme/mybox', 'nunca devuelve el path /t/...')
  assert.equal(path, '/api/app-auth/abc123def456ghij')
})

test('cookiePathForBox — ignora /s/{shareId}/... del Referer (también funciona en share)', () => {
  const boxInfo = { boxSlug: 'mybox', shareId: 'shr123', visibility: 'public' }
  const req = {
    headers: { get: (k) => k.toLowerCase() === 'referer' ? 'https://htmlbox.dev/s/shr123abc' : null },
  }
  const path = cookiePathForBox(boxInfo, 'abc123def456ghij', req)
  assert.notEqual(path, '/s/shr123abc', 'nunca devuelve el path /s/...')
  assert.equal(path, '/api/app-auth/abc123def456ghij')
})

test('cookiePathForBox — boxId con formato inválido cae a "/" (defensa)', () => {
  // Si alguien logra pasar un boxId que no matchea el formato de 16 chars
  // alfanuméricos, no emitir una cookie con un path arbitrario. El
  // llamador (router) ya rechaza boxIds inválidos antes con 400/404;
  // este fallback es una red de seguridad final.
  assert.equal(cookiePathForBox({}, 'tooshort', {}), '/')
  assert.equal(cookiePathForBox({}, 'CON-UPPER-CASE', {}), '/')
  assert.equal(cookiePathForBox({}, 'has spaces here 123', {}), '/')
  assert.equal(cookiePathForBox({}, null, {}), '/')
})

test('cookiePathForBox — funciona sin request (test puro, sin Referer)', () => {
  // La función ya NO lee el Referer (Anexo de Seguridad). Probamos que se
  // puede llamar sin un request válido, lo cual rompe el patrón anterior.
  const path = cookiePathForBox({ boxSlug: 'x', visibility: 'private' }, 'aaaaaaaaaaaaaaaa', null)
  assert.equal(path, '/api/app-auth/aaaaaaaaaaaaaaaa')
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