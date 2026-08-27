// __tests__/index.test.js — contract del package @htmlbox/runtime-core.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as runtimeCore from '../src/index.js'

test('runtime-core expone helpers de auth (movidos del runtime)', () => {
  assert.equal(typeof runtimeCore.controlPlaneHeaders, 'function')
  assert.equal(typeof runtimeCore.readSession, 'function')
  assert.equal(typeof runtimeCore.checkMembership, 'function')
})

test('runtime-core expone el servidor de HTML', () => {
  assert.equal(typeof runtimeCore.securityHeaders, 'function')
  assert.equal(typeof runtimeCore.readActiveHtml, 'function')
  assert.equal(typeof runtimeCore.injectSdk, 'function')
  assert.equal(typeof runtimeCore.injectDebugPanel, 'function')
  assert.equal(typeof runtimeCore.serveBoxHtml, 'function')
})

test('runtime-core expone el resolver de boxes', () => {
  assert.equal(typeof runtimeCore.resolveByShareId, 'function')
  assert.equal(typeof runtimeCore.resolveByTenantAndSlug, 'function')
  assert.equal(typeof runtimeCore.parseRuntimePath, 'function')
})

test('runtime-core expone el gate server-side del panel de debug', () => {
  assert.equal(typeof runtimeCore.shouldShowDebugPanel, 'function')
})

test('runtime-core NO expone auth de session de customer (eso vive en @htmlbox/runtime)', () => {
  // Garantía: extraer NO rompió el blast-radius. Todo lo de appAuth /
  // appAuthRoutes / appDataApi / tenantAppAuth se queda en el runtime
  // propiamente dicho. runtime-core es la capa "compartida con el per-box
  // script", no la capa "todo el runtime".
  const exposed = Object.keys(runtimeCore).sort()
  assert.ok(!exposed.includes('handleAppAuth'))
  assert.ok(!exposed.includes('handleAppDataApi'))
  assert.ok(!exposed.includes('handleTenantAppAuth'))
  assert.ok(!exposed.includes('handleDataApi'))
})
