// src/__tests__/cleanup.test.js — tests del cleanup de boxes abandonados.
//
// Mocks: env.STUDIO_D1 (queries D1) y deps.deleteStudioBoxWorker (WFP).
// Sin red real, sin wrangler.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  emptyResult,
  listCleanupCandidates,
  cleanupBox,
  runCleanup,
} from '../lib/cleanup.js'

// Mock de D1 — captura queries y bind params.
function mockD1({ rows = [], failOn = null } = {}) {
  const calls = []
  return {
    calls,
    prepare(sql) {
      const stmt = {
        bind(...params) {
          calls.push({ sql, params })
          if (failOn && failOn === sql) {
            return {
              all: async () => { throw new Error('mock D1 error') },
              first: async () => { throw new Error('mock D1 error') },
              run: async () => { throw new Error('mock D1 error') },
            }
          }
          return {
            all: async () => ({ results: rows }),
            first: async () => rows[0] || null,
            run: async () => ({ success: true }),
          }
        },
        all: async () => ({ results: rows }),
        run: async () => ({ success: true }),
      }
      return stmt
    },
  }
}

// Mock de deleteStudioBoxWorker — devuelve configurable.
function mockDelete({ ok = true, idempotent = false, throws = null } = {}) {
  const calls = []
  const fn = async (env, boxId) => {
    calls.push({ boxId })
    if (throws) throw throws
    return { ok, idempotent }
  }
  fn.calls = calls
  return fn
}

// === emptyResult ===

test('emptyResult: shape correcto', () => {
  assert.deepEqual(emptyResult(), { scanned: 0, deleted: 0, failed: 0, errors: [] })
})

// === listCleanupCandidates ===

test('listCleanupCandidates: query incluye threshold y filtra deleted=0', async () => {
  const d1 = mockD1({ rows: [] })
  await listCleanupCandidates({ STUDIO_D1: d1 }, 30)
  assert.equal(d1.calls.length, 1)
  assert.match(d1.calls[0].sql, /deleted = 0/)
  assert.match(d1.calls[0].sql, /last_seen < datetime/)
  assert.deepEqual(d1.calls[0].params, [30])
})

test('listCleanupCandidates: usa HTMLBOX_STUDIO_CLEANUP_DAYS del env si no se pasa threshold', async () => {
  const d1 = mockD1({ rows: [] })
  await listCleanupCandidates({ STUDIO_D1: d1, HTMLBOX_STUDIO_CLEANUP_DAYS: '7' })
  assert.deepEqual(d1.calls[0].params, [7])
})

test('listCleanupCandidates: default 30 días', async () => {
  const d1 = mockD1({ rows: [] })
  await listCleanupCandidates({ STUDIO_D1: d1 })
  assert.deepEqual(d1.calls[0].params, [30])
})

test('listCleanupCandidates: devuelve candidates del query', async () => {
  const candidates = [
    { box_id: 'abc0000000000001', last_seen: '2026-01-01' },
    { box_id: 'abc0000000000002', last_seen: '2025-12-01' },
  ]
  const d1 = mockD1({ rows: candidates })
  const { candidates: out, thresholdDays } = await listCleanupCandidates({ STUDIO_D1: d1 }, 30)
  assert.deepEqual(out, candidates)
  assert.equal(thresholdDays, 30)
})

test('listCleanupCandidates: sin D1 → throw', async () => {
  await assert.rejects(
    () => listCleanupCandidates({}, 30),
    /STUDIO_D1 binding no configurado/,
  )
})

test('listCleanupCandidates: error de D1 → propaga', async () => {
  // Usamos un D1 mock donde prepare().bind() tira.
  const d1 = {
    prepare: () => ({
      bind: () => { throw new Error('mock D1 error') },
    }),
  }
  await assert.rejects(
    () => listCleanupCandidates({ STUDIO_D1: d1 }, 30),
    /mock D1 error/,
  )
})

// === cleanupBox ===

test('cleanupBox: WFP OK + D1 OK → { ok: true }', async () => {
  const d1 = mockD1()
  const deleteWfp = mockDelete({ ok: true })
  const r = await cleanupBox(
    { STUDIO_D1: d1 },
    { box_id: 'abc0000000000001' },
    { deleteStudioBoxWorker: deleteWfp },
  )
  assert.equal(r.ok, true)
  assert.equal(r.boxId, 'abc0000000000001')
  assert.equal(r.wfpIdempotent, false)
  assert.equal(deleteWfp.calls.length, 1)
  assert.equal(d1.calls.length, 1)
  assert.match(d1.calls[0].sql, /UPDATE htmlbox_studio_boxes SET deleted = 1/)
  assert.deepEqual(d1.calls[0].params, ['abc0000000000001'])
})

