// src/__tests__/versioning.test.js — reglas de las "últimas 5 versiones".
//
// Usamos fakes (no D1 ni R2 reales) para verificar el comportamiento:
//   - bumpVersion lee + actualiza
//   - purgeIfOverLimit borra versiones antiguas
//   - rollbackTo copia como nueva versión, nunca destruye

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_BOX_VERSIONS } from '../constants.js'
import { boxVersionKey } from '../namespacedKey.js'
import { bumpVersion, listVersions, purgeIfOverLimit, recordVersion, rollbackTo } from '../versioning.js'

// --- Fakes ---------------------------------------------------------------

function fakeDb(initialBox, initialVersions = []) {
  const box = { ...initialBox }
  const versions = initialVersions.map((v) => ({ ...v }))
  return {
    prepare(sql) {
      // Devolvemos una statement-shaped object con .bind() encadenable.
      const stmt = {
        _sql: sql,
        _binds: [],
        bind(...args) {
          this._binds = args
          return this
        },
        async first() {
          const args = this._binds
          if (/SELECT htmlbox_version, tenant_id/.test(sql)) {
            return {
              htmlbox_version: box.htmlbox_version ?? 0,
              tenant_id: box.tenant_id,
              r2_versions_prefix: box.r2_versions_prefix,
            }
          }
          return null
        },
        async all() {
          const args = this._binds
          if (/FROM htmlbox_versions/.test(sql)) {
            const filtered = versions.filter((v) => v.box_id === args[0])
            filtered.sort((a, b) => b.version - a.version)
            return { results: filtered }
          }
          return { results: [] }
        },
        async run() {
          const args = this._binds
          if (/UPDATE htmlbox_boxes SET htmlbox_version/.test(sql)) {
            box.htmlbox_version = args[0]
            return { meta: { changes: 1 } }
          }
          if (/INSERT INTO htmlbox_versions/.test(sql)) {
            const [box_id, version, source, agent_name, summary, created_by] = args
            versions.push({ box_id, version, source, agent_name, summary, created_by })
            return { meta: { changes: 1 } }
          }
          if (/DELETE FROM htmlbox_versions/.test(sql)) {
            const before = versions.length
            for (let i = versions.length - 1; i >= 0; i--) {
              if (versions[i].box_id === args[0] && versions[i].version === args[1]) {
                versions.splice(i, 1)
              }
            }
            return { meta: { changes: before - versions.length } }
          }
          return { meta: { changes: 0 } }
        },
      }
      return stmt
    },
    _state: { box, versions },
  }
}

function fakeBucket(initial = {}) {
  const store = { ...initial }
  return {
    async get(key) {
      if (!(key in store)) return null
      return { text: async () => store[key] }
    },
    async put(key, value, _opts) { store[key] = value },
    async delete(key) { delete store[key] },
    _store: store,
  }
}

function makeInitialVersions(boxId, count) {
  return Array.from({ length: count }, (_, i) => ({
    box_id: boxId,
    version: i + 1,
    source: 'portal',
    agent_name: null,
    summary: `v${i + 1}`,
    created_by: 'u1',
  }))
}

// --- Tests ---------------------------------------------------------------

test('MAX_BOX_VERSIONS es 5', () => {
  assert.equal(MAX_BOX_VERSIONS, 5)
})

test('boxVersionKey arma path correcto', () => {
  assert.equal(boxVersionKey('acme', 'abc', 3), 'tenants/acme/boxes/abc/versions/v3.html')
})

test('bumpVersion incrementa de 0 a 1', async () => {
  const db = fakeDb({ id: 'b1', tenant_id: 't1', r2_versions_prefix: '...' })
  const v = await bumpVersion(db, 'b1')
  assert.equal(v, 1)
  assert.equal(db._state.box.htmlbox_version, 1)
})

test('bumpVersion incrementa de 5 a 6', async () => {
  const db = fakeDb({ id: 'b1', tenant_id: 't1', r2_versions_prefix: '...', htmlbox_version: 5 })
  const v = await bumpVersion(db, 'b1')
  assert.equal(v, 6)
})

test('recordVersion persiste en D1', async () => {
  const db = fakeDb({ id: 'b1', tenant_id: 't1', r2_versions_prefix: '...' })
  await recordVersion({ db, boxId: 'b1', version: 1, source: 'portal', summary: 'init', userId: 'u1' })
  assert.equal(db._state.versions.length, 1)
  assert.equal(db._state.versions[0].summary, 'init')
})

test('listVersions devuelve desc', async () => {
  const db = fakeDb({ id: 'b1', tenant_id: 't1' }, makeInitialVersions('b1', 3))
  const r = await listVersions(db, 'b1')
  assert.deepEqual(r.map((v) => v.version), [3, 2, 1])
})

