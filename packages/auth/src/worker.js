// src/worker.js — entry point de htmlbox-auth.
//
// 5° Worker de SivoCloud. Centraliza TODA la lógica de auth (request,
// verify, consume, logout, exchange). Recibe requests directos del browser —
// nunca via proxy de otro worker. Ese es el fix estructural del bug de
// auth-error descrito en docs/htmlbox-spec-auth-centralizado.md §0.
//
// Rutas:
//   GET  /login                                 → página estática con form
//   GET  /health                                → health check
//   POST /api/auth/request                      → flow 'auth-request'
//   GET  /api/auth/verify?token=…               → flow 'auth-verify'
//   POST /api/auth/consume                      → flow 'auth-consume'
//   POST /api/auth/logout                       → flow 'auth-logout'
//   POST /api/auth/exchange                     → flow 'auth-exchange' (gate X-HTMLBox-Internal-Secret)
//
// Bindings:
//   DB    — D1 compartido con control-plane y runtime (mismo database_id)
//   EMAIL — Cloudflare Email Sending (mismo dominio onboarded que control-plane)
//
// Variables (wrangler.jsonc):
//   HTMLBOX_ENV                — 'development' (dev) / 'production' (prod)
//   HTMLBOX_SESSION_DOMAIN     — '.sivocloud.dev' en prod, '' en localhost (host-only)
//   HTMLBOX_EMAIL_MODE         — leído por el nodo `cloudflare-email` del flow-engine
//   HTMLBOX_INTERNAL_SECRET    — gate de /api/auth/exchange (server-to-server)
//   HTMLBOX_PORTAL_ORIGIN      — 'https://studio.sivocloud.dev'
//   HTMLBOX_PUBLIC_ORIGIN      — 'https://controlplane.sivocloud.dev'

import LOGIN_HTML from './ui/login.html.txt'
import authRequestFlow from './flows/auth-request.flow.json' with { type: 'json' }
import authVerifyFlow from './flows/auth-verify.flow.json' with { type: 'json' }
import authConsumeFlow from './flows/auth-consume.flow.json' with { type: 'json' }
import authLogoutFlow from './flows/auth-logout.flow.json' with { type: 'json' }
import authExchangeFlow from './flows/auth-exchange.flow.json' with { type: 'json' }
import { getFlowEngineApp } from './lib/bootstrap.js'

// Mapa de flows del paquete `auth`. Cada flow es un array de nodos
// importado como JSON vía la regla "Text" de wrangler.jsonc. Se completa
// a medida que se implementan los flows del spec §2.
const FLOWS = {
  'auth-request': authRequestFlow,   // §2.1 — implementado Paso 3
  'auth-verify': authVerifyFlow,     // §2.2 — implementado Paso 5
  'auth-consume': authConsumeFlow,    // §2.3 — implementado Paso 4
  'auth-logout': authLogoutFlow,     // §2.4 — implementado Paso 6
  'auth-exchange': authExchangeFlow, // §2.5 — implementado Paso 7
}

// Mapeo path HTTP → nombre del flow. El Worker expone URLs "limpias"
// (/api/auth/request) y las traduce al http-in del flow-engine
// (/api/flows/auth-request). El flow-engine se monta en httpNodeRoot='/api/flows'
// y matchea por path completo (ver bootstrap.js::HTTP_NODE_ROOT).
const PATH_TO_FLOW = {
  '/api/auth/request': 'auth-request',
  '/api/auth/verify': 'auth-verify',
  '/api/auth/consume': 'auth-consume',
  '/api/auth/logout': 'auth-logout',
  '/api/auth/exchange': 'auth-exchange',
}

// ----------------------------------------------------------------------------
// CORS
// ----------------------------------------------------------------------------

function corsHeaders(request) {
  // Reflejamos el Origin del request. Access-Control-Allow-Origin: * con
  // Allow-Credentials: true es inválido (la spec CORS lo rechaza). Si el
  // request no trae Origin (server-to-server, curl), caemos a '*'.
  const origin = request.headers.get('Origin') || ''
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-HTMLBox-Internal-Secret',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  }
}

function withCors(res, request) {
  const headers = new Headers(res.headers)
  const origin = request.headers.get('Origin') || ''
  headers.set('Access-Control-Allow-Origin', origin || '*')
  headers.set('Access-Control-Allow-Credentials', 'true')
  headers.set('Vary', 'Origin')
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  })
}

// ----------------------------------------------------------------------------
// Routing
// ----------------------------------------------------------------------------

function rewriteToFlowEngine(request, flowName) {
  // El flow-engine espera el path `/api/flows/<flowName>` (donde flowName es
  // lo que está en el `path` del http-in del flow). El Worker `auth` expone
  // `/api/auth/<op>` por prolijidad, así que esta función traduce.
  const url = new URL(request.url)
  url.pathname = `/api/flows/${flowName}`
  return new Request(url, request)
}

function isInternalSecretValid(request, env) {
  // Server-to-server: studio.* o controlplane.* llaman a /api/auth/exchange
  // con este header. Sin él, 403. Defense in depth — el flow también puede
  // revalidarlo si queremos, pero acá cortamos antes.
  const provided = request.headers.get('X-HTMLBox-Internal-Secret') || ''
  return !!env.HTMLBOX_INTERNAL_SECRET && provided === env.HTMLBOX_INTERNAL_SECRET
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const path = url.pathname

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) })
    }

    // Health
    if (path === '/health') {
      return new Response(JSON.stringify({
        ok: true,
        env: env.HTMLBOX_ENV || 'unknown',
        flowsRegistered: Object.keys(FLOWS).length,
      }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
      })
    }

    // Página estática de login
    if (path === '/' || path === '/login') {
      return new Response(LOGIN_HTML, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    // Rutas /api/auth/* → flow-engine
    const flowName = PATH_TO_FLOW[path]
    if (flowName) {
      // /api/auth/exchange está gateado por secret compartido (server-to-server)
      if (path === '/api/auth/exchange') {
        if (!isInternalSecretValid(request, env)) {
          return new Response(JSON.stringify({ error: 'forbidden' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
          })
        }
      }

      // Si el flow todavía no está implementado, devolvemos 501 con mensaje
      // claro (en vez de 404 silencioso). Hace más fácil el debug mientras
      // se implementan uno a uno.
      if (!FLOWS[flowName]) {
        return new Response(JSON.stringify({
          error: 'flow_not_implemented',
          flow: flowName,
          message: `El flow "${flowName}" todavía no está implementado en packages/auth/src/flows/. Ver docs/htmlbox-spec-auth-centralizado.md §2.`,
        }), {
          status: 501,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
        })
      }

      try {
        const internalReq = rewriteToFlowEngine(request, flowName)
        const app = await getFlowEngineApp(FLOWS, env)
        const res = await app.handleWorker(internalReq, env, ctx)
        if (!res) {
          return new Response(JSON.stringify({ error: 'flow_not_found', flow: flowName }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
          })
        }
        return withCors(res, request)
      } catch (err) {
        console.error(`[auth] flow "${flowName}" error:`, err?.message || err)
        return new Response(JSON.stringify({
          error: 'flow_error',
          flow: flowName,
          detail: String(err?.message || err).slice(0, 500),
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
        })
      }
    }

    return new Response('Not Found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain', ...corsHeaders(request) },
    })
  },
}
