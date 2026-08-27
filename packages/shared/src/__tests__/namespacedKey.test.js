// src/__tests__/namespacedKey.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  tenantRoot, boxRoot, boxVersionKey, boxUploadKey, boxAssetKey,
  isInsideBoxNamespace, isInsideTenantNamespace,
} from '../namespacedKey.js'

test('tenantRoot', () => {
  assert.equal(tenantRoot('acme'), 'tenants/acme')
})

test('boxRoot', () => {
  assert.equal(boxRoot('acme', 'abc123'), 'tenants/acme/boxes/abc123')
})

test('boxVersionKey', () => {
  assert.equal(boxVersionKey('acme', 'abc', 3), 'tenants/acme/boxes/abc/versions/v3.html')
})

test('boxUploadKey', () => {
  assert.equal(
    boxUploadKey('acme', 'abc', 'f1', 'data.csv'),
    'tenants/acme/boxes/abc/uploads/f1/data.csv'
  )
})

test('boxAssetKey nested', () => {
  assert.equal(
    boxAssetKey('acme', 'abc', 'css', 'main.css'),
    'tenants/acme/boxes/abc/assets/css/main.css'
  )
})

test('isInsideBoxNamespace match', () => {
  assert.ok(isInsideBoxNamespace('tenants/acme/boxes/abc/versions/v1.html', 'acme', 'abc'))
})

test('isInsideBoxNamespace no match (otro tenant)', () => {
  assert.equal(isInsideBoxNamespace('tenants/evil/boxes/abc/versions/v1.html', 'acme', 'abc'), false)
})

test('isInsideBoxNamespace no match (otro box)', () => {
  assert.equal(isInsideBoxNamespace('tenants/acme/boxes/xyz/versions/v1.html', 'acme', 'abc'), false)
})

test('isInsideTenantNamespace match', () => {
  assert.ok(isInsideTenantNamespace('tenants/acme/_exports/r1/x.pdf', 'acme'))
})

test('rechaza tenantSlug inválido', () => {
  assert.throws(() => tenantRoot('Acme'), /inválido/)
  assert.throws(() => tenantRoot('-acme'), /inválido/)
  assert.throws(() => tenantRoot('acme_evil'), /inválido/)
})

test('rechaza traversal', () => {
  assert.throws(() => boxAssetKey('acme', 'abc', '..', 'evil.txt'), /separadores/)
  assert.throws(() => boxAssetKey('acme', 'abc', '../etc/passwd'), /separadores/)
  assert.throws(() => boxUploadKey('acme', 'abc', 'f1', '../../etc/passwd'), /separadores/)
})

test('rechaza boxId vacío', () => {
  assert.throws(() => boxRoot('acme', ''), /vacío/)
})

test('rechaza versión no entera', () => {
  assert.throws(() => boxVersionKey('acme', 'abc', 0), /inválida/)
  assert.throws(() => boxVersionKey('acme', 'abc', 1.5), /inválida/)
  assert.throws(() => boxVersionKey('acme', 'abc', -1), /inválida/)
})