test('cleanupBox: WFP idempotente (404) → { ok: true, wfpIdempotent: true }', async () => {
  const d1 = mockD1()
  const deleteWfp = mockDelete({ ok: true, idempotent: true })
  const r = await cleanupBox(
    { STUDIO_D1: d1 },
    { box_id: 'abc0000000000002' },
    { deleteStudioBoxWorker: deleteWfp },
  )
  assert.equal(r.ok, true)
  assert.equal(r.wfpIdempotent, true)
})

test('cleanupBox: WFP throw → { ok: false, step: wfp } (no toca D1)', async () => {
  const d1 = mockD1()
  const deleteWfp = mockDelete({ throws: new Error('network fail') })
  const r = await cleanupBox(
    { STUDIO_D1: d1 },
    { box_id: 'abc0000000000003' },
    { deleteStudioBoxWorker: deleteWfp },
  )
  assert.equal(r.ok, false)
  assert.equal(r.step, 'wfp')
  assert.match(r.reason, /network fail/)
  assert.equal(d1.calls.length, 0)
})

test('cleanupBox: D1 throw → { ok: false, step: d1 } (WFP ya se borró)', async () => {
  // D1 mock que tira en UPDATE pero no en SELECT.
  const d1 = {
    prepare: (sql) => {
      if (/UPDATE/.test(sql)) {
        return {
          bind: () => ({ run: async () => { throw new Error('d1 update fail') } }),
        }
      }
      return {
        bind: () => ({ run: async () => ({ success: true }) }),
      }
    },
  }
  const deleteWfp = mockDelete({ ok: true })
  const r = await cleanupBox(
    { STUDIO_D1: d1 },
    { box_id: 'abc0000000000004' },
    { deleteStudioBoxWorker: deleteWfp },
  )
  assert.equal(r.ok, false)
  assert.equal(r.step, 'd1')
  assert.equal(deleteWfp.calls.length, 1)
})

// === runCleanup ===

test('runCleanup: 0 candidates → empty result', async () => {
  const d1 = mockD1({ rows: [] })
  const deleteWfp = mockDelete()
  const r = await runCleanup({ STUDIO_D1: d1 }, { deleteStudioBoxWorker: deleteWfp })
  assert.equal(r.scanned, 0)
  assert.equal(r.deleted, 0)
  assert.equal(r.failed, 0)
  assert.equal(deleteWfp.calls.length, 0)
})

test('runCleanup: 3 candidates todos OK → 3 deleted', async () => {
  const candidates = [
    { box_id: 'abc0000000000001' },
    { box_id: 'abc0000000000002' },
    { box_id: 'abc0000000000003' },
  ]
  const d1 = mockD1({ rows: candidates })
  const deleteWfp = mockDelete({ ok: true })
  const r = await runCleanup({ STUDIO_D1: d1 }, { deleteStudioBoxWorker: deleteWfp })
  assert.equal(r.scanned, 3)
  assert.equal(r.deleted, 3)
  assert.equal(r.failed, 0)
  assert.equal(deleteWfp.calls.length, 3)
})

test('runCleanup: mix de OK y fail → counts correctos', async () => {
  const candidates = [
    { box_id: 'abc0000000000001' },
    { box_id: 'abc0000000000002' },
    { box_id: 'abc0000000000003' },
  ]
  const d1 = mockD1({ rows: candidates })
  const deleteWfp = async (env, boxId) => {
    if (boxId === 'abc0000000000002') throw new Error('flaky')
    return { ok: true }
  }
  const r = await runCleanup({ STUDIO_D1: d1 }, { deleteStudioBoxWorker: deleteWfp })
  assert.equal(r.scanned, 3)
  assert.equal(r.deleted, 2)
  assert.equal(r.failed, 1)
  assert.equal(r.errors.length, 1)
  assert.equal(r.errors[0].box_id, 'abc0000000000002')
  assert.equal(r.errors[0].step, 'wfp')
})

test('runCleanup: list throw → result con error y sin counts', async () => {
  const d1 = {
    prepare: () => ({
      bind: () => { throw new Error('d1 list fail') },
    }),
  }
  const deleteWfp = mockDelete()
  const r = await runCleanup({ STUDIO_D1: d1 }, { deleteStudioBoxWorker: deleteWfp })
  assert.equal(r.scanned, 0)
  assert.equal(r.deleted, 0)
  assert.equal(r.errors.length, 1)
  assert.equal(r.errors[0].step, 'list')
  assert.equal(deleteWfp.calls.length, 0)
})

test('runCleanup: sin D1 → error en result, no throw', async () => {
  const deleteWfp = mockDelete()
  const r = await runCleanup({}, { deleteStudioBoxWorker: deleteWfp })
  assert.equal(r.errors.length, 1)
  assert.equal(r.errors[0].step, 'list')
  assert.match(r.errors[0].reason, /STUDIO_D1/)
})