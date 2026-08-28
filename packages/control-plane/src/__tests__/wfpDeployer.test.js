// __tests__/wfpDeployer.test.js — REST PUT al namespace WFP, sin red real.
//
// Mockeamos globalThis.fetch para capturar la request y validar:
//   - URL exacta (account/namespace/script)
//   - Authorization Bearer con token del env
//   - Body multipart/form-data con parts 'metadata' (JSON) y 'box-worker.mjs'
//   - Errores 4xx/5xx → throw con status + body
//
// 2026-05-05: Cloudflare cambió la API. El approach viejo de JSON envuelto
// con files[].content base64 ya NO funciona — devuelve 415. Ahora hay
// que usar multipart/form-data con la metadata como Blob JSON y el
// archivo como Blob con content-type application/javascript+module.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deployBoxWorker, deleteBoxWorker, _internal } from '../lib/wfpDeployer.js'

const ACCOUNT_ID = 'bbd6bb71e68887eb0fa9cc8e872ed588'
const NAMESPACE = 'htmlbox-boxes'
const VALID_BOX = 'abcdef0123456789'

const STUB_BUNDLE = '// stub per-box worker\nexport default { fetch() { return new Response("ok") } }\n'

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// Lee los parts de un FormData. Útil para validar metadata + archivo.
async function readForm(form) {
  const parts = {}
  for (const [name, value] of form.entries()) {
    if (value instanceof Blob) {
      parts[name] = {
        type: value.type,
        size: value.size,
        text: await value.text(),
      }
    } else {
      parts[name] = String(value)
    }
  }
  return parts
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

// ============ Validación del PUT multipart ============

test('deployBoxWorker: URL exacta + Authorization Bearer', async () => {
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
    // Importante: NO Content-Type explícito — fetch lo calcula del FormData.
    assert.equal(capturedInit.headers['Content-Type'], undefined, 'fetch debe calcular el Content-Type del boundary')
  } finally {
    globalThis.fetch = orig
  }
})

test('deployBoxWorker: body es multipart con parts "metadata" y "box-{boxId}.mjs"', async () => {
  const orig = globalThis.fetch
  let capturedInit
  globalThis.fetch = async (url, init) => {
    capturedInit = init
    return jsonRes({ success: true })
  }
  try {
    await deployBoxWorker(
      { WFP_DEPLOY_TOKEN: 't' },
      ACCOUNT_ID, NAMESPACE, VALID_BOX,
      { bundleSource: STUB_BUNDLE }
    )
    assert.ok(capturedInit.body instanceof FormData, 'body debe ser FormData')
    const parts = await readForm(capturedInit.body)
    assert.ok(parts.metadata, 'debe tener part "metadata"')
    assert.ok(parts[`box-${VALID_BOX}.mjs`], `debe tener part "box-${VALID_BOX}.mjs"`)
  } finally {
    globalThis.fetch = orig
  }
})

test('deployBoxWorker: metadata JSON tiene main_module + bindings + compat', async () => {
  const orig = globalThis.fetch
  let capturedInit
  globalThis.fetch = async (url, init) => {
    capturedInit = init
    return jsonRes({ success: true })
  }
  try {
    await deployBoxWorker(
      {
        WFP_DEPLOY_TOKEN: 't',
        HTMLBOX_R2_BUCKET_NAME: 'htmlbox-content',
        HTMLBOX_PUBLIC_ORIGIN: 'https://controlplane.sivocloud.dev',
      },
      ACCOUNT_ID, NAMESPACE, VALID_BOX,
      { bundleSource: STUB_BUNDLE }
    )
    const parts = await readForm(capturedInit.body)
    assert.equal(parts.metadata.type, 'application/json')
    const meta = JSON.parse(parts.metadata.text)
    assert.equal(meta.main_module, 'box-abcdef0123456789.mjs')
    const r2 = meta.bindings.find(b => b.name === 'BUCKET')
    const origin = meta.bindings.find(b => b.name === 'HTMLBOX_CONTROL_PLANE_ORIGIN')
    assert.ok(r2, 'BUCKET binding presente')
    assert.equal(r2.type, 'r2_bucket')
    assert.equal(r2.bucket_name, 'htmlbox-content')
    assert.ok(origin, 'origin binding presente')
    assert.equal(origin.type, 'plain_text')
    assert.equal(origin.text, 'https://controlplane.sivocloud.dev')
    assert.equal(meta.compatibility_date, '2026-08-01')
    assert.deepEqual(meta.compatibility_flags, ['nodejs_compat'])
  } finally {
    globalThis.fetch = orig
  }
})

