// src/lib/wfpDeployer.js — deploya el per-box script al namespace WFP.
//
// Llamado desde routes/boxes.js#createBox después de crear la fila en D1.
// Si el deploy falla, el caller setea `wfp_status='failed'` y loguea —
// mismo criterio que ya usa Turso (best-effort: la box queda creada
// aunque el provisioning falle).
//
// Endpoint Cloudflare (REST, módulo format):
//   PUT /accounts/{accountId}/workers/dispatch/namespaces/{namespace}/scripts/{scriptName}
//   Authorization: Bearer {WFP_DEPLOY_TOKEN}     (scoped: solo namespace)
//   Content-Type: application/json
//   Body: {
//     "metadata": { "main_module": "box-worker.mjs", "bindings": [...] },
//     "files":    [{ "name": "box-worker.mjs", "content": "<base64>",
//                    "type": "application/javascript+module" }]
//   }
//
// El bundle del per-box script NO se lee desde disco en runtime (Workers
// no tienen node:fs). Se importa vía wrangler Text rule — ver
// control-plane/wrangler.jsonc "src/ui-partials/*.mjs.txt". El sync
// lo hace packages/runtime-box-worker/scripts/build.mjs como postbuild
// step.
//
// Por qué no usamos la SDK cloudflare (`workersForPlatforms.dispatch.namespaces.scripts.update`):
// suma ~1 MB al bundle. Para UN solo PUT es preferible REST directo.
//
// Por qué scoped token: el spec (htmlbox-spec-workers-for-platforms.md)
// lo exige — un token con `Workers Scripts:Edit` plano permite deployar
// contra cualquier Worker de la cuenta. El token de WFP se genera con
// resource restringido al namespace 'htmlbox-boxes'.

import BOX_WORKER_BUNDLE_SOURCE from '../ui-partials/box-worker.mjs.js'

const BOX_ID_PATTERN = /^[a-z0-9]{16}$/
const SCRIPT_NAME_PREFIX = 'box-'

// Mapea bindings que el per-box script necesita:
//   - BUCKET (R2) para leer el HTML del box
//   - HTMLBOX_CONTROL_PLANE_ORIGIN (var) para construir URLs a control-plane
function buildBindings(env) {
  const bindings = [
    { type: 'r2_bucket', name: 'BUCKET', bucket_name: env.HTMLBOX_R2_BUCKET_NAME || 'htmlbox-content' },
    { type: 'plain_text', name: 'HTMLBOX_CONTROL_PLANE_ORIGIN', text: env.HTMLBOX_PUBLIC_ORIGIN || env.HTMLBOX_RUNTIME_ORIGIN || '' },
  ]
  return bindings
}

// Convierte el bundle source (string UTF-8) a base64 puro. Cloudflare
// espera base64 estándar en `files[].content`.
//
// Usamos TextEncoder para UTF-8 correcto (caracteres > U+00FF se expanden
// a multi-byte). TextEncoder existe tanto en Workers isolate como en Node.
function bundleSourceToBase64(source) {
  const bytes = new TextEncoder().encode(source)
  let bin = ''
  // btoa() solo acepta Latin-1 byte por byte; cada byte 0..255 se mapea
  // 1:1 a un char de Latin-1, así que es seguro.
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

// Valida los inputs antes de gastar el PUT.
function assertValid(boxId, namespace) {
  if (!BOX_ID_PATTERN.test(boxId)) {
    throw new Error(`wfpDeployer: boxId inválido ${JSON.stringify(boxId)}`)
  }
  if (!namespace || !/^[a-z][a-z0-9_-]{0,38}$/.test(namespace)) {
    throw new Error(`wfpDeployer: namespace inválido ${JSON.stringify(namespace)}`)
  }
}

// deployBoxWorker — deploya el per-box script al namespace WFP.
// Devuelve { ok: true, scriptName } si Cloudflare responde 200; lanza con
// mensaje del body si falla (4xx/5xx).
//
// Parámetros:
//   env         — env de control-plane (necesita WFP_DEPLOY_TOKEN,
//                 HTMLBOX_PUBLIC_ORIGIN, HTMLBOX_R2_BUCKET_NAME).
//   accountId   — Cloudflare account ID (bbd6bb71... en prod).
//   namespace   — nombre del dispatch namespace ('htmlbox-boxes').
//   boxId       — ID del box (16 chars [a-z0-9]).
//   opts        — { bundleSource }: override del source del bundle (tests).
export async function deployBoxWorker(env, accountId, namespace, boxId, opts = {}) {
  assertValid(boxId, namespace)

  const token = env.WFP_DEPLOY_TOKEN
  if (!token) {
    throw new Error('wfpDeployer: WFP_DEPLOY_TOKEN no configurado en control-plane')
  }

  const scriptName = `${SCRIPT_NAME_PREFIX}${boxId}`
  const source = opts.bundleSource ?? BOX_WORKER_BUNDLE_SOURCE
  const bundleBase64 = bundleSourceToBase64(source)

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/dispatch/namespaces/${encodeURIComponent(namespace)}/scripts/${encodeURIComponent(scriptName)}`

  const body = {
    metadata: {
      main_module: 'box-worker.mjs',
      bindings: buildBindings(env),
      compatibility_date: env.HTMLBOX_WFP_COMPAT_DATE || '2026-08-01',
      compatibility_flags: ['nodejs_compat'],
    },
    files: [
      {
        name: 'box-worker.mjs',
        content: bundleBase64,
        type: 'application/javascript+module',
      },
    ],
  }

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`wfpDeployer: Cloudflare respondió ${res.status} — ${text.slice(0, 500)}`)
  }

  return { ok: true, scriptName }
}

// deleteBoxWorker — borra el per-box script del namespace WFP.
// Devuelve { ok: true } si Cloudflare responde 200; lanza si falla.
//   404 ("Worker not found") se considera éxito idempotente — la limpieza
//   es best-effort y queremos que deleteBox() en control-plane no falle
//   si el script ya no existe.
export async function deleteBoxWorker(env, accountId, namespace, boxId) {
  assertValid(boxId, namespace)

  const token = env.WFP_DEPLOY_TOKEN
  if (!token) {
    throw new Error('wfpDeployer: WFP_DEPLOY_TOKEN no configurado en control-plane')
  }

  const scriptName = `${SCRIPT_NAME_PREFIX}${boxId}`
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/dispatch/namespaces/${encodeURIComponent(namespace)}/scripts/${encodeURIComponent(scriptName)}`

  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  })

  if (res.status === 404) {
    return { ok: true, idempotent: true }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`wfpDeployer.delete: Cloudflare respondió ${res.status} — ${text.slice(0, 500)}`)
  }
  return { ok: true }
}

// Hooks para tests (mockear bundleSource o buildBindings).
export const _internal = { bundleSourceToBase64, buildBindings, assertValid }
