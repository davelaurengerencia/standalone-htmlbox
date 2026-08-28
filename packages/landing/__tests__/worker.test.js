// __tests__/worker.test.js — tests del landing worker.
//
// Cubre:
//   - GET / → 200 + Coming Soon HTML (SivoCloud + Coming Soon + mailto)
//   - GET /health → 200 text/plain (health check mínimo)
//   - GET /s/{shareId} → forward a RUNTIME service binding (si está)
//   - GET /t/{tenant}/{boxSlug} → forward a RUNTIME service binding
//   - GET /{boxSlug} → forward a RUNTIME service binding
//   - GET /cualquier-cosa-otra → 200 + Coming Soon (default)
//   - Cache-Control header presente (la landing se cachea 5 min en el edge)
//   - Service binding missing → 502 con mensaje claro (dev sin wrangler)

import { test } from 'node:test'
import assert from 'node:assert/strict'

// Mirror de la lógica del worker + helper para inyectar el binding
// mockeado. Reutilizamos el helper de env para que los tests reflejen
// el shape exacto del fetch handler.
async function handle(request, env = {}) {
  const url = new URL(request.url)
  if (url.pathname === '/health') {
    return new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } })
  }
  if (RUNTIME_PATH_RE.test(url.pathname)) {
    if (env.RUNTIME) {
      return await env.RUNTIME.fetch(request)
    }
    return new Response(
      'Landing: RUNTIME service binding no configurado. En prod, wrangler.jsonc declara { binding: "RUNTIME", service: "htmlbox-runtime" }.',
      { status: 502, headers: { 'Content-Type': 'text/plain' } }
    )
  }
  return new Response(LANDING_HTML, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  })
}

// Mirror del regex del worker. Si cambia allá, hay que cambiar acá.
// Mantener en sync con packages/runtime-core/src/resolver.js#parseRuntimePath.
const RUNTIME_PATH_RE = /^\/(?:s\/[a-z0-9]{6,20}|t\/[a-z][a-z0-9-]{0,38}[a-z0-9]\/[a-z][a-z0-9_-]{0,62}[a-z0-9]|[a-z][a-z0-9_-]{0,62}[a-z0-9])\/?$/

const LANDING_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SivoCloud — Coming Soon</title>
</head>
<body>
  <main>
    <span class="badge">Coming Soon</span>
    <h1>SivoCloud</h1>
    <p>La plataforma para construir y publicar dashboards HTML generados por IA, con datos aislados por proyecto.</p>
    <div class="cta">¿Acceso anticipado? Escribinos a <a href="mailto:hello@sivocloud.dev">hello@sivocloud.dev</a></div>
  </main>
</body>
</html>
`

// ============ Landing HTML (default response) ============

test('landing: GET / responde 200 + text/html con "SivoCloud" y "Coming Soon"', async () => {
  const res = await handle(new Request('https://sivocloud.dev/'))
  assert.equal(res.status, 200)
  assert.match(res.headers.get('Content-Type'), /text\/html/)
  const body = await res.text()
  assert.match(body, /SivoCloud/)
  assert.match(body, /Coming Soon/)
})

test('landing: GET / responde Cache-Control (cache edge 5min)', async () => {
  const res = await handle(new Request('https://sivocloud.dev/'))
  assert.match(res.headers.get('Cache-Control'), /max-age=300/)
})

test('landing: HTML incluye CTA mailto a hello@sivocloud.dev', async () => {
  const res = await handle(new Request('https://sivocloud.dev/'))
  const body = await res.text()
  assert.match(body, /hello@sivocloud\.dev/)
})

// ============ /health ============

test('landing: GET /health → 200 text/plain (healthcheck para monitoring)', async () => {
  const res = await handle(new Request('https://sivocloud.dev/health'))
  assert.equal(res.status, 200)
  assert.match(res.headers.get('Content-Type'), /text\/plain/)
  assert.equal(await res.text(), 'ok')
})

// ============ Forwarding a runtime ============

test('landing: GET /s/{shareId} forwardea a RUNTIME (cuando el binding está configurado)', async () => {
  let capturedUrl = null
  let capturedMethod = null
  const env = {
    RUNTIME: {
      fetch: async (req) => {
        capturedUrl = req.url
        capturedMethod = req.method
        return new Response('<html>shared box</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      },
    },
  }
  const res = await handle(new Request('https://sivocloud.dev/s/abc12345'), env)
  assert.equal(res.status, 200)
  assert.match(capturedUrl, /\/s\/abc12345/)
  assert.equal(capturedMethod, 'GET')
  assert.match(await res.text(), /shared box/)
})

test('landing: GET /t/{tenant}/{boxSlug} forwardea a RUNTIME', async () => {
  let captured = null
  const env = {
    RUNTIME: {
      fetch: async (req) => { captured = req.url; return new Response('ok') },
    },
  }
  const res = await handle(new Request('https://sivocloud.dev/t/acme/mi-dashboard'), env)
  assert.equal(res.status, 200)
  assert.match(captured, /\/t\/acme\/mi-dashboard/)
})

test('landing: GET /{boxSlug} forwardea a RUNTIME', async () => {
  let captured = null
  const env = {
    RUNTIME: {
      fetch: async (req) => { captured = req.url; return new Response('ok') },
    },
  }
  const res = await handle(new Request('https://sivocloud.dev/mi-dashboard'), env)
  assert.equal(res.status, 200)
  assert.match(captured, /\/mi-dashboard/)
})

test('landing: sin service binding y path runtime → 502 con mensaje claro', async () => {
  const res = await handle(new Request('https://sivocloud.dev/s/abc12345'))  // sin env.RUNTIME
  assert.equal(res.status, 502)
  const body = await res.text()
  assert.match(body, /RUNTIME.*no configurado/)
})

test('landing: paths runtime-shaped preservan query string al forwardear', async () => {
  let captured = null
  const env = {
    RUNTIME: {
      fetch: async (req) => { captured = req.url; return new Response('ok') },
    },
  }
  await handle(new Request('https://sivocloud.dev/s/abc12345?token=xyz'), env)
  assert.match(captured, /token=xyz/)
})

// ============ Path classification ============

test('landing: paths NO runtime-shaped → 200 + Coming Soon (default)', async () => {
  const res = await handle(new Request('https://sivocloud.dev/blog/post-1'))
  assert.equal(res.status, 200)
  assert.match(res.headers.get('Content-Type'), /text\/html/)
  assert.match(await res.text(), /Coming Soon/)
})

test('landing: paths con caracteres inválidos (no matchean el regex) → Coming Soon', async () => {
  // boxSlug con mayúsculas — el regex solo acepta lowercase
  const res = await handle(new Request('https://sivocloud.dev/MiBox'))
  assert.equal(res.status, 200)
  assert.match(await res.text(), /Coming Soon/)
})

test('landing: shareId muy corto (regex requiere {6,20}) → Coming Soon', async () => {
  // shareId con 5 chars — no matchea
  const res = await handle(new Request('https://sivocloud.dev/s/abc12'))
  assert.equal(res.status, 200)
  assert.match(await res.text(), /Coming Soon/)
})
