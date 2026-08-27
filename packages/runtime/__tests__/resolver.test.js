// __tests__/resolver.test.js — resuelve boxes por share/tenant/slug.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRuntimePath } from '../src/lib/resolver.js'

const base = (path, host = 'htmlbox.app') => new URL(`https://${host}${path}`)

test('parseRuntimePath /s/{shareId}', () => {
  const r = parseRuntimePath(base('/s/abc123def4'))
  assert.equal(r.mode, 'public')
  assert.equal(r.shareId, 'abc123def4')
})

test('parseRuntimePath /s/{shareId} con slash final', () => {
  const r = parseRuntimePath(base('/s/abc123def4/'))
  assert.equal(r.mode, 'public')
  assert.equal(r.shareId, 'abc123def4')
})

test('parseRuntimePath /{boxSlug} en host *.htmlbox.app', () => {
  const r = parseRuntimePath(base('/cartera', 'acme.htmlbox.app'))
  assert.equal(r.mode, 'private')
  assert.equal(r.tenantSlug, 'acme')
  assert.equal(r.boxSlug, 'cartera')
})

test('parseRuntimePath /{boxSlug} en host *.localhost (dev)', () => {
  const r = parseRuntimePath(base('/cartera', 'acme.localhost'))
  assert.equal(r.mode, 'private')
  assert.equal(r.tenantSlug, 'acme')
  assert.equal(r.boxSlug, 'cartera')
})

test('parseRuntimePath rechaza shareId mal formado', () => {
  const r = parseRuntimePath(base('/s/AB'))
  assert.equal(r, null)
})

test('parseRuntimePath rechaza root /', () => {
  const r = parseRuntimePath(base('/'))
  assert.equal(r, null)
})

test('parseRuntimePath rechaza boxSlug con caracteres raros', () => {
  const r = parseRuntimePath(base('/Foo Bar!', 'acme.htmlbox.app'))
  assert.equal(r, null)
})