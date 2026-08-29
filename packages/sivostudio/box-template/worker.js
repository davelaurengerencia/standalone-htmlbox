// box-template/worker.js — Worker per-box para sivostudio.
//
// Este es el TEMPLATE: cada box creado por sivostudio arranca con una copia
// de este bundle desplegada en `sivostudio-experiments` con nombre
// `box-{boxId}`.
//
// Cuatro zonas en un solo script:
//   /                          → app del usuario (placeholder hasta deploy)
//   /editor/frontend           → App Studio (Svelte, compilado en browser)
//   /editor/backend            → Flow Editor (flow-engine con mountPath)
//   /editor/variables          → form de vars/secrets
//   /editor/api/*              → endpoints internos del editor (Fase 5)
//   /api/*                     → backend real (flow-engine http nodes)
//
// El front-worker (sivostudio/src/worker.js) le pasa la request YA con el
// path completo (no le quita el prefijo /box/:boxId, coherente con el
// patrón actual de runtime-core/src/boxDispatch.js). Este worker recibe
// /box/{boxId}/editor/frontend y decide qué zona servir en base al subpath.
//
// Los assets del editor (App Studio, flow-engine editor-vanilla) están
// embebidos como strings — generados por scripts/build.mjs a partir de
// box-template/editors/*.html.txt. El bundler los inlinea como constantes
// en el bundle final.
//
// Flow-engine:
//   - createFlowEngineApp() se monta con mountPath='/editor/backend' y
//     httpNodeRoot='/api'. Ver nota en docs/htmlbox-spec-sivostudio.md §2
//     sobre por qué mountPath evita el rewrite/proxy manual.
//   - Esta fase arranca con `flows: []` (sin flows). Cuando Fase 5
//     agregue POST /editor/api/flow, los flows se persisten en R2 y se
//     rehidratan al iniciar.

import { createFlowEngineApp, extractPlatformBindings } from 'flow-engine/app'
import { coreNodes } from 'flow-engine/nodes'

const APP_STUDIO_HTML = '__APP_STUDIO_HTML_PLACEHOLDER__'
const EDITOR_VANILLA_HTML = '__EDITOR_VANILLA_HTML_PLACEHOLDER__'

// Flows iniciales — objeto vacío. Cuando el usuario guarde flows en
// /editor/backend (Fase 5), se persisten en R2 y se rehidratan al iniciar
// el box worker. Recordá: en `runtime: 'worker'` el editor es SOLO LECTURA
// (POST /_editor/api/* devuelve 501 fijo — ver AGENTS.md de flow-engine),
// así que el endpoint custom /editor/api/flow es el que escribe.
// Estructura esperada: { [nombreDelFlow]: flowJsonArray }.
const FLOWS = {}

const EMPTY_APP_HTML = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Box vacío</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           min-height: 100vh; display: flex; align-items: center; justify-content: center;
           background: #f8fafc; color: #0f172a; margin: 0; }
    .box { max-width: 480px; padding: 2rem; text-align: center; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { color: #64748b; margin-bottom: 1.5rem; }
    a { display: inline-block; padding: 0.5rem 1rem; background: #6366f1;
        color: white; text-decoration: none; border-radius: 6px; }
    a:hover { background: #4f46e5; }
  </style>
</head>
<body>
  <main class="box">
    <h1>Box vacío</h1>
    <p>Todavía no se hizo el primer deploy. Empezá por el editor de frontend.</p>
    <a href="/editor/frontend">Abrir App Studio</a>
  </main>
</body>
</html>`

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><title>Próximamente</title></head>
<body style="font-family: sans-serif; padding: 2rem;">
  <h1>Zona en construcción</h1>
  <p>Esta parte del editor se habilita en fases posteriores del experimento.</p>
  <p><a href="/">← Volver al box</a></p>
</body>
</html>`

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } })
}

// dispatchZone — devuelve la zona que matchea el path, sin importar el
// prefijo /box/:boxId. Esto desacopla el worker del routing externo: el
// front-worker pasa la URL entera y nosotros parseamos el subpath.
function dispatchZone(pathname) {
  // Quitar prefijo /box/:boxId si está presente.
  let p = pathname
  const m = pathname.match(/^\/box\/[a-z0-9]{16}(\/.*)?$/)
  if (m) p = m[1] || '/'

  if (p === '/' || p === '') return { zone: 'app', subpath: '/' }
  if (p === '/editor/frontend' || p.startsWith('/editor/frontend/')) {
    return { zone: 'editor-frontend', subpath: p }
  }
  if (p === '/editor/backend' || p.startsWith('/editor/backend/')) {
    return { zone: 'editor-backend', subpath: p }
  }
  if (p === '/editor/variables' || p.startsWith('/editor/variables/')) {
    return { zone: 'editor-variables', subpath: p }
  }
  if (p.startsWith('/editor/api/')) {
    return { zone: 'editor-api', subpath: p }
  }
  if (p.startsWith('/api/') || p === '/api') {
    return { zone: 'api', subpath: p }
  }
  return { zone: 'app', subpath: p }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const { zone, subpath } = dispatchZone(url.pathname)

    switch (zone) {
      case 'editor-frontend':
        return htmlResponse(APP_STUDIO_HTML)

      case 'editor-backend': {
        // Flow Editor (vanilla) + flow-engine con mountPath.
        // mountPath='/editor/backend' resuelve el "rewrite/proxy" del spec §2
        // nativamente: GET /editor/backend sirve editor-vanilla/index.html,
        // GET /editor/backend/_editor/api/* sirve la API del editor.
        const app = await createFlowEngineApp({
          runtime: 'worker',
          flows: FLOWS,
          mountPath: '/editor/backend',
          httpNodeRoot: '/api',
          nodes: coreNodes,
          // platformBindings: extractPlatformBindings(env) — necesario para que
          // los nodos cloudflare-* (D1, KV, R2, Email) lean bindings del env.
          // AGENTS.md de flow-engine: "Pasale `platformBindings:
          // extractPlatformBindings(env)` si tu Worker los expone directo en
          // `env` (caso single-tenant)".
          platformBindings: extractPlatformBindings(env),
        })
        // Rewritear la URL para que flow-engine vea paths relativos al mountPath
        // (porque flow-engine matchea contra pathname.startsWith(mountPath)).
        const editorReq = new Request(
          new URL(subpath, request.url).toString(),
          request,
        )
        const editorRes = await app.handleWorker(editorReq, env, ctx)
        if (editorRes) return editorRes
        return htmlResponse(PLACEHOLDER_HTML, 404)
      }

      case 'editor-variables':
        // TODO Fase 5: form real con vars/secrets del box
        return htmlResponse(PLACEHOLDER_HTML)

      case 'editor-api':
        // TODO Fase 5: POST /editor/api/{frontend,flow,variables,deploy}
        return new Response('Not implemented yet', { status: 501 })

      case 'api': {
        // Backend real: http nodes de flow-engine.
        const app = await createFlowEngineApp({
          runtime: 'worker',
          flows: FLOWS,
          mountPath: '/editor/backend',
          httpNodeRoot: '/api',
          nodes: coreNodes,
          platformBindings: extractPlatformBindings(env),
        })
        const apiRes = await app.handleHttp(request, env, ctx)
        if (apiRes) return apiRes
        return notFound()
      }

      case 'app':
      default:
        return htmlResponse(EMPTY_APP_HTML)
    }
  },
}
