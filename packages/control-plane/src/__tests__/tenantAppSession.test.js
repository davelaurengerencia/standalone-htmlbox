// __tests__/tenantAppSession.test.js — funciones puras de session.js (fase 3).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTenantAppSessionCookie,
  buildTenantAppClearCookie,
  getTenantAppSessionIdFromRequest,
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
  const req = { url: 'https://acme.htmlbox.dev/mybox', headers: { get: () => null } }
  const env = { HTMLBOX_SESSION_DOMAIN: '.htmlbox.dev' }
  const c = buildTenantAppSessionCookie(req, 'abc', env)
  assert.match(c, /Domain=\.htmlbox\.dev/)
})

test('buildTenantAppSessionCookie agrega Secure cuando secure=true', () => {
  const req = { url: 'https://acme.htmlbox.dev/mybox', headers: { get: () => null } }
  const env = { HTMLBOX_SESSION_DOMAIN: '.htmlbox.dev' }
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