test('deployBoxWorker: part "box-{boxId}.mjs" tiene content-type application/javascript+module', async () => {
  const orig = globalThis.fetch
  let capturedInit
  globalThis.fetch = async (url, init) => {
    capturedInit = init
    return jsonRes({ success: true })
  }
  try {
    await deployBoxWorker(
      { WFP_DEPLOY_TOKEN: 't' },
      ACCOUNT_ID, NAMESPACE, VALID_BOX,
      { bundleSource: STUB_BUNDLE }
    )
    const parts = await readForm(capturedInit.body)
    const fileKey = `box-${VALID_BOX}.mjs`
    assert.equal(parts[fileKey].type, 'application/javascript+module')
    assert.equal(parts[fileKey].size, STUB_BUNDLE.length)
    assert.equal(parts[fileKey].text, STUB_BUNDLE, 'contenido del bundle preservado')
  } finally {
    globalThis.fetch = orig
  }
})

test('deployBoxWorker: compatibility_date override desde env', async () => {
  const orig = globalThis.fetch
  let capturedInit
  globalThis.fetch = async (url, init) => {
    capturedInit = init
    return jsonRes({ success: true })
  }
  try {
    await deployBoxWorker(
      { WFP_DEPLOY_TOKEN: 't', HTMLBOX_WFP_COMPAT_DATE: '2027-01-01' },
      ACCOUNT_ID, NAMESPACE, VALID_BOX,
      { bundleSource: STUB_BUNDLE }
    )
    const parts = await readForm(capturedInit.body)
    const meta = JSON.parse(parts.metadata.text)
    assert.equal(meta.compatibility_date, '2027-01-01')
  } finally {
    globalThis.fetch = orig
  }
})

test('deployBoxWorker: HTMLBOX_PUBLIC_ORIGIN fallback a HTMLBOX_RUNTIME_ORIGIN', async () => {
  const orig = globalThis.fetch
  let capturedInit
  globalThis.fetch = async (url, init) => {
    capturedInit = init
    return jsonRes({ success: true })
  }
  try {
    await deployBoxWorker(
      { WFP_DEPLOY_TOKEN: 't', HTMLBOX_RUNTIME_ORIGIN: 'https://runtime.sivocloud.dev' },
      ACCOUNT_ID, NAMESPACE, VALID_BOX,
      { bundleSource: STUB_BUNDLE }
    )
    const parts = await readForm(capturedInit.body)
    const meta = JSON.parse(parts.metadata.text)
    const origin = meta.bindings.find(b => b.name === 'HTMLBOX_CONTROL_PLANE_ORIGIN')
    assert.equal(origin.text, 'https://runtime.sivocloud.dev', 'fallback a RUNTIME_ORIGIN')
  } finally {
    globalThis.fetch = orig
  }
})

// ============ Tags de metadata (legibilidad en dashboard) ============

test('deployBoxWorker: metadata incluye tags cuando se pasan (happy path)', async () => {
  const orig = globalThis.fetch
  let capturedInit
  globalThis.fetch = async (url, init) => {
    capturedInit = init
    return jsonRes({ success: true })
  }
  try {
    await deployBoxWorker(
      { WFP_DEPLOY_TOKEN: 't' },
      ACCOUNT_ID, NAMESPACE, VALID_BOX,
      {
        bundleSource: STUB_BUNDLE,
        tags: [
          'tenant:david',
          'box:mi-dashboard',
          'tenant-id:abc123',
          'box-id:abcdef0123456789',
          'visibility:public',
          'template:empty',
        ],
      }
    )
    const parts = await readForm(capturedInit.body)
    const meta = JSON.parse(parts.metadata.text)
    assert.deepEqual(meta.tags, [
      'tenant:david',
      'box:mi-dashboard',
      'tenant-id:abc123',
      'box-id:abcdef0123456789',
      'visibility:public',
      'template:empty',
    ])
  } finally {
    globalThis.fetch = orig
  }
})

