// src/lib/bootstrap.js — bootstrap del flow-engine dentro del Worker `auth`.
//
// Espejo de packages/control-plane/src/lib/flows.js. El patrón es idéntico:
// APP_CACHE memoizado por signature de env + monkey-patch del nodo
// cloudflare-email para inyectar tenantId/projectId default
// (single-tenant-dev) — el upstream requiere ambos en `ctx` y
// createFlowEngineApp todavía no acepta inyectarlos como opción.
//
// Forward-compat: cuando createFlowEngineApp acepte defaultTenantId /
// defaultProjectId, el monkey-patch se borra.

import { createFlowEngineApp } from 'flow-engine/app'
import { coreNodes as flowCoreNodes } from 'flow-engine/nodes'

// Mapa nombre → flow.json. Se completa en worker.js con los flows
// importados (los pasa el caller, este helper solo monta el app).
export const HTTP_NODE_ROOT = '/api/flows'

let cloudflareEmailPatched = false
export function ensureCloudflareEmailPatched() {
  if (cloudflareEmailPatched) return
  const node = flowCoreNodes.find((n) => n && n.type === 'cloudflare-email')
  if (!node || typeof node.execute !== 'function') return
  const origExecute = node.execute
  node.execute = async function (n, msg, ctx) {
    if (!ctx.tenantId) ctx.tenantId = 'single-tenant-dev'
    if (!ctx.projectId) ctx.projectId = 'single-tenant-dev'
    return origExecute.call(this, n, msg, ctx)
  }
  cloudflareEmailPatched = true
}

function buildFlowEnvSignature(env) {
  if (!env || typeof env !== 'object') return 'no-env'
  return Object.keys(env).sort().join('|')
}

const APP_CACHE = new Map()

/**
 * Devuelve el flow-engine app, memoizado por signature de env.
 * @param {object} flows mapa nombre → flow JSON array
 * @param {object} env bindings del Worker
 */
export async function getFlowEngineApp(flows, env) {
  ensureCloudflareEmailPatched()
  const sig = buildFlowEnvSignature(env)
  const cacheKey = `${sig}::${Object.keys(flows).sort().join(',')}`
  let app = APP_CACHE.get(cacheKey)
  if (app) return app
  app = await createFlowEngineApp({
    runtime: 'worker',
    flows,
    configNodes: [],
    mountPath: HTTP_NODE_ROOT,
    httpNodeRoot: HTTP_NODE_ROOT,
    exposeErrorDetails: false,
  })
  APP_CACHE.set(cacheKey, app)
  return app
}

/**
 * Helper: invoca un flow por nombre sin roundtrip HTTP. Construye un
 * Request sintético apuntando al http-in del flow y llama handleWorker
 * internamente. Mismo patrón que runFlow() del control-plane.
 *
 * @param {object} app flow-engine app (de getFlowEngineApp)
 * @param {string} flowName nombre en FLOWS (ej. 'auth-request')
 * @param {object} payload body JSON
 * @param {object} env bindings del Worker
 * @param {object} ctx execution context (opcional)
 * @returns {Promise<object>} respuesta parseada del http-response del flow
 */
export async function invokeFlow(app, flowName, payload, env, ctx) {
  const req = new Request(`https://flow-engine.local${HTTP_NODE_ROOT}/${flowName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const res = await app.handleWorker(req, env, ctx)
  if (!res) {
    throw new Error(`invokeFlow: flow "${flowName}" no respondió (¿existe un http-in con path "/${flowName}" en flows/<archivo>.flow.json?)`)
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`invokeFlow: flow "${flowName}" respondió ${res.status}: ${errBody}`)
  }
  return await res.json()
}
