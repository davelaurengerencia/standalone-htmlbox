// __tests__/boxDispatch.test.js — glue dispatcher-side (Phase 1 WFP scaffolding).
//
// Casos cubiertos:
//   A. env.BOX_DISPATCH ausente          → devuelve null (caller cae al path viejo)
//   B. .get(name) tira "Worker not found" → devuelve null
//   C. .get(name) tira otro error        → propaga (no se silencia)
//   D. Stub OK: devuelve Response         → devuelve esa Response
//                                            con el header X-HTMLBox-Box-Id seteado
//   E. .get(name) devuelve undefined     → null (defensivo)
//   F. .fetch() tira "Worker not found"  → null (carrera entre .get y .fetch)
//
// Plus: withBoxIdHeader (set header, valida boxId, preserva method y otros headers).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dispatchToBoxWorker, withBoxIdHeader } from '../src/lib/boxDispatch.js'

const VALID_BOX = 'abcdef0123456789'

// ============ dispatchToBoxWorker ============

test('A: env.BOX_DISPATCH ausente → null (caller cae al path viejo)', async () => {
  const req = new Request('https://runtime.localhost/s/abc123def4')
  const r = await dispatchToBoxWorker({}, req, { boxId: VALID_BOX })
  assert.equal(r, null)
})

test('A: env es undefined → null (defensivo)', async () => {
  const req = new Request('https://runtime.localhost/s/abc123def4')
  const r = await dispatchToBoxWorker(undefined, req, { boxId: VALID_BOX })
  assert.equal(r, null)
})

test('A: env.BOX_DISPATCH es falsy (null) → null', async () => {
  const req = new Request('https://runtime.localhost/s/abc123def4')
  const r = await dispatchToBoxWorker({ BOX_DISPATCH: null }, req, { boxId: VALID_BOX })
  assert.equal(r, null)
})

test('B: .get(name) tira "Worker not found." → null', async () => {
  const env = {
    BOX_DISPATCH: {
      get: () => { throw new Error('Worker not found.') },
    },
  }
  const req = new Request('https://runtime.localhost/s/abc123def4')
  const r = await dispatchToBoxWorker(env, req, { boxId: VALID_BOX })
  assert.equal(r, null)
})

test('B: .get(name) tira "Error: Worker \'box-abc\' not found." → null (variante con nombre)', async () => {
  const env = {
    BOX_DISPATCH: {
      get: () => { throw new Error(`Error: Worker 'box-${VALID_BOX}' not found.`) },
    },
  }
  const req = new Request('https://runtime.localhost/s/abc123def4')
  const r = await dispatchToBoxWorker(env, req, { boxId: VALID_BOX })
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
    () => dispatchToBoxWorker(env, req, { boxId: VALID_BOX }),
    TypeError
  )
})

test('D: stub OK devuelve Response con X-HTMLBox-Box-Id header', async () => {
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
        assert.equal(name, `box-${VALID_BOX}`)
        return stubWorker
      },
    },
  }
  const req = new Request('https://runtime.localhost/s/abc123def4', {
    headers: { Cookie: 'sid=abc', 'X-Custom': 'preserved' },
  })
  const r = await dispatchToBoxWorker(env, req, { boxId: VALID_BOX })
  assert.ok(r instanceof Response)
  assert.equal(await r.text(), '<html>from per-box</html>')
  assert.equal(receivedReq.headers.get(BOX_ID_HEADER_NAME), VALID_BOX)
  assert.equal(receivedReq.headers.get('Cookie'), 'sid=abc', 'otros headers preservados')
  assert.equal(receivedReq.headers.get('X-Custom'), 'preserved', 'custom headers preservados')
})

test('E: .get(name) devuelve undefined → null (defensivo)', async () => {
  const env = {
    BOX_DISPATCH: { get: () => undefined },
  }
  const req = new Request('https://runtime.localhost/s/abc123def4')
  const r = await dispatchToBoxWorker(env, req, { boxId: VALID_BOX })
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
  const r = await dispatchToBoxWorker(env, req, { boxId: VALID_BOX })
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
    () => dispatchToBoxWorker(env, req, { boxId: VALID_BOX }),
    /Script threw/
  )
})

// ============ withBoxIdHeader ============

test('withBoxIdHeader setea X-HTMLBox-Box-Id y preserva otros headers', () => {
  const req = new Request('https://x/', { headers: { Cookie: 'sid=abc', 'X-Other': 'kept' } })
  const r = withBoxIdHeader(req, VALID_BOX)
  assert.equal(r.headers.get(BOX_ID_HEADER_NAME), VALID_BOX)
  assert.equal(r.headers.get('Cookie'), 'sid=abc')
  assert.equal(r.headers.get('X-Other'), 'kept')
})

test('withBoxIdHeader preserva method y url', () => {
  const req = new Request('https://x.example/s/abc', { method: 'GET' })
  const r = withBoxIdHeader(req, VALID_BOX)
  assert.equal(r.method, 'GET')
  assert.equal(r.url, 'https://x.example/s/abc')
})

test('withBoxIdHeader rechaza boxId inválido (defense-in-depth)', () => {
  const req = new Request('https://x/')
  assert.throws(() => withBoxIdHeader(req, 'corto'), /boxId inválido/)
  assert.throws(() => withBoxIdHeader(req, 'CON_MAYUSCULAS'), /boxId inválido/)
  assert.throws(() => withBoxIdHeader(req, 'abcdef_0123456789'), /boxId inválido/)
  assert.throws(() => withBoxIdHeader(req, ''), /boxId inválido/)
})

test('withBoxIdHeader setea X-HTMLBox-Box-Id incluso si el request ya lo tenía (overwrite)', () => {
  // Defense-in-depth: si el cliente manda X-HTMLBox-Box-Id por su cuenta,
  // el dispatcher pisa con el valor resuelto del resolver (server-side).
  const req = new Request('https://x/', { headers: { [BOX_ID_HEADER_NAME]: 'spoofed' } })
  const r = withBoxIdHeader(req, VALID_BOX)
  assert.equal(r.headers.get(BOX_ID_HEADER_NAME), VALID_BOX, 'overwrite cliente')
})

// Constante expuesta por runtime-core; la referenciamos acá para no acoplar
// al string literal 'X-HTMLBox-Box-Id' en los asserts (un rename del header
// rompería los tests acá si no).
const BOX_ID_HEADER_NAME = 'X-HTMLBox-Box-Id'
