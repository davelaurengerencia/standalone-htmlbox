// src/wrapper.mjs — entry point del per-box script (Phase 2 de WFP).
//
// Compilado por scripts/build.mjs (esbuild) → dist/box-worker.mjs y deployado
// al namespace 'htmlbox-boxes' por packages/control-plane/src/lib/wfpDeployer.js
// en cada box create (HTMLBox routes/boxes.js).
//
// El script corre en su PROPIO isolate WFP — un box por script. El dispatcher
// (packages/runtime/src/worker.js) le pasa identidad por headers:
//
//   X-HTMLBox-Box-Id       — el boxId validado (defense-in-depth acá)
//   X-HTMLBox-Tenant-Slug  — para armar el R2 key
//   X-HTMLBox-Box-Slug     — para el debug panel ctx
//   X-HTMLBox-Visibility   — 'public' | 'private' (decide CSP)
//
// El per-box script NO llama al runtime dispatcher — es código independiente.
// Hace su propia llamada a control-plane (/api/boxes/{id}/active-html) para
// resolver la versión activa + HTML, lo lee del R2 binding que trae, y
// devuelve la Response via serveBoxHtml() — mismo helper que usa el dispatcher,
// reusado vía @htmlbox/runtime-core.
//
// Limitación v1: el per-box script NO inyecta el panel de debug (require
// shouldShowDebugPanel que llama a control-plane — out of scope para v1).
// Para debuggear boxes sirve directamente desde el dispatcher (binding off).

import { serveBoxHtml } from '@htmlbox/runtime-core'

const BOX_ID_HEADER = 'X-HTMLBox-Box-Id'
const TENANT_HEADER = 'X-HTMLBox-Tenant-Slug'
const SLUG_HEADER = 'X-HTMLBox-Box-Slug'
const VIS_HEADER = 'X-HTMLBox-Visibility'
const BOX_ID_PATTERN = /^[a-z0-9]{16}$/

export default {
  async fetch(request, env) {
    const boxId = request.headers.get(BOX_ID_HEADER)
    // Defense-in-depth: el dispatcher ya validó, pero el per-box script
    // recibe requests de un dispatcher que NO controlamos si en el futuro
    // se hostea otro dispatcher con el binding. Regex fija desde cookiePathForBox
    // (sec fix H2 del anexo).
    if (!BOX_ID_PATTERN.test(boxId)) {
      return new Response(`bad boxId`, { status: 400 })
    }

    const tenantSlug = request.headers.get(TENANT_HEADER)
    const boxSlug = request.headers.get(SLUG_HEADER)
    const visibility = request.headers.get(VIS_HEADER) === 'public' ? 'public' : 'private'
    if (!tenantSlug || !boxSlug) {
      return new Response('missing dispatch context', { status: 400 })
    }

    const origin = env.HTMLBOX_CONTROL_PLANE_ORIGIN
    if (!origin) {
      return new Response('control plane unconfigured', { status: 500 })
    }

    // Reenviamos la cookie del usuario (la sesión la valida control-plane).
    const headers = new Headers()
    const cookie = request.headers.get('Cookie')
    if (cookie) headers.set('Cookie', cookie)

    const res = await fetch(`${origin}/api/boxes/${boxId}/active-html`, { headers })
    if (!res.ok) {
      return new Response(`upstream error`, {
        status: res.status === 401 || res.status === 404 ? res.status : 502,
      })
    }
    const data = await res.json()
    if (!data.version || !data.html) {
      return new Response('no version', { status: 404 })
    }

    return await serveBoxHtml({
      boxId,
      version: data.version,
      html: data.html,
      visibility,
      env: { HTMLBOX_CONTROL_PLANE_ORIGIN: origin },
      request,
      url: new URL(request.url),
      tenantSlug,
      boxSlug,
    })
  },
}
