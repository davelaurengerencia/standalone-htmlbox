// __tests__/wfpDeployer.test.js — REST PUT al namespace WFP, sin red real.
//
// Mockeamos globalThis.fetch para capturar la request y validar:
//   - URL exacta (account/namespace/script)
//   - Authorization Bearer con token del env
//   - Body shape: metadata.main_module, bindings, files[].type, files[].content es base64
//   - bundle source está embebido en el base64
//   - Mapeo de errores (4xx/5xx → throw con status + body)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deployBoxWorker, _internal } from '../lib/wfpDeployer.js'

const ACCOUNT_ID = 'bbd6bb71e68887eb0fa9cc8e872ed588'
const NAMESPACE = 'htmlbox-boxes'
const VALID_BOX = 'abcdef0123456789'

// Stub mínimo de bundle — el wrapper real mide ~4 KB pero para tests
// alcanza con verificar que el source viaja intacto al base64.
const STUB_BUNDLE = '// stub per-box worker\nexport default { fetch() { return new Response("ok") } }\n'

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// ============ Validación de inputs ============

test('deployBoxWorker rechaza boxId inválido antes de gastar PUT', async () => {
  await assert.rejects(
    () => deployBoxWorker(
      { WFP_DEPLOY_TOKEN: 't' },
      ACCOUNT_ID, NAMESPACE, 'corto',
      { bundleSource: STUB_BUNDLE }
    ),
    /boxId inválido/
  )
})

test('deployBoxWorker rechaza namespace inválido antes de gastar PUT', async () => {
  await assert.rejects(
    () => deployBoxWorker(
      { WFP_DEPLOY_TOKEN: 't' },
      ACCOUNT_ID, 'INVALID UPPERCASE', VALID_BOX,
      { bundleSource: STUB_BUNDLE }
    ),
    /namespace inválido/
  )
})

test('deployBoxWorker rechaza si WFP_DEPLOY_TOKEN no está en env', async () => {
  await assert.rejects(
    () => deployBoxWorker({}, ACCOUNT_ID, NAMESPACE, VALID_BOX, { bundleSource: STUB_BUNDLE }),
    /WFP_DEPLOY_TOKEN no configurado/
  )
})

// ============ Validación del PUT ============

