// __tests__/auth.test.js — controlPlaneHeaders, readSession, checkMembership
// (movidos a runtime-core desde runtime para reuso por el per-box script).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { controlPlaneHeaders, readSession, checkMembership } from '../src/auth.js'

function jsonRes(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...extraHeaders } })
}

// ============ controlPlaneHeaders ============

test('controlPlaneHeaders reenvía la cookie del request (la sesión se valida server-side)', () => {
  const req = new Request('https://x.example/', { headers: { Cookie: 'sid=abc; other=def' } })
  const env = { HTMLBOX_CONTROL_PLANE_ORIGIN: 'https://controlplane.example', HTMLBOX_INTERNAL_SECRET: 'sek' }
  const h = controlPlaneHeaders(env, req)
  assert.equal(h.get('Cookie'), 'sid=abc; other=def')
  assert.equal(h.get('X-HTMLBox-Internal-Secret'), 'sek')
})

test('controlPlaneHeaders omite Cookie si el request no trae ninguna', () => {
  const req = new Request('https://x.example/')
  const env = { HTMLBOX_CONTROL_PLANE_ORIGIN: 'https://controlplane.example' }
  const h = controlPlaneHeaders(env, req)
  assert.equal(h.get('Cookie'), null)
})

// ============ readSession ============

test('readSession devuelve null si no hay HTMLBOX_CONTROL_PLANE_ORIGIN', async () => {
  const out = await readSession({}, new Request('https://x.example/'))
  assert.equal(out, null)
})

test('readSession devuelve los datos del whoami si responde 200', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://controlplane.example/api/internal/whoami')
    return jsonRes({ userId: 'u1', tenantId: 't1', isPlatformOwner: false, role: 'editor' })
  }
  try {
    const sess = await readSession(
      { HTMLBOX_CONTROL_PLANE_ORIGIN: 'https://controlplane.example' },
      new Request('https://x.example/', { headers: { Cookie: 'sid=abc' } })
    )
    assert.equal(sess.userId, 'u1')
    assert.equal(sess.tenantId, 't1')
    assert.equal(sess.role, 'editor')
  } finally {
    globalThis.fetch = orig
  }
})

test('readSession devuelve null si whoami responde !=200', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async () => new Response('{}', { status: 401 })
  try {
    const sess = await readSession(
      { HTMLBOX_CONTROL_PLANE_ORIGIN: 'https://controlplane.example' },
      new Request('https://x.example/')
    )
    assert.equal(sess, null)
  } finally {
    globalThis.fetch = orig
  }
})

// ============ checkMembership ============

test('checkMembership: sin sesión devuelve { ok:false, error:"unauthenticated" }', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async () => new Response('{}', { status: 401 })
  try {
    const out = await checkMembership(
      { HTMLBOX_CONTROL_PLANE_ORIGIN: 'https://controlplane.example' },
      new Request('https://x.example/'),
      'abcdef0123456789'
    )
    assert.equal(out.ok, false)
    assert.equal(out.error, 'unauthenticated')
  } finally {
    globalThis.fetch = orig
  }
})

test('checkMembership: platform owner es owner sin chequear membership', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async () => jsonRes({ userId: 'po1', tenantId: null, isPlatformOwner: true })
  try {
    const out = await checkMembership(
      { HTMLBOX_CONTROL_PLANE_ORIGIN: 'https://controlplane.example' },
      new Request('https://x.example/'),
      'abcdef0123456789'
    )
    assert.equal(out.ok, true)
    assert.equal(out.role, 'owner')
    assert.equal(out.userId, 'po1')
  } finally {
    globalThis.fetch = orig
  }
})

test('checkMembership: con membership devuelve el role de control-plane', async () => {
  const orig = globalThis.fetch
  let calls = []
  globalThis.fetch = async (url) => {
    calls.push(url)
    if (url.endsWith('/api/internal/whoami')) return jsonRes({ userId: 'u7', isPlatformOwner: false })
    if (url.endsWith('/membership')) return jsonRes({ membership: { role: 'editor' } })
    throw new Error(`unexpected fetch ${url}`)
  }
  try {
    const out = await checkMembership(
      { HTMLBOX_CONTROL_PLANE_ORIGIN: 'https://controlplane.example' },
      new Request('https://x.example/'),
      'abcdef0123456789'
    )
    assert.equal(out.ok, true)
    assert.equal(out.role, 'editor')
    assert.equal(out.userId, 'u7')
    assert.equal(calls.length, 2)
  } finally {
    globalThis.fetch = orig
  }
})

test('checkMembership: si membership devuelve { membership: null } → forbidden', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (url.endsWith('/whoami')) return jsonRes({ userId: 'u8', isPlatformOwner: false })
    if (url.endsWith('/membership')) return jsonRes({ membership: null })
    throw new Error('unexpected')
  }
  try {
    const out = await checkMembership(
      { HTMLBOX_CONTROL_PLANE_ORIGIN: 'https://controlplane.example' },
      new Request('https://x.example/'),
      'abcdef0123456789'
    )
    assert.equal(out.ok, false)
    assert.equal(out.error, 'forbidden')
  } finally {
    globalThis.fetch = orig
  }
})
