// src/worker.js — entry point de htmlbox-runtime.
//
// Sirve:
//   GET  /                         → health
//   GET  /_sdk/htmlbox.js          → SDK
//   GET  /_internal/box-info       → para que el portal sepa si el runtime conoce el box
//   GET  /s/{shareId}              → box público (sin auth)
//   GET  /{boxSlug}                → box privado (con sesión, en host *.htmlbox.dev)
//   GET  /t/{tenantSlug}/{boxSlug} → box privado path-based (alternativa al subdomain)
//
// Toda la resolución de boxId/tenantSlug se hace contra el control-plane vía
// /api/internal/boxes-by-* — el runtime NO toca D1 ni secretos del box.

import { parseRuntimePath, resolveByShareId, resolveByTenantAndSlug } from './lib/resolver.js'
import { serveBoxHtml } from './lib/htmlServer.js'
import { SDK_VERSION } from '@htmlbox/shared'

const SDK_SOURCE = require_sdk_source()

function require_sdk_source() {
  // En dev se lee de disco (build-time static); wrangler empaqueta el archivo
  // en el bundle. Importarlo como `?raw` no es portable, así que lo embebemos
  // via fetch en runtime.
  return null
}

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
      // Lo lee del bundle (se importa desde el archivo fuente).
      return new Response(SDK_SOURCE_BODY, {
        status: 200,
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=60',
        },
      })
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

// Embed del SDK. En producción esto se mueve a un asset (wrangler.jsonc →
// assets) o a un módulo con build-time bundling. Para mantener este worker
// sin paso de build, embebemos el contenido.
const SDK_SOURCE_BODY = `;(function () {
  const URL_PARAMS = new URLSearchParams(location.search)
  const BOX_ID = URL_PARAMS.get('boxId') || ''
  const VISIBILITY = URL_PARAMS.get('v') || 'public'
  const RUNTIME_ORIGIN = location.origin

  function notImplemented(method, op) {
    return Promise.reject(new Error(
      '[HTMLBox] ' + method + '.' + op + ' no está disponible todavía (fase 3). ' +
      'Box: ' + BOX_ID + ', visibilidad: ' + VISIBILITY + '.'
    ))
  }

  function table(slug) {
    if (!slug || typeof slug !== 'string') {
      throw new Error('HTMLBox.table(slug): slug requerido')
    }
    return {
      rows: () => notImplemented('table', 'rows'),
      columns: () => notImplemented('table', 'columns'),
      upsert: () => notImplemented('table', 'upsert'),
      onChange: () => {
        console.info('[HTMLBox] table(' + slug + ').onChange — fase 3.')
      },
    }
  }

  function flow(flowId) {
    if (!flowId || typeof flowId !== 'string') {
      throw new Error('HTMLBox.flow(flowId): flowId requerido')
    }
    return { run: () => notImplemented('flow', 'run') }
  }

  const htmlbox = {
    boxId: BOX_ID,
    visibility: VISIBILITY,
    runtimeOrigin: RUNTIME_ORIGIN,
    sdkVersion: '${SDK_VERSION}',
    table,
    flow,
  }
  window.HTMLBox = htmlbox
  console.log('[HTMLBox] SDK v' + htmlbox.sdkVersion + ' listo (box=' + BOX_ID + ', visibility=' + VISIBILITY + ')')
})()
`