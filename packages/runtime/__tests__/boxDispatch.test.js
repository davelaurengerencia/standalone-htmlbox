// __tests__/boxDispatch.test.js — glue dispatcher-side (Phase 2 WFP).
//
// Casos cubiertos:
//   A. env.BOX_DISPATCH ausente          → devuelve null (caller cae al path viejo)
//   B. .get(name) tira "Worker not found" → devuelve null
//   C. .get(name) tira otro error        → propaga (no se silencia)
//   D. Stub OK: devuelve Response         → devuelve esa Response con los
//                                            4 headers de contexto seteados
//   E. .get(name) devuelve undefined     → null (defensivo)
//   F. .fetch() tira "Worker not found"  → null (carrera entre .get y .fetch)
//
// Plus: withDispatchContext (setea los 4 headers, valida boxId,
// preserva method y otros headers).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dispatchToBoxWorker, withDispatchContext } from '../src/lib/boxDispatch.js'
import {
  BOX_ID_HEADER,
  TENANT_HEADER,
  SLUG_HEADER,
  VIS_HEADER,
} from '@htmlbox/runtime-core'

const VALID_RESOLVED = {
  boxId: 'abcdef0123456789',
  tenantSlug: 'acme',
  boxSlug: 'cartera',
  visibility: 'public',
}

// ============ dispatchToBoxWorker ============

test('A: env.BOX_DISPATCH ausente → null (caller cae al path viejo)', async () => {
  const req = new Request('https://runtime.localhost/s/abc123def4')
  const r = await dispatchToBoxWorker({}, req, VALID_RESOLVED)
  assert.equal(r, null)
})

test('A: env es undefined → null (defensivo)', async () => {
  const req = new Request('https://runtime.localhost/s/abc123def4')
  const r = await dispatchToBoxWorker(undefined, req, VALID_RESOLVED)
  assert.equal(r, null)
})

test('A: env.BOX_DISPATCH es falsy (null) → null', async () => {
  const req = new Request('https://runtime.localhost/s/abc123def4')
  const r = await dispatchToBoxWorker({ BOX_DISPATCH: null }, req, VALID_RESOLVED)
  assert.equal(r, null)
})

test('B: .get(name) tira "Worker not found." → null', async () => {
  const env = {
    BOX_DISPATCH: {
      get: () => { throw new Error('Worker not found.') },
    },
  }
  const req = new Request('https://runtime.localhost/s/abc123def4')
  const r = await dispatchToBoxWorker(env, req, VALID_RESOLVED)
  assert.equal(r, null)
})

test('B: .get(name) tira "Error: Worker \'box-abc\' not found." → null (variante con nombre)', async () => {
  const env = {
    BOX_DISPATCH: {
      get: () => { throw new Error(`Error: Worker 'box-${VALID_RESOLVED.boxId}' not found.`) },
    },
  }
  const req = new Request('https://runtime.localhost/s/abc123def4')
  const r = await dispatchToBoxWorker(env, req, VALID_RESOLVED)
  assert.equal(r, null)
})

test('C: .get(name) tira otro error → propaga (no se silencia)', async () => {
  const env = {
    BOX_DISPATCH: {
      get: () => { throw new TypeError('cannot read property X') },
    },
  }
  const req = new Request('https://runtime.localhost/s/abc123def4')
  await assert.rejects(
    () => dispatchToBoxWorker(env, req, VALID_RESOLVED),
    TypeError
  )
})

