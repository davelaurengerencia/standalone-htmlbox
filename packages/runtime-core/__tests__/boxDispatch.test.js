// __tests__/boxDispatch.test.js — contrato entre dispatcher y per-box script.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BOX_ID_HEADER,
  TENANT_HEADER,
  SLUG_HEADER,
  VIS_HEADER,
  BOX_ID_PATTERN,
  isWorkerNotFoundError,
} from '../src/boxDispatch.js'

// ============ Headers canónicos ============

test('BOX_ID_HEADER es el nombre canónico del header boxId', () => {
  assert.equal(BOX_ID_HEADER, 'X-HTMLBox-Box-Id')
})

test('TENANT_HEADER es el nombre canónico del header tenantSlug', () => {
  assert.equal(TENANT_HEADER, 'X-HTMLBox-Tenant-Slug')
})

test('SLUG_HEADER es el nombre canónico del header boxSlug', () => {
  assert.equal(SLUG_HEADER, 'X-HTMLBox-Box-Slug')
})

test('VIS_HEADER es el nombre canónico del header visibility', () => {
  assert.equal(VIS_HEADER, 'X-HTMLBox-Visibility')
})

// ============ BOX_ID_PATTERN ============

test('BOX_ID_PATTERN acepta 16 chars [a-z0-9]', () => {
  assert.ok(BOX_ID_PATTERN.test('abcdef0123456789'))
  assert.ok(BOX_ID_PATTERN.test('0000000000000000'))
  assert.ok(BOX_ID_PATTERN.test('zzzzzzzzzzzzzzzz'))
})

test('BOX_ID_PATTERN rechaza longitudes distintas a 16', () => {
  assert.equal(BOX_ID_PATTERN.test('abcdef012345678'), false, '15 chars no')
  assert.equal(BOX_ID_PATTERN.test('abcdef01234567890'), false, '17 chars no')
  assert.equal(BOX_ID_PATTERN.test(''), false, 'vacío no')
})

test('BOX_ID_PATTERN rechaza caracteres fuera de [a-z0-9]', () => {
  assert.equal(BOX_ID_PATTERN.test('ABCDEF0123456789'), false, 'mayúsculas no')
  assert.equal(BOX_ID_PATTERN.test('abcdef012345678!'), false, 'símbolos no')
  assert.equal(BOX_ID_PATTERN.test('abcdef_0123456789'), false, 'underscore no')
  assert.equal(BOX_ID_PATTERN.test('abcdef-0123456789'), false, 'guión no')
  assert.equal(BOX_ID_PATTERN.test('abcdef 0123456789'), false, 'espacio no')
})

// ============ isWorkerNotFoundError ============

test('isWorkerNotFoundError: true para "Worker not found."', () => {
  assert.equal(isWorkerNotFoundError(new Error('Worker not found.')), true)
})

test('isWorkerNotFoundError: true para "Error: Worker not found." (wrangler prefix)', () => {
  assert.equal(isWorkerNotFoundError(new Error('Error: Worker not found.')), true)
})

test('isWorkerNotFoundError: true para variante con nombre entre comillas', () => {
  assert.equal(isWorkerNotFoundError(new Error(`Error: Worker 'box-abc123' not found.`)), true)
})

test('isWorkerNotFoundError: false para otros errores', () => {
  assert.equal(isWorkerNotFoundError(new Error('Script threw an exception.')), false)
  assert.equal(isWorkerNotFoundError(new Error('Internal error: timeout')), false)
  assert.equal(isWorkerNotFoundError(new TypeError('cannot read property of undefined')), false)
})

test('isWorkerNotFoundError: false para non-Error (string, null, undefined)', () => {
  assert.equal(isWorkerNotFoundError('Worker not found.'), false)
  assert.equal(isWorkerNotFoundError(null), false)
  assert.equal(isWorkerNotFoundError(undefined), false)
  assert.equal(isWorkerNotFoundError(42), false)
})

test('isWorkerNotFoundError: case-insensitive (cubre variantes de wrangler)', () => {
  // Cloudflare podría loguear en cualquier casing. El predicado es defensivo.
  assert.equal(isWorkerNotFoundError(new Error('worker not found.')), true)
  assert.equal(isWorkerNotFoundError(new Error('WORKER NOT FOUND')), true)
})
