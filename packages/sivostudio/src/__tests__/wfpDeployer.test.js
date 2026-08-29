// src/__tests__/wfpDeployer.test.js — REST PUT/DELETE al namespace WFP, sin red.
//
// Mockeamos globalThis.fetch para capturar la request y validar:
//   - URL exacta (account/namespace/script)
//   - Authorization Bearer con token del env
//   - Body multipart/form-data con parts 'metadata' (JSON) y 'box-{boxId}.mjs'
//   - Errores 4xx/5xx → throw con status + body
//   - 404 en delete → idempotente (best-effort cleanup)
//
// Coincide con el patrón de packages/control-plane/src/__tests__/wfpDeployer.test.js,
// pero apunta al namespace `sivostudio-experiments` (hardcoded en wfpDeployer.js).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  deployStudioBoxWorker,
  deleteStudioBoxWorker,
} from '../lib/wfpDeployer.js'

const VALID_BOX = 'abcdef0123456789'
const STUB_BUNDLE = '// stub per-box worker\nexport default { fetch() { return new Response("ok") } }\n'

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

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

// === Validación de inputs ===

test('deployStudioBoxWorker rechaza boxId inválido antes de gastar PUT', async () => {
  await assert.rejects(
    () => deployStudioBoxWorker(
      { WFP_DEPLOY_TOKEN: 't', HTMLBOX_CLOUDFLARE_ACCOUNT_ID: 'acct' },
      'corto',
      { bundleSource: STUB_BUNDLE },
    ),
    /boxId inválido/,
  )
})

test('deployStudioBoxWorker rechaza si WFP_DEPLOY_TOKEN no está en env', async () => {
  await assert.rejects(
    () => deployStudioBoxWorker(
      { HTMLBOX_CLOUDFLARE_ACCOUNT_ID: 'acct' },
      VALID_BOX,
      { bundleSource: STUB_BUNDLE },
    ),
    /WFP_DEPLOY_TOKEN no configurado/,
  )
})

test('deployStudioBoxWorker rechaza si HTMLBOX_CLOUDFLARE_ACCOUNT_ID no está en env', async () => {
  await assert.rejects(
    () => deployStudioBoxWorker(
      { WFP_DEPLOY_TOKEN: 't' },
      VALID_BOX,
      { bundleSource: STUB_BUNDLE },
    ),
    /HTMLBOX_CLOUDFLARE_ACCOUNT_ID no configurado/,
  )
})

// === Validación del PUT multipart ===

test('deployStudioBoxWorker: URL exacta al namespace sivostudio-experiments', async () => {
  const orig = globalThis.fetch
  let capturedUrl, capturedInit
  globalThis.fetch = async (url, init) => {
    capturedUrl = url
    capturedInit = init
    return jsonRes({ success: true })
  }
  try {
    await deployStudioBoxWorker(
      { WFP_DEPLOY_TOKEN: 'tok-abc', HTMLBOX_CLOUDFLARE_ACCOUNT_ID: 'acct-1' },
      VALID_BOX,
      { bundleSource: STUB_BUNDLE },
    )
  } finally {
    globalThis.fetch = orig
  }
  assert.equal(
    capturedUrl,
    'https://api.cloudflare.com/client/v4/accounts/acct-1/workers/dispatch/namespaces/sivostudio-experiments/scripts/box-abcdef0123456789',
  )
  assert.equal(capturedInit.method, 'PUT')
  assert.equal(capturedInit.headers.Authorization, 'Bearer tok-abc')
  // El Content-Type NO se setea — fetch lo calcula del FormData con boundary.
  assert.equal(capturedInit.headers['Content-Type'], undefined)
  assert.ok(capturedInit.body instanceof FormData)
})

test('deployStudioBoxWorker: metadata y bundle en el multipart', async () => {
  const orig = globalThis.fetch
  let capturedForm
  globalThis.fetch = async (_url, init) => {
    capturedForm = init.body
    return jsonRes({ success: true })
  }
  try {
    await deployStudioBoxWorker(
      { WFP_DEPLOY_TOKEN: 'tok', HTMLBOX_CLOUDFLARE_ACCOUNT_ID: 'acct' },
      VALID_BOX,
      { bundleSource: STUB_BUNDLE },
    )
  } finally {
    globalThis.fetch = orig
  }
  const parts = await readForm(capturedForm)
  // metadata es JSON con main_module = 'box-{boxId}.mjs' y compat date.
  const meta = JSON.parse(parts.metadata.text)
  assert.equal(meta.main_module, 'box-abcdef0123456789.mjs')
  assert.equal(meta.compatibility_date, '2026-08-01')
  assert.deepEqual(meta.compatibility_flags, ['nodejs_compat'])
  // El bundle va como Blob con MIME type correcto y mismo filename que main_module.
  assert.equal(parts['box-abcdef0123456789.mjs'].text, STUB_BUNDLE)
  assert.equal(parts['box-abcdef0123456789.mjs'].type, 'application/javascript+module')
})

