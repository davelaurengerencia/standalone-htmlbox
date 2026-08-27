// __tests__/htmlServer.test.js — seguridad e inyección del SDK.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { securityHeaders, injectSdk } from '../src/htmlServer.js'

test('securityHeaders caja público tiene CSP + COOP', () => {
  const h = securityHeaders('public')
  assert.match(h['Content-Security-Policy'], /default-src 'self'/)
  assert.match(h['Content-Security-Policy'], /frame-ancestors 'self'/)
  assert.equal(h['Cross-Origin-Opener-Policy'], 'same-origin')
  assert.equal(h['X-Content-Type-Options'], 'nosniff')
  assert.equal(h['Cache-Control'], 'no-store')
})

test('securityHeaders whitelist de CDNs populares en script-src', () => {
  const h = securityHeaders('public')
  const csp = h['Content-Security-Policy']
  // CDNs que el HTML de usuario típicamente usa.
  // Si bajamos uno, rompemos apps que los necesitan.
  assert.match(csp, /https:\/\/cdn\.tailwindcss\.com/, 'tailwind CDN')
  assert.match(csp, /https:\/\/cdn\.jsdelivr\.net/, 'jsdelivr')
  assert.match(csp, /https:\/\/unpkg\.com/, 'unpkg')
  assert.match(csp, /https:\/\/cdnjs\.cloudflare\.com/, 'cdnjs')
})

test('securityHeaders connect-src permite APIs externas HTTPS', () => {
  const h = securityHeaders('public')
  const csp = h['Content-Security-Policy']
  // SPAs del usuario típicamente llaman APIs externas (fetch/XHR/WebSocket).
  // El host 'self' es para endpoints internos del box; https: para todo lo demás.
  assert.match(csp, /connect-src[^;]*'self'[^;]*https:/, 'permite self + https')
  assert.match(csp, /wss:/, 'permite WebSockets seguros')
})

test('securityHeaders caja privado también recibe headers equivalentes', () => {
  const h = securityHeaders('private')
  assert.equal(h['Cross-Origin-Opener-Policy'], 'same-origin')
  assert.equal(h['Cache-Control'], 'no-store')
})

test('securityHeaders caja privado también recibe headers equivalentes', () => {
  const h = securityHeaders('private')
  assert.equal(h['Cross-Origin-Opener-Policy'], 'same-origin')
  assert.equal(h['Cache-Control'], 'no-store')
})

test('injectSdk agrega script antes de </body>', () => {
  const html = '<html><body><h1>Hola</h1></body></html>'
  const out = injectSdk(html, 'abc', 'public')
  assert.match(out, /<script src="\/_sdk\/htmlbox\.js\?boxId=abc&v=public"><\/script><\/body>/)
})

test('injectSdk agrega al final si no hay </body>', () => {
  const html = '<html><body><h1>Hola</h1></body></html>'
  const stripped = html.replace(/<\/body>/, '')
  const out = injectSdk(stripped, 'box1', 'private')
  assert.match(out, /<script src="\/_sdk\/htmlbox\.js\?boxId=box1&v=private"><\/script>/)
})

test('injectSdk codifica boxId en la URL', () => {
  const html = '<html><body>x</body></html>'
  const out = injectSdk(html, 'abc/123', 'public')
  // boxId con slash — debe estar encoded
  assert.match(out, /boxId=abc%2F123/)
})