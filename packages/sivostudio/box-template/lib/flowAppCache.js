// box-template/lib/flowAppCache.js — cache del flow-engine app.
//
// Por qué: antes cada hit a /api/* (path caliente del box) hacía:
//   1. loadStoredFlows() — R2.get()
//   2. createFlowEngineApp({...}) — reconstruye el grafo de nodos
// Eso perdía el estado en memoria de flow-engine (ctx.flow, ctx.global)
// y agregaba latencia innecesaria en el camino caliente.
//
// Solución (ver docs/htmlbox-spec-sivostudio-fix-flow-app-cache.md):
// cache a nivel de módulo keyed por boxId, invalidado por etag vía
// R2.head(). Cuando el etag cambia, se relee + reconstruye.
//
// Key por boxId: crítico porque Cloudflare multiplexa isolates — un
// mismo isolate puede servir varios boxIds. Sin el key, el flow de un
// box se serviría a otro.
//
// Espera de mejora:
//   - Memory cap (LRU/TTL) — para fase experimental OK.
//   - Race condition en cold start concurrente — OK por simplicidad.
//
// Tests: box-template/__tests__/flowAppCache.test.js

import { createFlowEngineApp as defaultCreateFlowEngineApp, extractPlatformBindings } from 'flow-engine/app'
import { coreNodes as defaultCoreNodes } from 'flow-engine/nodes'
import { loadStoredFlows } from './handlers.js'

// APP_OPTIONS constantes — extraídas a una constante porque se repiten
// en editor-backend y api. Si en el futuro hay que cambiar configNodes,
// mountPath, etc., un solo lugar.
const APP_OPTIONS = {
  runtime: 'worker',
  configNodes: [],
  mountPath: '/editor/backend',
  httpNodeRoot: '/api',
}

/**
 * Crea un getter de flow-engine app con cache keyed por boxId.
 *
 * @param {Object} deps — dependencias inyectables (para tests).
 * @param {Function} deps.createFlowEngineApp — createFlowEngineApp de flow-engine/app.
 * @param {Object} deps.coreNodes — coreNodes de flow-engine/nodes.
 * @param {Function} deps.loadStoredFlows — loader de flows desde R2 (default: ./handlers.js).
 * @param {Map} deps.cache — cache inyectable (default: Map() nuevo).
 * @returns {Function} getFlowApp(env, boxId) — async, devuelve la app cacheada.
 */
export function createFlowAppGetter({
  createFlowEngineApp = defaultCreateFlowEngineApp,
  coreNodes = defaultCoreNodes,
  loadStoredFlows: loadFn = loadStoredFlows,
  cache = new Map(),
} = {}) {
  async function getFlowApp(env, boxId) {
    const key = `box-${boxId}/flow.json`
    let currentEtag = null
    if (env.STUDIO_R2) {
      try {
        const head = await env.STUDIO_R2.head(key)
        currentEtag = head?.etag ?? null
      } catch { /* ignore — fallback a get */ }
    }

    const cached = cache.get(boxId)
    if (cached && currentEtag !== null && currentEtag === cached.etag) {
      return cached.app
    }

    const flows = await loadFn(env, boxId)
    const app = await createFlowEngineApp({
      ...APP_OPTIONS,
      flows,
      nodes: coreNodes,
      platformBindings: extractPlatformBindings(env),
    })
    cache.set(boxId, { etag: currentEtag, app })
    return app
  }

  // Devuelve también el cache para tests/inspección.
  return Object.assign(getFlowApp, { cache })
}