// src/lib/wfpDeployer.js — deploya el per-box script al namespace WFP.
//
// Llamado desde routes/boxes.js#createBox después de crear la fila en D1.
// Si el deploy falla, el caller setea `wfp_status='failed'` y loguea —
// mismo criterio que ya usa Turso (best-effort: la box queda creada
// aunque el provisioning falle).
//
// Endpoint Cloudflare (REST, módulo format, multipart/form-data):
//   PUT /accounts/{accountId}/workers/dispatch/namespaces/{namespace}/scripts/{scriptName}
//   Authorization: Bearer {WFP_DEPLOY_TOKEN}     (scoped: solo namespace)
//
// Body: multipart con dos parts:
//   - metadata: JSON con { main_module, bindings, compatibility_date, ... }
//   - box-worker.mjs: el bundle (application/javascript+module)
//
// La API oficial (Cloudflare docs 2026-05-05) usa multipart — NO JSON
// envuelto con base64. Cualquier approach con `application/json` +
// `files[].content` base64 va a fallar con 415 (Unsupported Media Type).
// Workers tienen FormData nativo desde 2023.
//
// El bundle del per-box script NO se lee desde disco en runtime (Workers
// no tienen node:fs). Se importa vía el módulo ESM generado por
// packages/runtime-box-worker/scripts/build.mjs (postbuild step).
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

// Valida los inputs antes de gastar el PUT.
function assertValid(boxId, namespace) {
  if (!BOX_ID_PATTERN.test(boxId)) {
    throw new Error(`wfpDeployer: boxId inválido ${JSON.stringify(boxId)}`)
  }
  if (!namespace || !/^[a-z][a-z0-9_-]{0,38}$/.test(namespace)) {
    throw new Error(`wfpDeployer: namespace inválido ${JSON.stringify(namespace)}`)
  }
}

// Arma el metadata JSON que va como part 'metadata' del multipart.
// main_module tiene que matchear el nombre del archivo que vamos a
// subir (box-{boxId}.mjs) — Cloudflare resuelve el módulo por ese path.
function buildMetadataJson(env, fileName) {
  return JSON.stringify({
    main_module: fileName,
    bindings: buildBindings(env),
    compatibility_date: env.HTMLBOX_WFP_COMPAT_DATE || '2026-08-01',
    compatibility_flags: ['nodejs_compat'],
  })
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
  const fileName = `${scriptName}.mjs`  // box-{boxId}.mjs — único por box
  const source = opts.bundleSource ?? BOX_WORKER_BUNDLE_SOURCE

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/dispatch/namespaces/${encodeURIComponent(namespace)}/scripts/${encodeURIComponent(scriptName)}`

  // FormData multipart — Workers tienen FormData nativo desde 2023.
  // Sintaxis: formData.append(name, value, filename) para files.
  // El filename del archivo (part) TIENE que matchear main_module en
  // metadata — Cloudflare resuelve el módulo por ese path.
  const form = new FormData()
  form.append(
    'metadata',
    new Blob([buildMetadataJson(env, fileName)], { type: 'application/json' })
  )
  form.append(
    fileName,
    new Blob([source], { type: 'application/javascript+module' }),
    fileName
  )

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      // NO seteamos Content-Type — fetch lo calcula del FormData (con boundary).
    },
    body: form,
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

// Hooks para tests (mockear inputs).
export const _internal = { buildBindings, assertValid, buildMetadataJson }
