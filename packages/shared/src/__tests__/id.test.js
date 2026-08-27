// src/__tests__/id.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boxId, userId, shareId, isValidTenantSlug, isValidBoxSlug } from '../id.js'

test('boxId genera 16 chars alfanuméricos', () => {
  const a = boxId()
  assert.equal(typeof a, 'string')
  assert.equal(a.length, 16)
  assert.match(a, /^[a-z0-9]+$/)
})

test('boxId no repite (probabilístico)', () => {
  const set = new Set(Array.from({ length: 200 }, boxId))
  assert.ok(set.size >= 195, `demasiadas colisiones: ${set.size}/200`)
})

test('isValidTenantSlug', () => {
  assert.ok(isValidTenantSlug('acme'))
  assert.ok(isValidTenantSlug('empresa-abc'))
  assert.equal(isValidTenantSlug('Acme'), false)
  assert.equal(isValidTenantSlug('-acme'), false)
  assert.equal(isValidTenantSlug('acme-'), false)
  assert.equal(isValidTenantSlug('ac'), false) // muy corto
  assert.equal(isValidTenantSlug('acme_evil'), false)
})

test('isValidBoxSlug', () => {
  assert.ok(isValidBoxSlug('cartera'))
  assert.ok(isValidBoxSlug('dashboard-ventas'))
  assert.ok(isValidBoxSlug('app_v1'))
  assert.equal(isValidBoxSlug('Cartera'), false)
  assert.equal(isValidBoxSlug('a'), false) // muy corto
  assert.equal(isValidBoxSlug('a/b'), false)
})