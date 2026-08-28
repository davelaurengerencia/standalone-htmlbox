// src/worker.js — Worker del apex sivocloud.dev.
//
// Responsabilidades:
//   1. Si el path es un shape que runtime entiende (`/s/{shareId}` para
//      boxes públicos, `/t/{tenantSlug}/{boxSlug}` para boxes privados
//      path-based, o `/{boxSlug}` que runtime puede servir como box
//      privado cuando el host tiene un subdomain de tenant — en el apex
//      eso no aplica, pero lo dejamos para robustez), forwardear al
//      runtime worker via service binding.
//   2. Para cualquier otro path (incluido `/`), responder Coming Soon
//      HTML estático.
//
// El apex se asigna a este worker (vs runtime) porque queremos que
// `/` sea marketing (Coming Soon), no un 404 ni una redirección. El
// runtime worker maneja `*.sivocloud.dev` (subdominios de tenant).

const LANDING_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SivoCloud — Coming Soon</title>
  <meta name="description" content="La plataforma para construir y publicar dashboards HTML generados por IA, con datos aislados por proyecto.">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
      color: #f1f5f9;
    }
    .container { text-align: center; max-width: 600px; padding: 2rem; }
    .badge {
      display: inline-block;
      padding: 0.5rem 1rem;
      background: rgba(99,102,241,0.1);
      border: 1px solid rgba(99,102,241,0.3);
      border-radius: 999px;
      font-size: 0.875rem;
      color: #a5b4fc;
      margin-bottom: 2rem;
    }
    h1 {
      font-size: 3rem;
      font-weight: 700;
      margin-bottom: 1rem;
      background: linear-gradient(90deg, #6366f1, #ec4899);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    p {
      font-size: 1.125rem;
      color: #cbd5e1;
      margin-bottom: 2rem;
      line-height: 1.6;
    }
    .cta { color: #94a3b8; font-size: 0.875rem; }
    .cta a { color: #a5b4fc; text-decoration: none; }
    .cta a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <main class="container">
    <span class="badge">Coming Soon</span>
    <h1>SivoCloud</h1>
    <p>La plataforma para construir y publicar dashboards HTML generados por IA, con datos aislados por proyecto.</p>
    <div class="cta">¿Acceso anticipado? Escribinos a <a href="mailto:hello@sivocloud.dev">hello@sivocloud.dev</a></div>
  </main>
</body>
</html>
`

// Patrones que runtime entiende. Si matchea, forwardeamos al runtime;
// si no, devolvemos la landing.
// Mantener en sync con packages/runtime-core/src/resolver.js#parseRuntimePath.
const RUNTIME_PATH_RE = /^\/(?:s\/[a-z0-9]{6,20}|t\/[a-z][a-z0-9-]{0,38}[a-z0-9]\/[a-z][a-z0-9_-]{0,62}[a-z0-9]|[a-z][a-z0-9_-]{0,62}[a-z0-9])\/?$/

function isRuntimePath(pathname) {
  return RUNTIME_PATH_RE.test(pathname)
}

function landingResponse() {
  return new Response(LANDING_HTML, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  })
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    // /health para monitoring (kubelet, load balancer, etc).
    if (url.pathname === '/health') {
      return new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } })
    }

    // Paths que runtime entiende → forward via service binding.
    if (isRuntimePath(url.pathname)) {
      // Service binding: llamada interna a otro Worker de la misma
      // cuenta. Cero latencia de red, no pasa por el edge público.
      if (env.RUNTIME) {
        return await env.RUNTIME.fetch(request)
      }
      // En dev (sin service binding configurado) caemos a la landing
      // con un mensaje claro. Los tests de landing no dependen del
      // binding — solo verifican el shape local.
      return new Response(
        'Landing: RUNTIME service binding no configurado. En prod, wrangler.jsonc declara { binding: "RUNTIME", service: "htmlbox-runtime" }.',
        { status: 502, headers: { 'Content-Type': 'text/plain' } }
      )
    }

    return landingResponse()
  },
}
