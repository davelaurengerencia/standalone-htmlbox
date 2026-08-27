// src/worker.js — entry point de htmlbox-control-plane.
//
// Rutas:
//   /api/auth/*         auth.js
//   /api/me/*, /api/tenants/:id/workspaces, /api/tenants  tenants.js
//   /api/boxes/:id + subrutas                              boxes.js, uploads.js
//   /admin/                                                UI admin (Alpine)
//   /api/admin/*                                           endpoints admin (placeholder)
//   /api/boxes/:id/upload-url | /api/boxes/:id/html | /api/boxes/:id/versions[/..] | /rollback/:n | /active-html
//
// Variables de entorno (wrangler.jsonc):
//   DB         — D1 binding (htmlbox-control-plane)
//   BUCKET     — R2 binding (htmlbox-content)
//   CACHE      — KV binding (htmlbox-cache)
//   HTMLBOX_*  — vars y secrets

import { handleAuth } from './routes/auth.js'
import { handleTenants } from './routes/tenants.js'
import { handleBoxes } from './routes/boxes.js'
import { handleUploads } from './routes/uploads.js'
import { handleInternal } from './routes/internal.js'
import { handleAi } from './routes/ai.js'

export { ControlPlaneDO } from './lib/do.js'  // placeholder para fase 4 (DO de estado)

function corsHeaders(request) {
  // Siempre reflejamos el Origin del request (A6). Access-Control-Allow-Origin: *
  // combinado con Allow-Credentials: true es inválido según la spec CORS — los
  // browsers rechazan la respuesta. Si el request no trae Origin (ej: curl
  // directo desde server-to-server), caemos a '*' como fallback defensivo.
  const origin = request.headers.get('Origin') || ''
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-HTMLBox-*',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  }
}

