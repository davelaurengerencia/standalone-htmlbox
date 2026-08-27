// __tests__/build.test.js — verifica que el bundle está bien formado.
//
// El bundle se deploya a WFP. Si está roto (sintaxis inválida, imports
// colgantes) Cloudflare lo rechaza y el deploy falla. Mejor detectarlo
// acá antes de gastar un PUT a la API.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const distPath = path.join(root, 'dist/box-worker.mjs')

test('dist/box-worker.mjs existe y es un bundle no vacío', async () => {
  const stat = await fs.stat(distPath)
  assert.ok(stat.size > 0, 'bundle no debería estar vacío')
  // 10 KB es un techo generoso (hoy ~4 KB). Si el bundle crece sin razón,
  // queremos detectarlo.
  assert.ok(stat.size < 10240, `bundle demasiado grande: ${stat.size} bytes`)
})

test('bundle es JavaScript ESM válido (parsea sin errores)', async () => {
  const code = await fs.readFile(distPath, 'utf8')
  // Worker-friendly: ESM, exports default al final del bundle minificado.
  // esbuild emite `export{...as default}` (identificador puede renombrarse).
  assert.match(code, /export\s*\{[^}]*as\s+default\s*\}/, 'bundle debe terminar con `export{...as default}`')
})

test('bundle exporta default con fetch handler', async () => {
  const mod = await import(distPath)
  assert.ok(mod.default, 'default export debe existir')
  assert.equal(typeof mod.default.fetch, 'function', 'default.fetch debe ser función')
})

test('bundle maneja boxId inválido con 400', async () => {
  const mod = await import(distPath)
  const req = new Request('https://perbox.example/', {
    headers: { 'X-HTMLBox-Box-Id': 'INVALID_UPPER' },
  })
  const env = { HTMLBOX_CONTROL_PLANE_ORIGIN: 'https://cp.example' }
  const res = await mod.default.fetch(req, env)
  assert.equal(res.status, 400)
})

test('bundle maneja tenant/slug faltantes con 400', async () => {
  const mod = await import(distPath)
  const req = new Request('https://perbox.example/', {
    headers: { 'X-HTMLBox-Box-Id': 'abcdef0123456789' },
  })
  const env = { HTMLBOX_CONTROL_PLANE_ORIGIN: 'https://cp.example' }
  const res = await mod.default.fetch(req, env)
  assert.equal(res.status, 400)
})

test('bundle devuelve 500 si HTMLBOX_CONTROL_PLANE_ORIGIN no está', async () => {
  const mod = await import(distPath)
  const req = new Request('https://perbox.example/', {
    headers: {
      'X-HTMLBox-Box-Id': 'abcdef0123456789',
      'X-HTMLBox-Tenant-Slug': 'acme',
      'X-HTMLBox-Box-Slug': 'cartera',
      'X-HTMLBox-Visibility': 'public',
    },
  })
  const env = {} // sin HTMLBOX_CONTROL_PLANE_ORIGIN
  const res = await mod.default.fetch(req, env)
  assert.equal(res.status, 500)
})

test('bundle happy path: devuelve el HTML con CSP + SDK inyectado', async () => {
  const mod = await import(distPath)
  const req = new Request('https://perbox.example/', {
    headers: {
      'X-HTMLBox-Box-Id': 'abcdef0123456789',
      'X-HTMLBox-Tenant-Slug': 'acme',
      'X-HTMLBox-Box-Slug': 'cartera',
      'X-HTMLBox-Visibility': 'public',
      'Cookie': 'sid=abc',
    },
  })
  const env = { HTMLBOX_CONTROL_PLANE_ORIGIN: 'https://cp.example' }

  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://cp.example/api/boxes/abcdef0123456789/active-html')
    assert.equal(init.headers.get('Cookie'), 'sid=abc', 'cookie reenviada')
    return new Response(JSON.stringify({
      version: 7,
      html: '<html><body><h1>Hola</h1></body></html>',
    }), { headers: { 'Content-Type': 'application/json' } })
  }

  try {
    const res = await mod.default.fetch(req, env)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('Content-Type'), /text\/html/)
    assert.match(res.headers.get('Content-Security-Policy'), /default-src 'self'/, 'CSP inyectado')
    assert.match(res.headers.get('X-HTMLBox-Version'), /^7$/, 'version header')
    const body = await res.text()
    assert.match(body, /<h1>Hola<\/h1>/, 'HTML original')
    assert.match(body, /\/_sdk\/htmlbox\.js\?boxId=abcdef0123456789&v=public/, 'SDK inyectado')
  } finally {
    globalThis.fetch = origFetch
  }
})

test('bundle: control-plane 401 → per-box script devuelve 401', async () => {
  const mod = await import(distPath)
  const req = new Request('https://perbox.example/', {
    headers: {
      'X-HTMLBox-Box-Id': 'abcdef0123456789',
      'X-HTMLBox-Tenant-Slug': 'acme',
      'X-HTMLBox-Box-Slug': 'cartera',
      'X-HTMLBox-Visibility': 'private',
    },
  })
  const env = { HTMLBOX_CONTROL_PLANE_ORIGIN: 'https://cp.example' }

  const origFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('{}', { status: 401 })

  try {
    const res = await mod.default.fetch(req, env)
    assert.equal(res.status, 401)
  } finally {
    globalThis.fetch = origFetch
  }
})

test('bundle: control-plane 5xx → per-box script devuelve 502', async () => {
  const mod = await import(distPath)
  const req = new Request('https://perbox.example/', {
    headers: {
      'X-HTMLBox-Box-Id': 'abcdef0123456789',
      'X-HTMLBox-Tenant-Slug': 'acme',
      'X-HTMLBox-Box-Slug': 'cartera',
      'X-HTMLBox-Visibility': 'private',
    },
  })
  const env = { HTMLBOX_CONTROL_PLANE_ORIGIN: 'https://cp.example' }

  const origFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('{}', { status: 503 })

  try {
    const res = await mod.default.fetch(req, env)
    assert.equal(res.status, 502, 'mapeo 5xx → 502 (bad gateway)')
  } finally {
    globalThis.fetch = origFetch
  }
})

test('bundle: control-plane 200 sin version/html → 404', async () => {
  const mod = await import(distPath)
  const req = new Request('https://perbox.example/', {
    headers: {
      'X-HTMLBox-Box-Id': 'abcdef0123456789',
      'X-HTMLBox-Tenant-Slug': 'acme',
      'X-HTMLBox-Box-Slug': 'cartera',
      'X-HTMLBox-Visibility': 'public',
    },
  })
  const env = { HTMLBOX_CONTROL_PLANE_ORIGIN: 'https://cp.example' }

  const origFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ version: 0, html: '' }), {
    headers: { 'Content-Type': 'application/json' },
  })

  try {
    const res = await mod.default.fetch(req, env)
    assert.equal(res.status, 404)
  } finally {
    globalThis.fetch = origFetch
  }
})

test('bundle: defensa en profundidad — boxId no es 16 chars [a-z0-9]', async () => {
  const mod = await import(distPath)
  const req = new Request('https://perbox.example/', {
    headers: {
      'X-HTMLBox-Box-Id': 'short',
      'X-HTMLBox-Tenant-Slug': 'acme',
      'X-HTMLBox-Box-Slug': 'cartera',
      'X-HTMLBox-Visibility': 'public',
    },
  })
  const env = { HTMLBOX_CONTROL_PLANE_ORIGIN: 'https://cp.example' }
  const res = await mod.default.fetch(req, env)
  assert.equal(res.status, 400)
})