test('deployBoxWorker: omite campo "tags" del metadata cuando no se pasan (backwards compat)', async () => {
  const orig = globalThis.fetch
  let capturedInit
  globalThis.fetch = async (url, init) => {
    capturedInit = init
    return jsonRes({ success: true })
  }
  try {
    await deployBoxWorker(
      { WFP_DEPLOY_TOKEN: 't' },
      ACCOUNT_ID, NAMESPACE, VALID_BOX,
      { bundleSource: STUB_BUNDLE }  // sin tags
    )
    const parts = await readForm(capturedInit.body)
    const meta = JSON.parse(parts.metadata.text)
    assert.equal(meta.tags, undefined, 'tags debe estar ausente cuando no se pasan')
  } finally {
    globalThis.fetch = orig
  }
})

test('deployBoxWorker: omite campo "tags" del metadata cuando se pasa array vacío', async () => {
  const orig = globalThis.fetch
  let capturedInit
  globalThis.fetch = async (url, init) => {
    capturedInit = init
    return jsonRes({ success: true })
  }
  try {
    await deployBoxWorker(
      { WFP_DEPLOY_TOKEN: 't' },
      ACCOUNT_ID, NAMESPACE, VALID_BOX,
      { bundleSource: STUB_BUNDLE, tags: [] }
    )
    const parts = await readForm(capturedInit.body)
    const meta = JSON.parse(parts.metadata.text)
    assert.equal(meta.tags, undefined, 'tags=[] se trata como "no tags"')
  } finally {
    globalThis.fetch = orig
  }
})

test('deployBoxWorker: falla con mensaje claro si una tag excede 64 chars', async () => {
  const longTag = 'a'.repeat(65)
  await assert.rejects(
    () => deployBoxWorker(
      { WFP_DEPLOY_TOKEN: 't' },
      ACCOUNT_ID, NAMESPACE, VALID_BOX,
      { bundleSource: STUB_BUNDLE, tags: ['tenant:ok', longTag] }
    ),
    /tags\[1\] excede 64 chars/
  )
})

test('deployBoxWorker: falla si se pasan más de 32 tags', async () => {
  const tags = Array.from({ length: 33 }, (_, i) => `t${i}`)
  await assert.rejects(
    () => deployBoxWorker(
      { WFP_DEPLOY_TOKEN: 't' },
      ACCOUNT_ID, NAMESPACE, VALID_BOX,
      { bundleSource: STUB_BUNDLE, tags }
    ),
    /tags excede el máximo \(33 > 32\)/
  )
})

test('deployBoxWorker: falla si una tag tiene caracteres fuera de [a-zA-Z0-9_:.-]', async () => {
  await assert.rejects(
    () => deployBoxWorker(
      { WFP_DEPLOY_TOKEN: 't' },
      ACCOUNT_ID, NAMESPACE, VALID_BOX,
      { bundleSource: STUB_BUNDLE, tags: ['tenant ok', 'box:ok'] }  // espacio inválido
    ),
    /tags\[0\] "tenant ok" tiene caracteres fuera de \[a-zA-Z0-9_:.\-\]/
  )
})

test('deployBoxWorker: falla si una tag está vacía', async () => {
  await assert.rejects(
    () => deployBoxWorker(
      { WFP_DEPLOY_TOKEN: 't' },
      ACCOUNT_ID, NAMESPACE, VALID_BOX,
      { bundleSource: STUB_BUNDLE, tags: ['tenant:ok', ''] }
    ),
    /tags\[1\] está vacía/
  )
})