test('D: stub OK devuelve Response con los 4 headers de contexto', async () => {
  let receivedReq
  const stubWorker = {
    fetch: async (req) => {
      receivedReq = req
      return new Response('<html>from per-box</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    },
  }
  const env = {
    BOX_DISPATCH: {
      get: (name) => {
        assert.equal(name, `box-${VALID_RESOLVED.boxId}`)
        return stubWorker
      },
    },
  }
  const req = new Request('https://runtime.localhost/s/abc123def4', {
    headers: { Cookie: 'sid=abc', 'X-Custom': 'preserved' },
  })
  const r = await dispatchToBoxWorker(env, req, VALID_RESOLVED)
  assert.ok(r instanceof Response)
  assert.equal(await r.text(), '<html>from per-box</html>')
  assert.equal(receivedReq.headers.get(BOX_ID_HEADER), VALID_RESOLVED.boxId)
  assert.equal(receivedReq.headers.get(TENANT_HEADER), VALID_RESOLVED.tenantSlug)
  assert.equal(receivedReq.headers.get(SLUG_HEADER), VALID_RESOLVED.boxSlug)
  assert.equal(receivedReq.headers.get(VIS_HEADER), 'public')
  assert.equal(receivedReq.headers.get('Cookie'), 'sid=abc', 'otros headers preservados')
  assert.equal(receivedReq.headers.get('X-Custom'), 'preserved', 'custom headers preservados')
})

test('D: visibility default "private" si no se pasa en resolved', async () => {
  let receivedReq
  const env = {
    BOX_DISPATCH: {
      get: () => ({ fetch: async (req) => { receivedReq = req; return new Response('ok') } }),
    },
  }
  const req = new Request('https://runtime.localhost/s/abc')
  await dispatchToBoxWorker(env, req, {
    boxId: VALID_RESOLVED.boxId,
    tenantSlug: 'acme',
    boxSlug: 'cartera',
    // visibility omitido a propósito
  })
  assert.equal(receivedReq.headers.get(VIS_HEADER), 'private', 'default private')
})

test('E: .get(name) devuelve undefined → null (defensivo)', async () => {
  const env = {
    BOX_DISPATCH: { get: () => undefined },
  }
  const req = new Request('https://runtime.localhost/s/abc123def4')
  const r = await dispatchToBoxWorker(env, req, VALID_RESOLVED)
  assert.equal(r, null)
})

test('F: .fetch() tira "Worker not found" → null (carrera .get→.fetch)', async () => {
  const env = {
    BOX_DISPATCH: {
      get: () => ({
        fetch: async () => { throw new Error('Worker not found.') },
      }),
    },
  }
  const req = new Request('https://runtime.localhost/s/abc123def4')
  const r = await dispatchToBoxWorker(env, req, VALID_RESOLVED)
  assert.equal(r, null)
})

test('F: .fetch() tira otro error → propaga', async () => {
  const env = {
    BOX_DISPATCH: {
      get: () => ({
        fetch: async () => { throw new Error('Script threw an exception.') },
      }),
    },
  }
  const req = new Request('https://runtime.localhost/s/abc123def4')
  await assert.rejects(
    () => dispatchToBoxWorker(env, req, VALID_RESOLVED),
    /Script threw/
  )
})

// ============ withDispatchContext ============

test('withDispatchContext setea los 4 headers y preserva los demás', () => {
  const req = new Request('https://x/', { headers: { Cookie: 'sid=abc', 'X-Other': 'kept' } })
  const r = withDispatchContext(req, VALID_RESOLVED)
  assert.equal(r.headers.get(BOX_ID_HEADER), VALID_RESOLVED.boxId)
  assert.equal(r.headers.get(TENANT_HEADER), VALID_RESOLVED.tenantSlug)
  assert.equal(r.headers.get(SLUG_HEADER), VALID_RESOLVED.boxSlug)
  assert.equal(r.headers.get(VIS_HEADER), 'public')
  assert.equal(r.headers.get('Cookie'), 'sid=abc')
  assert.equal(r.headers.get('X-Other'), 'kept')
})

test('withDispatchContext preserva method y url', () => {
  const req = new Request('https://x.example/s/abc', { method: 'GET' })
  const r = withDispatchContext(req, VALID_RESOLVED)
  assert.equal(r.method, 'GET')
  assert.equal(r.url, 'https://x.example/s/abc')
})

test('withDispatchContext rechaza boxId inválido (defense-in-depth)', () => {
  const req = new Request('https://x/')
  assert.throws(() => withDispatchContext(req, { ...VALID_RESOLVED, boxId: 'corto' }), /boxId inválido/)
  assert.throws(() => withDispatchContext(req, { ...VALID_RESOLVED, boxId: 'CON_MAYUSCULAS' }), /boxId inválido/)
  assert.throws(() => withDispatchContext(req, { ...VALID_RESOLVED, boxId: 'abcdef_0123456789' }), /boxId inválido/)
  assert.throws(() => withDispatchContext(req, { ...VALID_RESOLVED, boxId: '' }), /boxId inválido/)
})

test('withDispatchContext pisa headers del cliente (overwrite defensivo)', () => {
  const req = new Request('https://x/', {
    headers: {
      [BOX_ID_HEADER]: 'spoofed_box_id',
      [TENANT_HEADER]: 'spoofed_tenant',
      [SLUG_HEADER]: 'spoofed_slug',
      [VIS_HEADER]: 'public',  // cliente podría intentar escalar
    },
  })
  const r = withDispatchContext(req, VALID_RESOLVED)
  assert.equal(r.headers.get(BOX_ID_HEADER), VALID_RESOLVED.boxId, 'boxId overwritten')
  assert.equal(r.headers.get(TENANT_HEADER), VALID_RESOLVED.tenantSlug, 'tenant overwritten')
  assert.equal(r.headers.get(SLUG_HEADER), VALID_RESOLVED.boxSlug, 'slug overwritten')
  assert.equal(r.headers.get(VIS_HEADER), 'public', 'visibility preserved (match)')
})

test('withDispatchContext: visibility "private" se pasa tal cual', () => {
  const req = new Request('https://x/')
  const r = withDispatchContext(req, { ...VALID_RESOLVED, visibility: 'private' })
  assert.equal(r.headers.get(VIS_HEADER), 'private')
})
