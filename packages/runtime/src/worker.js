// src/worker.js — entry point de htmlbox-runtime.
//
// Sirve:
//   GET  /                                          → health
//   GET  /_sdk/htmlbox.js                           → SDK (texto del bundle)
//   GET  /_devtools/debug-panel.js                  → script del panel de debug (ver htmlbox-spec-debug-panel.md)
//   GET  /api/data/{boxId}/tables...                → data API (lectura/escritura de tablas del box)
//   GET  /s/{shareId}                               → box público (sin auth)
//   GET  /t/{tenantSlug}/{boxSlug}                  → box privado path-based
//   GET  /{boxSlug}                                 → box privado (host *.htmlbox.dev, con sesión)
//
// La data API es servida por el mismo runtime que sirve HTML: la URL pública
// es /api/data/{boxId}/... y el SDK del box la consume con credentials=include
// (cookie de sesión reenviada). El control-plane valida membresía vía
// /api/internal/boxes/{boxId}/membership.

import { parseRuntimePath, resolveByShareId, resolveByTenantAndSlug } from './lib/resolver.js'
import { serveBoxHtml } from './lib/htmlServer.js'
import { handleDataApi } from './lib/dataApi.js'
import { handleAppAuth } from './lib/appAuthRoutes.js'
import { handleAppDataApi } from './lib/appDataApi.js'
import { handleTenantAppAuth } from './lib/tenantAppAuth.js'
import { SDK_VERSION } from '@htmlbox/shared'

import SDK_SOURCE_BODY from './sdk/htmlbox-sdk.txt' // bundled as Text por wrangler rules
import DEBUG_PANEL_SOURCE from './devtools/debug-panel.js.txt' // bundled as Text por wrangler rules

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  })
}

function notFound(reason = 'not_found') {
  return json({ error: reason }, 404)
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const path = url.pathname

    if (path === '/health') {
      return json({ ok: true, sdk: SDK_VERSION })
    }

    if (path === '/_sdk/htmlbox.js') {
      return new Response(SDK_SOURCE_BODY, {
        status: 200,
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=60',
        },
      })
    }

    if (path === '/_devtools/debug-panel.js') {
      return new Response(DEBUG_PANEL_SOURCE, {
        status: 200,
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
        },
      })
    }

    // Data API
    if (path.startsWith('/api/data/')) {
      return (await handleDataApi(request, env, url)) || notFound('not_found')
    }

    // App-auth API (usuarios de la app — magic link, sesión, admin)
    if (path.startsWith('/api/app-auth/')) {
      return (await handleAppAuth(request, env, url)) || notFound('not_found')
    }

    // App-data API (customers — filas filtradas por owner_user_id)
    if (path.startsWith('/api/app-data/')) {
      return (await handleAppDataApi(request, env, url)) || notFound('not_found')
    }

    // Tenant-app-auth (fase 3 — usuarios centralizados, magic link cross-box)
    if (path.startsWith('/api/tenant-app-auth/')) {
      return (await handleTenantAppAuth(request, env, url)) || notFound('not_found')
    }

    // Box público
    const shareMatch = path.match(/^\/s\/([a-z0-9]{6,20})\/?$/)
    if (shareMatch) {
      const shareId = shareMatch[1]
      const resolved = await resolveByShareId(env, shareId, request)
      if (!resolved) return notFound('box_not_found_or_private')
      const active = await fetchActiveHtml(env, resolved.boxId, request)
      if (active.error) return notFound(active.error)
      return await serveBoxHtml({
        boxId: resolved.boxId,
        version: active.version,
        html: active.html,
        visibility: 'public',
        env,
        request,
        url,
        tenantSlug: resolved.tenantSlug,
        boxSlug: resolved.boxSlug,
      })
    }

    // Box privado
    const parsed = parseRuntimePath(url)
    if (parsed?.mode === 'private') {
      const resolved = await resolveByTenantAndSlug(env, parsed.tenantSlug, parsed.boxSlug, request)
      if (!resolved) return notFound('box_not_found_or_private')
      const active = await fetchActiveHtml(env, resolved.boxId, request)
      if (active.error) return notFound(active.error)
      return await serveBoxHtml({
        boxId: resolved.boxId,
        version: active.version,
        html: active.html,
        visibility: resolved.visibility === 'public' ? 'public' : 'private',
        env,
        request,
        url,
        tenantSlug: resolved.tenantSlug,
        boxSlug: resolved.boxSlug,
      })
    }

    return new Response('Not Found', { status: 404 })
  },
}

// Pide al control-plane el HTML activo del box. Devuelve { version, error? }.
async function fetchActiveHtml(env, boxId, request) {
  const origin = env.HTMLBOX_CONTROL_PLANE_ORIGIN
  if (!origin) return { error: 'control_plane_unconfigured' }
  const headers = new Headers()
  const cookie = request.headers.get('Cookie')
  if (cookie) headers.set('Cookie', cookie)
  const res = await fetch(`${origin}/api/boxes/${boxId}/active-html`, { headers })
  if (!res.ok) {
    return { error: res.status === 401 ? 'unauthenticated' : (res.status === 404 ? 'no_published_version' : 'upstream_error') }
  }
  const data = await res.json()
  return { version: data.version, html: data.html }
}