test('deployBoxWorker: falla si tags no es array', async () => {
  await assert.rejects(
    () => deployBoxWorker(
      { WFP_DEPLOY_TOKEN: 't' },
      ACCOUNT_ID, NAMESPACE, VALID_BOX,
      { bundleSource: STUB_BUNDLE, tags: 'tenant:ok' }  // string, no array
    ),
    /tags debe ser array/
  )
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

test('deployBoxWorker: error body se trunca a 500 chars', async () => {
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
        assert.match(err.message, /Cloudflare respondió 502/)
        assert.match(err.message, /X{500}/, 'primeros 500 X del body')
        assert.doesNotMatch(err.message, /X{600}/, 'no debería incluir los 1000 chars')
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

// ============ deleteBoxWorker ============

test('deleteBoxWorker happy path (200) → { ok: true }', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async () => jsonRes({ success: true })
  try {
    const out = await deleteBoxWorker({ WFP_DEPLOY_TOKEN: 't' }, ACCOUNT_ID, NAMESPACE, VALID_BOX)
    assert.deepEqual(out, { ok: true })
  } finally {
    globalThis.fetch = orig
  }
})

test('deleteBoxWorker: 404 (script no existe) → { ok: true, idempotent: true }', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async () => jsonRes({ errors: [{ message: 'script not found' }] }, 404)
  try {
    const out = await deleteBoxWorker({ WFP_DEPLOY_TOKEN: 't' }, ACCOUNT_ID, NAMESPACE, VALID_BOX)
    assert.deepEqual(out, { ok: true, idempotent: true })
  } finally {
    globalThis.fetch = orig
  }
})

test('deleteBoxWorker: error 5xx → throw', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async () => jsonRes({ errors: [{ message: 'fail' }] }, 503)
  try {
    await assert.rejects(
      () => deleteBoxWorker({ WFP_DEPLOY_TOKEN: 't' }, ACCOUNT_ID, NAMESPACE, VALID_BOX),
      /Cloudflare respondió 503/
    )
  } finally {
    globalThis.fetch = orig
  }
})

test('deleteBoxWorker: valida boxId antes de gastar DELETE', async () => {
  await assert.rejects(
    () => deleteBoxWorker({ WFP_DEPLOY_TOKEN: 't' }, ACCOUNT_ID, NAMESPACE, 'corto'),
    /boxId inválido/
  )
})

// ============ _internal helpers ============

test('_internal.buildBindings default sin HTMLBOX_PUBLIC_ORIGIN → texto vacío', () => {
  const b = _internal.buildBindings({})
  const origin = b.find(x => x.name === 'HTMLBOX_CONTROL_PLANE_ORIGIN')
  assert.equal(origin.text, '')
})

test('_internal.buildMetadataJson devuelve JSON parseable con main_module esperado', () => {
  const json = _internal.buildMetadataJson({ HTMLBOX_RUNTIME_ORIGIN: 'https://r.example' }, 'box-abc.mjs')
  const meta = JSON.parse(json)
  assert.equal(meta.main_module, 'box-abc.mjs')
})

test('_internal.buildMetadataJson omite "tags" cuando no se pasan', () => {
  const json = _internal.buildMetadataJson({}, 'box-abc.mjs')
  const meta = JSON.parse(json)
  assert.equal(meta.tags, undefined)
})

test('_internal.buildMetadataJson incluye "tags" cuando se pasan', () => {
  const json = _internal.buildMetadataJson({}, 'box-abc.mjs', ['tenant:david', 'box:dash'])
  const meta = JSON.parse(json)
  assert.deepEqual(meta.tags, ['tenant:david', 'box:dash'])
})

test('_internal.assertValidTags acepta undefined y []', () => {
  assert.doesNotThrow(() => _internal.assertValidTags(undefined))
  assert.doesNotThrow(() => _internal.assertValidTags([]))
  assert.doesNotThrow(() => _internal.assertValidTags(['tenant:ok', 'box:ok']))
})

test('_internal.assertValidTags acepta exactamente 32 tags', () => {
  const tags = Array.from({ length: 32 }, (_, i) => `t${i}`)
  assert.doesNotThrow(() => _internal.assertValidTags(tags))
})

test('_internal.assertValidTags acepta tag de exactamente 64 chars', () => {
  const tag = 'a'.repeat(64)
  assert.doesNotThrow(() => _internal.assertValidTags([tag]))
})