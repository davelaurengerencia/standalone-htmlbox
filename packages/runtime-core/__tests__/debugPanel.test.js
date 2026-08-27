// __tests__/debugPanel.test.js — gate server-side del panel de debug.
// Las dos condiciones son necesarias: ?hbx_debug=1 + rol owner/editor en ESE box.
// NUNCA confiar en el query param solo (CSS-hide de botón NO es seguridad real).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldShowDebugPanel } from '../src/debugPanel.js'

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// 1. Gate trivial: si no hay ?hbx_debug=1 → false, sin importar la sesión.
test('shouldShowDebugPanel devuelve false si falta ?hbx_debug=1 (sin gastar round-trip)', async () => {
  const orig = globalThis.fetch
  let called = false
  globalThis.fetch = async () => { called = true; return jsonRes({}) }
  try {
    const url = new URL('https://acme.example/cartera')
    const req = new Request(url)
    const out = await shouldShowDebugPanel(
      { HTMLBOX_CONTROL_PLANE_ORIGIN: 'https://cp.example' },
      req, url, 'abcdef0123456789'
    )
    assert.equal(out, false)
    assert.equal(called, false, 'no debe llamar a control-plane si no hay flag')
  } finally {
    globalThis.fetch = orig
  }
})

// 2. Con flag presente pero SIN sesión → false (y todavía gasta 1 round-trip).
test('shouldShowDebugPanel devuelve false si no hay sesión, aunque esté el flag', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async () => new Response('{}', { status: 401 })
  try {
    const url = new URL('https://acme.example/cartera?hbx_debug=1')
    const out = await shouldShowDebugPanel(
      { HTMLBOX_CONTROL_PLANE_ORIGIN: 'https://cp.example' },
      new Request(url), url, 'abcdef0123456789'
    )
    assert.equal(out, false)
  } finally {
    globalThis.fetch = orig
  }
})

// 3. Flag + sesión con rol viewer → false.
test('shouldShowDebugPanel devuelve false para rol viewer (NO debe filtrar)', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (url.endsWith('/whoami')) return jsonRes({ userId: 'u1', isPlatformOwner: false })
    if (url.endsWith('/membership')) return jsonRes({ membership: { role: 'viewer' } })
    throw new Error('unexpected')
  }
  try {
    const url = new URL('https://acme.example/cartera?hbx_debug=1')
    const out = await shouldShowDebugPanel(
      { HTMLBOX_CONTROL_PLANE_ORIGIN: 'https://cp.example' },
      new Request(url), url, 'abcdef0123456789'
    )
    assert.equal(out, false)
  } finally {
    globalThis.fetch = orig
  }
})

// 4. Flag + sesión owner → true.
test('shouldShowDebugPanel devuelve true para platform owner sin chequear membership', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async () => jsonRes({ userId: 'po', isPlatformOwner: true })
  try {
    const url = new URL('https://acme.example/cartera?hbx_debug=1')
    const out = await shouldShowDebugPanel(
      { HTMLBOX_CONTROL_PLANE_ORIGIN: 'https://cp.example' },
      new Request(url), url, 'abcdef0123456789'
    )
    assert.equal(out, true)
  } finally {
    globalThis.fetch = orig
  }
})

// 5. Flag + sesión editor → true.
test('shouldShowDebugPanel devuelve true para editor del box', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (url.endsWith('/whoami')) return jsonRes({ userId: 'u2', isPlatformOwner: false })
    if (url.endsWith('/membership')) return jsonRes({ membership: { role: 'editor' } })
    throw new Error('unexpected')
  }
  try {
    const url = new URL('https://acme.example/cartera?hbx_debug=1')
    const out = await shouldShowDebugPanel(
      { HTMLBOX_CONTROL_PLANE_ORIGIN: 'https://cp.example' },
      new Request(url), url, 'abcdef0123456789'
    )
    assert.equal(out, true)
  } finally {
    globalThis.fetch = orig
  }
})

// 6. Defense-in-depth: si control-plane devuelve membership:{role:null}, NO entra.
test('shouldShowDebugPanel devuelve false si role viene null (defensa en profundidad)', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (url.endsWith('/whoami')) return jsonRes({ userId: 'u3', isPlatformOwner: false })
    if (url.endsWith('/membership')) return jsonRes({ membership: { role: null } })
    throw new Error('unexpected')
  }
  try {
    const url = new URL('https://acme.example/cartera?hbx_debug=1')
    const out = await shouldShowDebugPanel(
      { HTMLBOX_CONTROL_PLANE_ORIGIN: 'https://cp.example' },
      new Request(url), url, 'abcdef0123456789'
    )
    assert.equal(out, false)
  } finally {
    globalThis.fetch = orig
  }
})
