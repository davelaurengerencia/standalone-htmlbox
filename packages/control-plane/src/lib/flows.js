// src/lib/flows.js — bootstrap del flow-engine dentro del control-plane.
//
// ARQUITECTURA ACTUAL (post-Fase 4 / auth-centralizado):
//
//   routes/internal.js    ┐
//                         ├──► runFlow() ──┐
//                                            ├──► app.handleWorker(req, env, ctx)
//                                            │
//   flows/app-magic-link.flow.json ─────────────┘
//
// El envío de magic links de PLATAFORMA se migró al paquete `auth`
// (ver docs/htmlbox-spec-auth-centralizado.md §8). Acá queda solo el flow
// de tenant-app-users, que es el que invoca runtime vía
// /api/internal/send-app-magic-link.
//
// Todo el envío de emails pasa por el flow-engine corriendo como librería
// dentro del control-plane. El binding `EMAIL` (Cloudflare Email Sending)
// se usa indirectamente, vía el nodo `cloudflare-email` del flow-engine.
//
// Por qué existe `runFlow()` y `handleFlowWorker()`:
//   - handleFlowWorker(): HTTP requests externos (ej. smoke tests via curl).
//   - runFlow(): llamadas in-process desde routes/*.js. Construye un Request
//     sintético apuntando al http-in del flow y llama handleWorker
//     internamente. Sin roundtrip HTTP.

import { createFlowEngineApp } from 'flow-engine/app'
import { coreNodes as flowCoreNodes } from 'flow-engine/nodes'

import appMagicLinkFlow from '../flows/app-magic-link.flow.json' with { type: 'json' }

// Mapa nombre → flow.json. Agregar nuevos flows acá.
export const FLOWS = {
  'app-magic-link': appMagicLinkFlow,
}

// Path prefix: el flow-engine expone webhooks (http-in) en
// `${httpNodeRoot}${flow.path}`. Lo seteamos en '/api/flows' para que
// todos los flows vivan bajo ese namespace.
const HTTP_NODE_ROOT = '/api/flows'

// ----------------------------------------------------------------------------
// Monkey-patch del nodo cloudflare-email
// ----------------------------------------------------------------------------
// El upstream (`_flow-engine/nodes/nodes-cloudflare/cloudflare-email.js`)
// requiere `ctx.tenantId` y `ctx.projectId` (multi-tenant estricto).
//
// En nuestro control-plane, single-tenant en dev, esos no están seteados —
// y `createFlowEngineApp` no expone opciones para inyectarlos. Para no
// modificar el upstream, patcheamos acá:
//
//   1. Tomamos el nodo `cloudflare-email` de `flowCoreNodes` (exportado por
//      flow-engine/nodes).
//   2. Envolvemos su `execute()` para inyectar defaults si faltan.
//
// Forward-compat: cuando `createFlowEngineApp` acepte `defaultTenantId` /
// `defaultProjectId`, esto se vuelve trivial de remover.

let cloudflareEmailPatched = false
function ensureCloudflareEmailPatched() {
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

// ----------------------------------------------------------------------------
// Cache del flow-engine app, memoizado por signature de env
// ----------------------------------------------------------------------------

function buildFlowEnvSignature(env) {
  if (!env || typeof env !== 'object') return 'no-env'
  return Object.keys(env).sort().join('|')
}

const APP_CACHE = new Map()

export async function getFlowEngineApp(env) {
  ensureCloudflareEmailPatched()
  const sig = buildFlowEnvSignature(env)
  let app = APP_CACHE.get(sig)
  if (app) return app

  app = await createFlowEngineApp({
    runtime: 'worker',
    flows: FLOWS,
    configNodes: [],
    mountPath: HTTP_NODE_ROOT,
    httpNodeRoot: HTTP_NODE_ROOT,
    exposeErrorDetails: false,
  })
  APP_CACHE.set(sig, app)
  return app
}

// HTTP entry (para tests externos via curl / webhooks manuales).
export async function handleFlowWorker(request, env, ctx) {
  const app = await getFlowEngineApp(env)
  return await app.handleWorker(request, env, ctx)
}

/**
 * Invoca un flow por nombre sin roundtrip HTTP. Construye un Request
 * sintético apuntando al http-in del flow y llama handleWorker del
 * flow-engine internamente. Parsea la respuesta JSON.
 *
 * @param {string} flowName nombre registrado en FLOWS (ej. 'magic-link')
 * @param {object} payload objeto con los campos que el flow espera (ej. { to, subject, text, html })
 * @param {object} env bindings del Worker (igual que env en fetch handler)
 * @param {object} ctx execution context (opcional — undefined OK)
 * @returns {Promise<{ emailMessageId?: string, emailSentTo?: string[] }>}
 */
export async function runFlow(flowName, payload, env, ctx) {
  const app = await getFlowEngineApp(env)
  const req = new Request(`https://flow-engine.local${HTTP_NODE_ROOT}/${flowName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const res = await app.handleWorker(req, env, ctx)
  if (!res) {
    throw new Error(`runFlow: flow "${flowName}" no respondió (¿existe un http-in con path "/${flowName}" en flows/<archivo>.flow.json?)`)
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`runFlow: flow "${flowName}" respondió ${res.status}: ${errBody}`)
  }
  return await res.json()
}