test('deployBoxWorker hace PUT al endpoint correcto con auth Bearer', async () => {
  const orig = globalThis.fetch
  let capturedUrl, capturedInit
  globalThis.fetch = async (url, init) => {
    capturedUrl = url
    capturedInit = init
    return jsonRes({ success: true })
  }
  try {
    await deployBoxWorker(
      { WFP_DEPLOY_TOKEN: 'tok-abc-123' },
      ACCOUNT_ID, NAMESPACE, VALID_BOX,
      { bundleSource: STUB_BUNDLE }
    )
    assert.equal(capturedUrl, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces/${NAMESPACE}/scripts/box-${VALID_BOX}`)
    assert.equal(capturedInit.method, 'PUT')
    assert.match(capturedInit.headers.Authorization, /^Bearer tok-abc-123$/)
    assert.equal(capturedInit.headers['Content-Type'], 'application/json')
  } finally {
    globalThis.fetch = orig
  }
})

test('deployBoxWorker: body metadata.main_module = "box-worker.mjs"', async () => {
  const orig = globalThis.fetch
  let capturedBody
  globalThis.fetch = async (url, init) => {
    capturedBody = JSON.parse(init.body)
    return jsonRes({ success: true })
  }
  try {
    await deployBoxWorker(
      { WFP_DEPLOY_TOKEN: 't' },
      ACCOUNT_ID, NAMESPACE, VALID_BOX,
      { bundleSource: STUB_BUNDLE }
    )
    assert.equal(capturedBody.metadata.main_module, 'box-worker.mjs')
  } finally {
    globalThis.fetch = orig
  }
})

test('deployBoxWorker: bindings incluye BUCKET (R2) y HTMLBOX_CONTROL_PLANE_ORIGIN', async () => {
  const orig = globalThis.fetch
  let capturedBody
  globalThis.fetch = async (url, init) => {
    capturedBody = JSON.parse(init.body)
    return jsonRes({ success: true })
  }
  try {
    await deployBoxWorker(
      {
        WFP_DEPLOY_TOKEN: 't',
        HTMLBOX_R2_BUCKET_NAME: 'htmlbox-content',
        HTMLBOX_PUBLIC_ORIGIN: 'https://controlplane.htmlbox.dev',
      },
      ACCOUNT_ID, NAMESPACE, VALID_BOX,
      { bundleSource: STUB_BUNDLE }
    )
    const bindings = capturedBody.metadata.bindings
    const r2 = bindings.find(b => b.name === 'BUCKET')
    const origin = bindings.find(b => b.name === 'HTMLBOX_CONTROL_PLANE_ORIGIN')
    assert.ok(r2, 'BUCKET binding presente')
    assert.equal(r2.type, 'r2_bucket')
    assert.equal(r2.bucket_name, 'htmlbox-content')
    assert.ok(origin, 'origin binding presente')
    assert.equal(origin.type, 'plain_text')
    assert.equal(origin.text, 'https://controlplane.htmlbox.dev')
  } finally {
    globalThis.fetch = orig
  }
})

test('deployBoxWorker: file content es base64 válido del bundle source', async () => {
  const orig = globalThis.fetch
  let capturedBody
  globalThis.fetch = async (url, init) => {
    capturedBody = JSON.parse(init.body)
    return jsonRes({ success: true })
  }
  try {
    await deployBoxWorker(
      { WFP_DEPLOY_TOKEN: 't' },
      ACCOUNT_ID, NAMESPACE, VALID_BOX,
      { bundleSource: STUB_BUNDLE }
    )
    const file = capturedBody.files[0]
    assert.equal(file.name, 'box-worker.mjs')
    assert.equal(file.type, 'application/javascript+module')
    // Decodificar base64 y verificar que matchea el source original.
    const decoded = atob(file.content)
    assert.equal(decoded, STUB_BUNDLE, 'base64 round-trip preserva el bundle')
  } finally {
    globalThis.fetch = orig
  }
})

test('deployBoxWorker: compatibility_date default = 2026-08-01', async () => {
  const orig = globalThis.fetch
  let capturedBody
  globalThis.fetch = async (url, init) => {
    capturedBody = JSON.parse(init.body)
    return jsonRes({ success: true })
  }
  try {
    await deployBoxWorker(
      { WFP_DEPLOY_TOKEN: 't' },
      ACCOUNT_ID, NAMESPACE, VALID_BOX,
      { bundleSource: STUB_BUNDLE }
    )
    assert.equal(capturedBody.metadata.compatibility_date, '2026-08-01')
    assert.deepEqual(capturedBody.metadata.compatibility_flags, ['nodejs_compat'])
  } finally {
    globalThis.fetch = orig
  }
})

test('deployBoxWorker: compatibility_date override desde env', async () => {
  const orig = globalThis.fetch
  let capturedBody
  globalThis.fetch = async (url, init) => {
    capturedBody = JSON.parse(init.body)
    return jsonRes({ success: true })
  }
  try {
    await deployBoxWorker(
      { WFP_DEPLOY_TOKEN: 't', HTMLBOX_WFP_COMPAT_DATE: '2027-01-01' },
      ACCOUNT_ID, NAMESPACE, VALID_BOX,
      { bundleSource: STUB_BUNDLE }
    )
    assert.equal(capturedBody.metadata.compatibility_date, '2027-01-01')
  } finally {
    globalThis.fetch = orig
  }
})

test('deployBoxWorker: HTMLBOX_PUBLIC_ORIGIN fallback a HTMLBOX_RUNTIME_ORIGIN', async () => {
  const orig = globalThis.fetch
  let capturedBody
  globalThis.fetch = async (url, init) => {
    capturedBody = JSON.parse(init.body)
    return jsonRes({ success: true })
  }
  try {
    await deployBoxWorker(
      { WFP_DEPLOY_TOKEN: 't', HTMLBOX_RUNTIME_ORIGIN: 'https://runtime.htmlbox.dev' },
      ACCOUNT_ID, NAMESPACE, VALID_BOX,
      { bundleSource: STUB_BUNDLE }
    )
    const origin = capturedBody.metadata.bindings.find(b => b.name === 'HTMLBOX_CONTROL_PLANE_ORIGIN')
    assert.equal(origin.text, 'https://runtime.htmlbox.dev', 'fallback a RUNTIME_ORIGIN')
  } finally {
    globalThis.fetch = orig
  }
})

// ============ Errores ============

test('deployBoxWorker: error 4xx de Cloudflare → throw con status', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async () => jsonRes({ errors: [{ message: 'Invalid token' }] }, 403)
  try {
    await assert.rejects(
      () => deployBoxWorker(
        { WFP_DEPLOY_TOKEN: 'bad-token' },
        ACCOUNT_ID, NAMESPACE, VALID_BOX,
        { bundleSource: STUB_BUNDLE }
      ),
      /Cloudflare respondió 403/
    )
  } finally {
    globalThis.fetch = orig
  }
})

test('deployBoxWorker: error 5xx de Cloudflare → throw con status', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async () => jsonRes({ errors: [{ message: 'Server error' }] }, 500)
  try {
    await assert.rejects(
      () => deployBoxWorker(
        { WFP_DEPLOY_TOKEN: 't' },
        ACCOUNT_ID, NAMESPACE, VALID_BOX,
        { bundleSource: STUB_BUNDLE }
      ),
      /Cloudflare respondió 500/
    )
  } finally {
    globalThis.fetch = orig
  }
})

test('deployBoxWorker: error body se incluye en el mensaje (primeros 500 chars)', async () => {
  const orig = globalThis.fetch
  const longBody = 'X'.repeat(1000)
  globalThis.fetch = async () => new Response(longBody, { status: 502 })
  try {
    await assert.rejects(
      () => deployBoxWorker(
        { WFP_DEPLOY_TOKEN: 't' },
        ACCOUNT_ID, NAMESPACE, VALID_BOX,
        { bundleSource: STUB_BUNDLE }
      ),
      (err) => {
        // El mensaje trunca a 500 chars del body + headers
        assert.match(err.message, /Cloudflare respondió 502/)
        assert.match(err.message, /X{500}/, 'primeros 500 X del body')
        assert.doesNotMatch(err.message, /X{600}/, 'no debería incluir los 1000 chars completos')
        return true
      }
    )
  } finally {
    globalThis.fetch = orig
  }
})

test('deployBoxWorker happy path devuelve { ok: true, scriptName }', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async () => jsonRes({ success: true, result: { script: 'ok' } })
  try {
    const out = await deployBoxWorker(
      { WFP_DEPLOY_TOKEN: 't' },
      ACCOUNT_ID, NAMESPACE, VALID_BOX,
      { bundleSource: STUB_BUNDLE }
    )
    assert.deepEqual(out, { ok: true, scriptName: `box-${VALID_BOX}` })
  } finally {
    globalThis.fetch = orig
  }
})

// ============ _internal helpers ============

test('_internal.bundleSourceToBase64 round-trip preserva contenido (UTF-8 correcto)', () => {
  const src = 'hola ñandú 中文 🚀\n'
  const b64 = _internal.bundleSourceToBase64(src)
  // El round-trip es: src (string UTF-8) → TextEncoder.encode (bytes UTF-8)
  // → string Latin-1 → btoa (base64). Al revés: atob (Latin-1 string) →
  // TextDecoder (string UTF-8).
  const latin1 = atob(b64)
  const bytes = new Uint8Array(latin1.length)
  for (let i = 0; i < latin1.length; i++) bytes[i] = latin1.charCodeAt(i)
  const decoded = new TextDecoder().decode(bytes)
  assert.equal(decoded, src)
})

test('_internal.bundleSourceToBase64 maneja strings largos', () => {
  const src = 'X'.repeat(8000)
  const b64 = _internal.bundleSourceToBase64(src)
  const latin1 = atob(b64)
  assert.equal(latin1.length, 8000, 'Latin-1 string debe tener 1 char por byte')
  assert.match(latin1, /^X+$/, 'Latin-1 puro preserva bytes')
})

test('_internal.buildBindings default sin HTMLBOX_PUBLIC_ORIGIN → texto vacío', () => {
  const b = _internal.buildBindings({})
  const origin = b.find(x => x.name === 'HTMLBOX_CONTROL_PLANE_ORIGIN')
  assert.equal(origin.text, '')
})