function jsonError(msg, status, request) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  })
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const path = url.pathname
    const method = request.method

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) })
    }

    // Endpoint interno para uploads R2.
    //
    //   - Dev (HTMLBOX_R2_MODE=local-fake): acepta cualquier PUT con key que
    //     matchee el namespace del box (sin firma).
    //   - Prod: requiere firma HMAC (sig=HMAC(secret, key + "\n" + exp))
    //     y exp no expirado. La firma la genera uploads.js:postUploadUrl.
    if (path === '/api/_local/upload' && method === 'PUT') {
      const url = new URL(request.url)
      const key = url.searchParams.get('key')
      if (!key || !key.startsWith('tenants/') || !key.endsWith('.html')) {
        return jsonError('bad_key', 400, request)
      }
      const m = key.match(/^tenants\/([^/]+)\/boxes\/([^/]+)\/versions\/v(\d+)\.html$/)
      if (!m) return jsonError('key_out_of_namespace', 400, request)

      // En prod validamos HMAC; en dev (local-fake) lo salteamos.
      if (env.HTMLBOX_R2_MODE !== 'local-fake') {
        const exp = Number(url.searchParams.get('exp'))
        const sig = url.searchParams.get('sig')
        if (!exp || !sig) return jsonError('missing_signature', 400, request)
        if (exp < Math.floor(Date.now() / 1000)) return jsonError('expired', 401, request)
        const expectedSig = await hmacSignHex(env.HTMLBOX_SESSION_SECRET, `${key}\n${exp}`)
        if (sig !== expectedSig) return jsonError('invalid_signature', 403, request)
      }

      const ct = request.headers.get('Content-Type') || 'text/html'
      const buf = await request.arrayBuffer()
      await env.BUCKET.put(key, buf, { httpMetadata: { contentType: ct } })
      return new Response(JSON.stringify({ ok: true, key, size: buf.byteLength }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
      })
    }

    // Sirve la UI admin (Alpine.js)
    if (path.startsWith('/admin') || path === '/') {
      if (path === '/') return Response.redirect(`${url.protocol}//${url.host}/admin/`, 302)
      // Trae el archivo desde ASSETS (binding wrangler).
      const assetPath = path === '/admin' || path === '/admin/'
        ? '/index.html'
        : path.replace(/^\/admin/, '') || '/index.html'
      if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
        const assetUrl = new URL(assetPath, url)
        const res = await env.ASSETS.fetch(assetUrl)
        if (res.ok) return res
      }
      return new Response(ADMIN_PLACEHOLDER_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    // Health check
    if (path === '/health') {
      return new Response(JSON.stringify({ ok: true, env: env.HTMLBOX_ENV || 'unknown' }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
      })
    }

    try {
      // Auth
      if (path.startsWith('/api/auth/')) {
        const res = await handleAuth(request, env, ctx, path)
        return withCors(res, request)
      }

      // Tenants / workspaces / me
      if (path.startsWith('/api/me/') || path.startsWith('/api/tenants')) {
        // sub: el segmento después de /api/tenants/:id si aplica
        const sub = path.startsWith('/api/tenants/')
          ? path.slice('/api/tenants/'.length).split('/')[0]
          : null
        const res = await handleTenants(request, env, ctx, path, sub, method)
        return withCors(res, request)
      }

      // Boxes CRUD y sub-rutas
      const boxesListMatch = path === '/api/boxes' || path === '/api/boxes/'
      if (boxesListMatch && (method === 'GET' || method === 'POST')) {
        const res = await handleBoxes(request, env, ctx, path, null, method)
        return withCors(res, request)
      }

      // Endpoints internos (runtime → control-plane)
      if (path.startsWith('/api/internal/')) {
        const res = await handleInternal(request, env, ctx, path, method)
        return withCors(res, request)
      }

      // AI assistido (Fase 4) — analyze-html, analyses, apply
      if (path.startsWith('/api/ai/')) {
        const res = await handleAi(request, env, ctx, path, method)
        return withCors(res, request)
      }

      const boxMatch = path.match(/^\/api\/boxes\/([a-z0-9]+)(.*)$/)
      if (boxMatch) {
        const boxId = boxMatch[1]
        const rest = boxMatch[2]

        // CRUD de box (GET/PATCH/DELETE)
        if (rest === '' && (method === 'GET' || method === 'PATCH' || method === 'DELETE')) {
          const res = await handleBoxes(request, env, ctx, path, boxId, method)
          return withCors(res, request)
        }

        // Sub-rutas de upload / versionado
        const res = await handleUploads(request, env, ctx, path, boxId, rest, method)
        return withCors(res, request)
      }

      return jsonError('not_found', 404, request)
    } catch (err) {
      console.error('[control-plane] error:', err)
      return jsonError(err?.message || 'internal_error', 500, request)
    }
  },

  // Cron trigger maestro (§7) — se monta aquí en fase 4.
  async scheduled(_event, _env, _ctx) {
    // placeholder. La fase 4 reemplaza esto con el dispatcher de flows schedule.
  },
}

function withCors(res, request) {
  const newHeaders = new Headers(res.headers)
  const origin = request.headers.get('Origin') || ''
  newHeaders.set('Access-Control-Allow-Origin', origin || '*')
  newHeaders.set('Access-Control-Allow-Credentials', 'true')
  newHeaders.set('Vary', 'Origin')
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: newHeaders,
  })
}

async function hmacSignHex(secret, message) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const ADMIN_PLACEHOLDER_HTML = `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8"><title>HTMLBox — Admin</title>
<script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<script src="https://cdn.jsdelivr.net/npm/alpinejs@3.13.5/dist/cdn.min.js" defer></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center">
  <div class="text-center max-w-md">
    <h1 class="text-2xl font-bold mb-2">HTMLBox Admin Panel</h1>
    <p class="text-slate-400 text-sm">Si ves esto, el binding ASSETS no resolvió <code>/index.html</code>. Verificá <code>wrangler.jsonc → assets.directory</code>.</p>
  </div>
</body>
</html>
`