test('deployStudioBoxWorker: devuelve { ok, scriptName } en 200', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async () => jsonRes({ success: true, result: {} })
  try {
    const r = await deployStudioBoxWorker(
      { WFP_DEPLOY_TOKEN: 'tok', HTMLBOX_CLOUDFLARE_ACCOUNT_ID: 'acct' },
      VALID_BOX,
      { bundleSource: STUB_BUNDLE },
    )
    assert.deepEqual(r, { ok: true, scriptName: 'box-abcdef0123456789' })
  } finally {
    globalThis.fetch = orig
  }
})

test('deployStudioBoxWorker: throw con status + body en 4xx/5xx', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async () => new Response('{"success":false,"errors":[{"message":"bad token"}]}', {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  })
  try {
    await assert.rejects(
      () => deployStudioBoxWorker(
        { WFP_DEPLOY_TOKEN: 'bad', HTMLBOX_CLOUDFLARE_ACCOUNT_ID: 'acct' },
        VALID_BOX,
        { bundleSource: STUB_BUNDLE },
      ),
      /Cloudflare respondió 403/,
    )
  } finally {
    globalThis.fetch = orig
  }
})

test('deployStudioBoxWorker: el bundle default del wrapper se usa si no se override', async () => {
  const orig = globalThis.fetch
  let capturedForm
  globalThis.fetch = async (_url, init) => {
    capturedForm = init.body
    return jsonRes({ success: true })
  }
  try {
    await deployStudioBoxWorker(
      { WFP_DEPLOY_TOKEN: 'tok', HTMLBOX_CLOUDFLARE_ACCOUNT_ID: 'acct' },
      VALID_BOX,
    )
  } finally {
    globalThis.fetch = orig
  }
  const parts = await readForm(capturedForm)
  // El wrapper commiteado es ~370 KB (el bundle de App Studio + editor-vanilla).
  // Validamos que esté presente y tenga un tamaño razonable (al menos 200 KB).
  const bundlePart = parts['box-abcdef0123456789.mjs']
  assert.ok(bundlePart, 'bundle debe estar en el multipart')
  assert.ok(bundlePart.size > 200_000, `bundle debe ser > 200 KB (fue ${bundlePart.size})`)
})

// === deleteStudioBoxWorker ===

test('deleteStudioBoxWorker: URL exacta + método DELETE', async () => {
  const orig = globalThis.fetch
  let capturedUrl, capturedInit
  globalThis.fetch = async (url, init) => {
    capturedUrl = url
    capturedInit = init
    return jsonRes({ success: true })
  }
  try {
    await deleteStudioBoxWorker(
      { WFP_DEPLOY_TOKEN: 'tok', HTMLBOX_CLOUDFLARE_ACCOUNT_ID: 'acct' },
      VALID_BOX,
    )
  } finally {
    globalThis.fetch = orig
  }
  assert.equal(capturedInit.method, 'DELETE')
  assert.equal(capturedInit.headers.Authorization, 'Bearer tok')
  assert.equal(
    capturedUrl,
    'https://api.cloudflare.com/client/v4/accounts/acct/workers/dispatch/namespaces/sivostudio-experiments/scripts/box-abcdef0123456789',
  )
})

test('deleteStudioBoxWorker: 404 → { ok: true, idempotent: true } (no falla)', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async () => new Response('not found', { status: 404 })
  try {
    const r = await deleteStudioBoxWorker(
      { WFP_DEPLOY_TOKEN: 'tok', HTMLBOX_CLOUDFLARE_ACCOUNT_ID: 'acct' },
      VALID_BOX,
    )
    assert.deepEqual(r, { ok: true, idempotent: true })
  } finally {
    globalThis.fetch = orig
  }
})

test('deleteStudioBoxWorker: 4xx/5xx (≠404) → throw', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async () => new Response('{"success":false}', { status: 500 })
  try {
    await assert.rejects(
      () => deleteStudioBoxWorker(
        { WFP_DEPLOY_TOKEN: 'tok', HTMLBOX_CLOUDFLARE_ACCOUNT_ID: 'acct' },
        VALID_BOX,
      ),
      /Cloudflare respondió 500/,
    )
  } finally {
    globalThis.fetch = orig
  }
})

test('deleteStudioBoxWorker: rechaza boxId inválido', async () => {
  await assert.rejects(
    () => deleteStudioBoxWorker(
      { WFP_DEPLOY_TOKEN: 'tok', HTMLBOX_CLOUDFLARE_ACCOUNT_ID: 'acct' },
      'corto',
    ),
    /boxId inválido/,
  )
})