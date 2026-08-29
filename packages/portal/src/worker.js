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
import { handleAuthExchange } from '@htmlbox/shared'

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

// Helper: clona el request agregando X-Forwarded-Host con el host actual
// del request (ej. http://studio.localhost:8782). Se sigue usando aunque
// ya no dependamos del service binding en dev (ver más abajo) porque
// control-plane también lo lee cuando se le pega directo (curl, otros
// callers) y sirve como señal explícita adicional a Origin/Referer.
//
// Idempotente — si ya viene X-Forwarded-Host NO lo sobrescribe (prioriza
// el valor que el cliente explícitamente pasó).
function injectForwardedHost(request) {
  const headers = new Headers(request.headers)
  if (!headers.has('X-Forwarded-Host')) {
    const url = new URL(request.url)
    headers.set('X-Forwarded-Host', `${url.protocol}//${url.host}`)
  }
  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
    redirect: request.redirect,
  })
}

// Fetch HTTP directo al origin configurado en HTMLBOX_CONTROL_PLANE_ORIGIN
// (en dev: http://controlplane.localhost:8781, el proxy local de la sesión
// `wrangler dev --remote` de control-plane; en prod: https://controlplane.sivocloud.dev).
// Extraído a helper porque ahora tiene DOS callers: el path de dev (que lo
// usa siempre) y el fallback histórico cuando no hay binding CONTROL_PLANE.
async function fetchControlPlaneHttp(request, env) {
  const origin = env.HTMLBOX_CONTROL_PLANE_ORIGIN
  if (!origin) return null
  const forwardedReq = request.url.includes('localhost') ? injectForwardedHost(request) : request
  const url = new URL(forwardedReq.url)
  const upstreamUrl = `${origin}${url.pathname}${url.search}`
  const headers = new Headers()
  for (const [k, v] of forwardedReq.headers.entries()) {
    if (k.toLowerCase() === 'host') continue
    headers.set(k, v)
  }
  const init = { method: forwardedReq.method, headers }
  if (!['GET', 'HEAD'].includes(forwardedReq.method.toUpperCase())) {
    init.body = forwardedReq.body
  }
  try {
    const res = await fetch(upstreamUrl, init)
    const resHeaders = new Headers(res.headers)
    resHeaders.delete('access-control-allow-origin')
    resHeaders.delete('access-control-allow-credentials')
    resHeaders.delete('vary')
    resHeaders.delete('content-encoding')
    resHeaders.delete('content-length')
    const body = await res.arrayBuffer()
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: resHeaders,
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: 'control_plane_fetch_failed', detail: String(e?.message || e) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request.headers.get('Origin')) },
    })
  }
}

// Proxy de /api/* al control-plane.
//
// (1) DEV (*.localhost + HTMLBOX_CONTROL_PLANE_ORIGIN seteado, ver .dev.vars):
// SIEMPRE fetch HTTP directo, NUNCA service binding. Causa raíz confirmada
// (no es un problema de headers perdidos): con `wrangler dev --remote`, un
// service binding de un worker a otro NO se conecta a la sesión --remote
// local del worker de destino — Cloudflare resuelve el binding contra el
// script REALMENTE deployado en la cuenta con ese nombre (`htmlbox-control-plane`
// en prod), nunca contra tu preview de dev. Confirmado contra
// cloudflare/workers-sdk#5578 (cerrado "not planned" — la plataforma no
// soporta bindear un service binding a una sesión `--remote` ajena). Por eso
// `injectForwardedHost` solo, sin este cambio, nunca alcanzaba: el código
// que respondía del otro lado directamente no era el código de dev, así que
// ningún forwarding de headers lo podía arreglar. Ver AGENTS.md.
//
// (2) PROD y cualquier otro caso: service binding — interno, sin salir al
// edge público, sin el bug de 522 de fetches worker-to-worker por dominio
// custom (wrangler 4.127+). Ahí sí hay una sola versión deployada, así que
// el binding resuelve correctamente contra ella.
//
// (3) Fallback HTTP genérico si no hay binding (compat con setups viejos).
async function proxyToControlPlane(request, env) {
  const isLocalDev = request.url.includes('localhost') && !!env.HTMLBOX_CONTROL_PLANE_ORIGIN
  if (isLocalDev) {
    const res = await fetchControlPlaneHttp(request, env)
    if (res) return res
    // HTMLBOX_CONTROL_PLANE_ORIGIN no debería faltar acá (ya se chequeó arriba),
    // pero por las dudas seguimos al binding en vez de devolver 502 directo.
  }

  // (2) Service binding — prod, o cualquier caso no-dev.
  if (env.CONTROL_PLANE) {
    try {
      const forwardedReq = request.url.includes('localhost')
        ? injectForwardedHost(request)
        : request
      return await env.CONTROL_PLANE.fetch(forwardedReq)
    } catch (e) {
      return new Response(JSON.stringify({ error: 'control_plane_proxy_failed', detail: String(e?.message || e) }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(request.headers.get('Origin')) },
      })
    }
  }

  // (3) Fallback HTTP al origin configurado (sin binding CONTROL_PLANE en absoluto).
  const res = await fetchControlPlaneHttp(request, env)
  if (res) return res

  // (4) Sin binding ni origin — solo posible en tests sin wrangler.
  return new Response(
    'Portal: ni service binding CONTROL_PLANE ni HTMLBOX_CONTROL_PLANE_ORIGIN configurados.',
    { status: 502, headers: { 'Content-Type': 'text/plain' } }
  )
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
      return await proxyToControlPlane(request, env)
    }

    // Endpoint /auth/exchange — canje del ticket de auth.* por cookie sid
    // host-only en este dominio. Ver @htmlbox/shared/src/authExchange.js.
    if (path === '/auth/exchange') {
      return await handleAuthExchange(request, env)
    }

    // Sirve la SPA desde el bundle (importado como texto). No depende del cache
// edge de ASSETS — cada deploy rebuilds el bundle con la última versión.
    if (!path.startsWith('/api/') && !path.includes('.')) {
      // Inyectamos las env vars como window.HTMLBOX_* antes del HTML para que el
      // JS de la SPA pueda hablar con el runtime directamente (cross-origin desde
      // portal). En dev .dev.vars del portal apunta a runtime.localhost:8783; en
      // prod wrangler.jsonc#vars apunta a sivocloud.dev. Se inyecta con
      // HTMLRewriter (ver renderShell) en vez de un regex sobre el string.
      const runtimeOrigin = env.HTMLBOX_RUNTIME_ORIGIN || ''
      const safeOrigin = JSON.stringify(runtimeOrigin).replace(/</g, '\\u003c')
      const safeEnv = JSON.stringify(env.HTMLBOX_ENV || 'production')
      const safeVersion = JSON.stringify(env.HTMLBOX_PORTAL_VERSION || 'dev')
      const authOrigin = env.HTMLBOX_AUTH_ORIGIN || ''
      const safeAuthOrigin = JSON.stringify(authOrigin).replace(/</g, '\\u003c')
      const injection = `<script>window.HTMLBOX_RUNTIME_ORIGIN=${safeOrigin};window.HTMLBOX_AUTH_ORIGIN=${safeAuthOrigin};window.HTMLBOX_ENV=${safeEnv};window.HTMLBOX_PORTAL_VERSION=${safeVersion};</script>`
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