test('purgeIfOverLimit NO purga si <= 5', async () => {
  const db = fakeDb({ id: 'b1', tenant_id: 't1' }, makeInitialVersions('b1', 5))
  const bucket = fakeBucket({
    'tenants/acme/boxes/b1/versions/v1.html': 'x',
    'tenants/acme/boxes/b1/versions/v2.html': 'x',
    'tenants/acme/boxes/b1/versions/v3.html': 'x',
    'tenants/acme/boxes/b1/versions/v4.html': 'x',
    'tenants/acme/boxes/b1/versions/v5.html': 'x',
  })
  const r = await purgeIfOverLimit({ db, bucket, tenantSlug: 'acme', boxId: 'b1' })
  assert.deepEqual(r.purged, [])
  assert.equal(Object.keys(bucket._store).length, 5)
})

test('purgeIfOverLimit purga hasta dejar 5', async () => {
  const db = fakeDb({ id: 'b1', tenant_id: 't1' }, makeInitialVersions('b1', 7))
  const bucket = fakeBucket({
    'tenants/acme/boxes/b1/versions/v1.html': 'x',
    'tenants/acme/boxes/b1/versions/v2.html': 'x',
    'tenants/acme/boxes/b1/versions/v3.html': 'x',
    'tenants/acme/boxes/b1/versions/v4.html': 'x',
    'tenants/acme/boxes/b1/versions/v5.html': 'x',
    'tenants/acme/boxes/b1/versions/v6.html': 'x',
    'tenants/acme/boxes/b1/versions/v7.html': 'x',
  })
  const r = await purgeIfOverLimit({ db, bucket, tenantSlug: 'acme', boxId: 'b1' })
  // Quedan 5 versiones: v3..v7
  assert.equal(db._state.versions.length, 5)
  assert.deepEqual(r.purged.sort(), [1, 2])
  assert.equal(Object.keys(bucket._store).length, 5)
  assert.equal(bucket._store['tenants/acme/boxes/b1/versions/v7.html'], 'x')
  assert.equal(bucket._store['tenants/acme/boxes/b1/versions/v3.html'], 'x')
})

test('rollbackTo crea nueva versión sin destruir el historial', async () => {
  const db = fakeDb({ id: 'b1', tenant_id: 't1', htmlbox_version: 5 }, makeInitialVersions('b1', 5))
  const bucket = fakeBucket({
    'tenants/acme/boxes/b1/versions/v1.html': '<old v1>',
    'tenants/acme/boxes/b1/versions/v2.html': '<v2>',
    'tenants/acme/boxes/b1/versions/v3.html': '<v3>',
    'tenants/acme/boxes/b1/versions/v4.html': '<v4>',
    'tenants/acme/boxes/b1/versions/v5.html': '<v5 actual>',
  })
  const r = await rollbackTo({
    db, bucket, tenantSlug: 'acme', boxId: 'b1', targetVersion: 2, userId: 'u1',
  })
  assert.equal(r.version, 6)
  assert.match(r.html, /<v2>/)
  // Después de purgeIfOverLimit: quedan 5 keys (v2..v6), v1 se purgó
  assert.equal(Object.keys(bucket._store).length, 5)
  assert.equal(bucket._store['tenants/acme/boxes/b1/versions/v6.html'], '<v2>')
  assert.equal(bucket._store['tenants/acme/boxes/b1/versions/v1.html'], undefined, 'v1 debe haberse purgado')
  // D1 también tiene 5 versiones: v2..v6, v1 purgado
  const versions = await listVersions(db, 'b1')
  assert.equal(versions.length, 5)
  assert.equal(versions.find((v) => v.version === 6).source, 'rollback')
  assert.equal(versions.find((v) => v.version === 1), undefined)
})

test('rollbackTo dentro del límite (4 versiones) no purga nada', async () => {
  const db = fakeDb({ id: 'b1', tenant_id: 't1', htmlbox_version: 4 }, makeInitialVersions('b1', 4))
  const bucket = fakeBucket({
    'tenants/acme/boxes/b1/versions/v1.html': '<v1>',
    'tenants/acme/boxes/b1/versions/v2.html': '<v2>',
    'tenants/acme/boxes/b1/versions/v3.html': '<v3>',
    'tenants/acme/boxes/b1/versions/v4.html': '<v4 actual>',
  })
  const r = await rollbackTo({
    db, bucket, tenantSlug: 'acme', boxId: 'b1', targetVersion: 2, userId: 'u1',
  })
  assert.equal(r.version, 5)
  // Ninguna purga: quedan 5 keys + 5 versiones
  assert.equal(Object.keys(bucket._store).length, 5)
  const versions = await listVersions(db, 'b1')
  assert.equal(versions.length, 5)
})