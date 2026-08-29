// box-template/worker.js — Worker per-box para sivostudio.
//
// Entry-point que esbuild bundlea en scripts/build.mjs. La lógica vive
// en lib/handlers.js (testeable). Acá solo orquestamos: dispatch de zonas
// + creación del flow-engine app con mountPath nativo.

import { createFlowEngineApp, extractPlatformBindings } from 'flow-engine/app'
import { coreNodes } from 'flow-engine/nodes'
import {
  getBoxId,
  dispatchZone,
  handleApp,
  handleEditorFrontend,
  handleEditorVariables,
  handleEditorApi,
  loadStoredFlows,
  htmlResponse,
  jsonResponse,
  PLACEHOLDER_HTML,
} from './lib/handlers.js'

// App Studio embebido como template literal — generado por scripts/build.mjs
// reemplazando el placeholder __APP_STUDIO_HTML_PLACEHOLDER__ en el bundle.
const APP_STUDIO_HTML = '__APP_STUDIO_HTML_PLACEHOLDER__'

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const { zone, subpath } = dispatchZone(url.pathname)

    // Las zonas que necesitan boxId (app, editor-backend, editor-api, api)
    // lo sacan del header X-HTMLBox-Box-Id que inyecta el launcher. Sin
    // boxId válido → 400.
    const needsBoxId = zone === 'app' || zone === 'editor-backend' || zone === 'editor-api' || zone === 'api'
    if (needsBoxId) {
      const boxId = getBoxId(request)
      if (!boxId) {
        return new Response('Missing or invalid X-HTMLBox-Box-Id header', {
          status: 400,
          headers: { 'Content-Type': 'text/plain' },
        })
      }

      switch (zone) {
        case 'app':
          return await handleApp(env, boxId)

        case 'editor-backend': {
          // Flow Editor (vanilla) + flow-engine con mountPath nativo.
          // mountPath='/editor/backend' resuelve el "rewrite/proxy" del spec §2
          // nativamente: GET /editor/backend sirve editor-vanilla/index.html,
          // GET /editor/backend/_editor/api/* sirve la API interna del editor
          // (lectura — POST es 501 fijo en runtime='worker', ver AGENTS.md de
          // flow-engine). La persistencia de flows se hace por el endpoint
          // custom /editor/api/flow (Fase 5).
          const storedFlows = await loadStoredFlows(env, boxId)
          const app = await createFlowEngineApp({
            runtime: 'worker',
            flows: storedFlows,
            mountPath: '/editor/backend',
            httpNodeRoot: '/api',
            nodes: coreNodes,
            platformBindings: extractPlatformBindings(env),
          })
          // Rewritear la URL para que flow-engine vea paths relativos al mountPath
          // (porque flow-engine matchea contra pathname.startsWith(mountPath)).
          const editorReq = new Request(new URL(subpath, request.url).toString(), request)
          const editorRes = await app.handleWorker(editorReq, env, ctx)
          if (editorRes) return editorRes
          return htmlResponse(PLACEHOLDER_HTML, 404)
        }

        case 'editor-api':
          return await handleEditorApi(request, env, boxId, subpath)

        case 'api': {
          // Backend real: http nodes de flow-engine (httpNodeRoot='/api').
          const storedFlows = await loadStoredFlows(env, boxId)
          const app = await createFlowEngineApp({
            runtime: 'worker',
            flows: storedFlows,
            mountPath: '/editor/backend',
            httpNodeRoot: '/api',
            nodes: coreNodes,
            platformBindings: extractPlatformBindings(env),
          })
          const apiRes = await app.handleHttp(request, env, ctx)
          if (apiRes) return apiRes
          return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } })
        }
      }
    }

    // Zonas que NO necesitan boxId.
    switch (zone) {
      case 'editor-frontend':
        return handleEditorFrontend(APP_STUDIO_HTML)
      case 'editor-variables':
        return handleEditorVariables()
      default:
        // Zone 'app' con pathname distinto de '/' cae acá si no necesita boxId
        // (no debería pasar — 'app' está en needsBoxId). Devolvemos placeholder.
        return htmlResponse(PLACEHOLDER_HTML)
    }
  },
}