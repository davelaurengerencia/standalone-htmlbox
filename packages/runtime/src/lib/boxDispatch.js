// src/lib/boxDispatch.js — glue dispatcher-side para Workers for Platforms (Phase 2).
//
// Phase 1 (WFP scaffolding apagado): con binding BOX_DISPATCH comentado
// en wrangler.jsonc, dispatchToBoxWorker siempre devuelve null y el
// dispatcher cae al path viejo (fetchActiveHtml + serveBoxHtml).
// Phase 2: se prende el binding, dispatchToBoxWorker invoca el per-box
// script (packages/runtime-box-worker), y dispatchToBoxWorker devuelve
// la Response del script o null si el script no existe en el namespace.
//
// Comportamiento de dispatchToBoxWorker:
//
//   - null     → binding ausente, o .get(name) tiró "Worker not found",
//                o worker.fetch() tiró "Worker not found".
//                (caller debe caer al path viejo)
//   - Response → vino del per-box script; lo devolvemos tal cual.
//   - throw    → cualquier otro error (no se silencia — queremos verlo en
//                logs en vez de pretender que el path viejo lo arregla).

import {
  BOX_ID_HEADER,
  TENANT_HEADER,
  SLUG_HEADER,
  VIS_HEADER,
  BOX_ID_PATTERN,
  isWorkerNotFoundError,
} from '@htmlbox/runtime-core'

// Validamos boxId antes de armar el script name "box-{boxId}". El dispatcher
// siempre tiene un boxId válido (viene de resolver.js, que ya validó contra
// BOX_ID_PATTERN en su regex interno), pero igual validamos acá como
// defensa-en-profundidad por si un día alguien refactorea resolver.js y
// empieza a meter un string crudo sin normalizar.
function assertValidBoxId(boxId) {
  if (!BOX_ID_PATTERN.test(boxId)) {
    throw new Error(`boxDispatch: boxId inválido ${JSON.stringify(boxId)}`)
  }
}

// Clona el Request con TODOS los headers de contexto que el per-box script
// necesita: boxId + tenantSlug + boxSlug + visibility. Cloudflare Workers
// Request es inmutable; hay que construir uno nuevo copiando headers + body.
// En GET (el caso del serving de boxes) no hay body, así que la copia es
// barata. Para POST/PUT/PATCH copiamos body con duplex:'half' (Cloudflare
// exige duplex en body streaming).
//
// `resolved` viene de resolver.js (resolveByShareId / resolveByTenantAndSlug)
// y tiene shape { boxId, tenantSlug, boxSlug, visibility }. Validamos
// boxId contra el regex; el resto se confía en resolver (sus inputs
// también están validados contra regex).
export function withDispatchContext(request, resolved) {
  assertValidBoxId(resolved.boxId)
  const headers = new Headers(request.headers)
  headers.set(BOX_ID_HEADER, resolved.boxId)
  headers.set(TENANT_HEADER, resolved.tenantSlug)
  headers.set(SLUG_HEADER, resolved.boxSlug)
  // visibility puede no estar en algunos shapes viejos; default 'private'.
  headers.set(VIS_HEADER, resolved.visibility === 'public' ? 'public' : 'private')
  const init = {
    method: request.method,
    headers,
    redirect: request.redirect,
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body
    init.duplex = 'half'
  }
  return new Request(request.url, init)
}

// dispatchToBoxWorker — entry point para los bloques /s/{shareId} y
// /t/{tenantSlug}/{boxSlug} del runtime dispatcher. Devuelve:
//   - null si el binding no existe o el script no se encuentra
//   - la Response del per-box script si todo OK
//   - throw para cualquier otro error (propaga, no silencia)
export async function dispatchToBoxWorker(env, request, resolved) {
  // Fast path: si no hay binding (Phase 1) o es falsy, devolvemos null
  // para que el caller caiga al path viejo. No es un error — es el modo
  // de operación cuando BOX_DISPATCH no está configurado todavía.
  if (!env || !env.BOX_DISPATCH) return null

  const newReq = withDispatchContext(request, resolved)

  // .get(name) puede tirar "Worker not found" si el script no existe en
  // el namespace. Eso NO es un error — es la señal para caer al path viejo
  // (boxes viejos sin deployar el script per-box, o fallo del control-plane
  // al deployar uno nuevo).
  let worker
  try {
    worker = env.BOX_DISPATCH.get(`box-${resolved.boxId}`)
  } catch (e) {
    if (isWorkerNotFoundError(e)) return null
    throw e
  }
  // Defensivo: si .get() devolvió undefined/null sin throw (no debería
  // pasar según el contrato de Cloudflare, pero por las dudas).
  if (!worker) return null

  // worker.fetch() también puede tirar "Worker not found" si el script
  // se borró entre .get() y .fetch() (carrera con un deploy concurrente).
  try {
    return await worker.fetch(newReq)
  } catch (e) {
    if (isWorkerNotFoundError(e)) return null
    throw e
  }
}
