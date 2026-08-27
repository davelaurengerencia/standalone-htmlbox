// src/worker.js — entry point de htmlbox-portal.
//
// Sirve la SPA Alpine del tenant. Proxy transparente de /api/* al control-plane
// para que el portal pueda vivir en cualquier host/origen sin CORS issues.
//
//   GET  /            → SPA (Alpine) servida desde ASSETS
//   /api/*             → proxy al control-plane (env.HTMLBOX_CONTROL_PLANE_ORIGIN)
//
// El HTML de la SPA se importa como texto en build-time (wrangler rule "Text")
// para evitar depender del cache edge de ASSETS que se pegó con un 404 viejo
// en /index.html. Cada deploy rebuilds el bundle, lo que invalida cualquier
// cache stale en el edge.

import { renderShell } from './lib/partials.js'

import PORTAL_SHELL_HTML from './ui-partials/shell.html.txt'
import HEADER_HTML from './ui-partials/header.html.txt'
import LOGIN_HTML from './ui-partials/login.html.txt'
import SIDEBAR_HTML from './ui-partials/sidebar.html.txt'
import MAIN_PANEL_HTML from './ui-partials/main-panel.html.txt'
import MODAL_NEW_BOX_HTML from './ui-partials/modal-new-box.html.txt'
import MODAL_SHARE_HTML from './ui-partials/modal-share.html.txt'
import MODAL_NEW_TENANT_HTML from './ui-partials/modal-new-tenant.html.txt'
import TOAST_HTML from './ui-partials/toast.html.txt'
import MODAL_AI_SCHEMA_HTML from './ui-partials/modal-ai-schema.html.txt'
import DEV_PREVIEW_OVERLAY_HTML from './ui-partials/dev-preview-overlay.html.txt'
import APP_SCRIPT_HTML from './ui-partials/app-script.html.txt'

// Shell del portal ensamblado en request-time con HTMLRewriter (ver
// src/lib/partials.js) a partir de fragmentos estáticos en src/ui-partials/.
const PORTAL_PARTIALS = {
  header: HEADER_HTML,
  login: LOGIN_HTML,
  sidebar: SIDEBAR_HTML,
  'main-panel': MAIN_PANEL_HTML,
  'modal-new-box': MODAL_NEW_BOX_HTML,
  'modal-share': MODAL_SHARE_HTML,
  'modal-new-tenant': MODAL_NEW_TENANT_HTML,
  toast: TOAST_HTML,
  'modal-ai-schema': MODAL_AI_SCHEMA_HTML,
  'dev-preview-overlay': DEV_PREVIEW_OVERLAY_HTML,
  'app-script': APP_SCRIPT_HTML,
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  }
}

// Proxy de /api/* al control-plane.
// Reenvía método, headers, body y devuelve la respuesta (incluyendo Set-Cookie).
async function proxyToControlPlane(request, env, path, search) {
  const origin = env.HTMLBOX_CONTROL_PLANE_ORIGIN
  if (!origin) {
    return new Response(JSON.stringify({ error: 'control_plane_unconfigured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request.headers.get('Origin')) },
    })
  }
  const upstreamUrl = `${origin}${path}${search || ''}`
  // Reenviar headers, pero filtrar los específicos del hop (Host).
  const headers = new Headers()
  for (const [k, v] of request.headers.entries()) {
    if (k.toLowerCase() === 'host') continue
    headers.set(k, v)
  }
  const init = {
    method: request.method,
    headers,
  }
  // Solo leer body para métodos que lo tienen.
  if (!['GET', 'HEAD'].includes(request.method.toUpperCase())) {
    init.body = request.body
  }
  try {
    const res = await fetch(upstreamUrl, init)
    // Copiar todos los headers (incluyendo Set-Cookie, que Workers preserva
    // en `new Headers(res.headers)`) y status.
    const resHeaders = new Headers(res.headers)
    // No propagar headers CORS del upstream — el browser está hablando con el
    // portal (mismo origen), no con el control-plane.
    resHeaders.delete('access-control-allow-origin')
    resHeaders.delete('access-control-allow-credentials')
    resHeaders.delete('vary')
    resHeaders.delete('content-encoding')
    resHeaders.delete('content-length')
    // Leer el body completo como ArrayBuffer para evitar problemas con
    // compression/stream re-serving.
    const body = await res.arrayBuffer()
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: resHeaders,
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: 'control_plane_unreachable', detail: err?.message || 'unknown' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request.headers.get('Origin')) },
    })
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const path = url.pathname

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('Origin')) })
    }

    // Health
    if (path === '/health') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders(request.headers.get('Origin')) },
      })
    }

    // Proxy de /api/* al control-plane.
    if (path.startsWith('/api/')) {
      return await proxyToControlPlane(request, env, path, url.search)
    }

    // Sirve la SPA desde el bundle (importado como texto). No depende del cache
// edge de ASSETS — cada deploy rebuilds el bundle con la última versión.
    if (!path.startsWith('/api/') && !path.includes('.')) {
      // Inyectamos las env vars como window.HTMLBOX_* antes del HTML para que el
      // JS de la SPA pueda hablar con el runtime directamente (cross-origin desde
      // portal). En dev .dev.vars del portal apunta a runtime.localhost:8783; en
      // prod wrangler.jsonc#vars apunta a htmlbox.dev. Se inyecta con
      // HTMLRewriter (ver renderShell) en vez de un regex sobre el string.
      const runtimeOrigin = env.HTMLBOX_RUNTIME_ORIGIN || ''
      const safeOrigin = JSON.stringify(runtimeOrigin).replace(/</g, '\\u003c')
      const safeEnv = JSON.stringify(env.HTMLBOX_ENV || 'production')
      const safeVersion = JSON.stringify(env.HTMLBOX_PORTAL_VERSION || 'dev')
      const injection = `<script>window.HTMLBOX_RUNTIME_ORIGIN=${safeOrigin};window.HTMLBOX_ENV=${safeEnv};window.HTMLBOX_PORTAL_VERSION=${safeVersion};</script>`
      const rewritten = renderShell(PORTAL_SHELL_HTML, PORTAL_PARTIALS, injection)
      const headers = new Headers(rewritten.headers)
      headers.set('Content-Type', 'text/html; charset=utf-8')
      headers.set('Cache-Control', 'no-store, no-cache, must-revalidate')
      return new Response(rewritten.body, { status: 200, headers })
    }

    // Static assets (CSS, JS, imágenes) desde el ASSETS binding.
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      const res = await env.ASSETS.fetch(request)
      if (res.status >= 200 && res.status < 400) {
        const newHeaders = new Headers(res.headers)
        newHeaders.set('Cache-Control', 'no-store, no-cache, must-revalidate')
        return new Response(res.body, { status: res.status, headers: newHeaders })
      }
    }

    return new Response(PORTAL_PLACEHOLDER, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  },
}

const PORTAL_PLACEHOLDER = `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8"><title>HTMLBox Portal</title>
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center">
  <div class="text-center max-w-md">
    <h1 class="text-2xl font-bold mb-2">HTMLBox Portal</h1>
    <p class="text-slate-400 text-sm">Si ves esto, el binding ASSETS no resolvió <code>/index.html</code>.</p>
  </div>
</body>
</html>
`