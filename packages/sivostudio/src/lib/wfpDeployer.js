// src/lib/wfpDeployer.js — deploya el per-box script de SIVOSTUDIO al namespace WFP.
//
// DUPLICADO de packages/control-plane/src/lib/wfpDeployer.js (aislamiento total
// del experimento — no comparte código con control-plane, como dice el spec
// §1 de docs/htmlbox-spec-sivostudio.md).
//
// Namespace hardcoded a `sivostudio-experiments` (separado del de prod
// `htmlbox-boxes`). El bundle del box template se importa desde
// src/box-worker-bundle.mjs.js (generado por scripts/build.mjs, ~370 KB).
//
// Por ahora el box template NO tiene bindings — todo (editores, HTML del
// usuario) está embebido como string. Cuando Fase 4 enchufe flow-engine y
// Fase 5 agregue R2 storage, los bindings van a aparecer acá.
//
// Endpoint Cloudflare (REST, módulo format, multipart/form-data):
//   PUT /accounts/{accountId}/workers/dispatch/namespaces/{namespace}/scripts/{scriptName}
//   Authorization: Bearer {WFP_DEPLOY_TOKEN}  (scoped: solo namespace)
//
// Body: multipart con dos parts:
//   - metadata: JSON con { main_module, compatibility_date, compatibility_flags }
//   - box-{boxId}.mjs: el bundle (application/javascript+module)
//
// Ver packages/control-plane/src/lib/wfpDeployer.js para el rationale completo
// de multipart vs JSON envuelto, y de por qué NO usamos la SDK cloudflare.

import BOX_WORKER_BUNDLE_SOURCE from '../box-worker-bundle.mjs.js'

const BOX_ID_PATTERN = /^[a-z0-9]{16}$/
const NAMESPACE_PATTERN = /^[a-z][a-z0-9_-]{0,38}$/
const SCRIPT_NAME_PREFIX = 'box-'
const STUDIO_NAMESPACE = 'sivostudio-experiments'

function assertValid(boxId) {
  if (!BOX_ID_PATTERN.test(boxId)) {
    throw new Error(`studio wfpDeployer: boxId inválido ${JSON.stringify(boxId)}`)
  }
  if (!NAMESPACE_PATTERN.test(STUDIO_NAMESPACE)) {
    // Validación defensiva — STUDIO_NAMESPACE es constante, pero si alguien
    // la edita arriba y rompe el regex, fallamos acá en vez de tirar un
    // 400 raro desde Cloudflare.
    throw new Error(`studio wfpDeployer: namespace hardcoded inválido ${JSON.stringify(STUDIO_NAMESPACE)}`)
  }
}

// Mapea bindings que el per-box script necesita:
//   - STUDIO_R2 (R2) para storage del box (HTML/flow/vars en Fase 5).
//
// El binding es OPCIONAL — solo se incluye si el launcher lo tiene
// configurado en su wrangler.jsonc. Permite deployar el bundle ANTES
// de crear el bucket R2; los endpoints /editor/api/* y / devuelven 503
// hasta que se cree (degradación elegante, código defensivo en box-template).
//
// Cuando el bucket existe:
//   1. Crear via `wrangler r2 bucket create htmlbox-studio-boxes` (o dashboard).
//   2. Agregar el binding al wrangler.jsonc del launcher:
//      "r2_buckets": [{ "binding": "STUDIO_R2", "bucket_name": "htmlbox-studio-boxes" }]
//   3. Redeployar — el próximo PUT al WFP incluirá el binding.
function buildBindings(env) {
  const bindings = []
  // env.STUDIO_R2 existe si el launcher tiene el binding configurado en su
  // wrangler.jsonc. La API de Cloudflare verifica que el bucket exista al
  // momento del PUT, así que si no está, lo excluimos.
  if (env.STUDIO_R2 && typeof env.STUDIO_R2.put === 'function') {
    bindings.push({ type: 'r2_bucket', name: 'STUDIO_R2', bucket_name: 'htmlbox-studio-boxes' })
  }
  return bindings
}

function buildMetadataJson(env, fileName) {
  return JSON.stringify({
    main_module: fileName,
    bindings: buildBindings(env),
    compatibility_date: '2026-08-01',
    compatibility_flags: ['nodejs_compat'],
  })
}

// deployStudioBoxWorker — deploya el per-box script al namespace WFP de sivostudio.
// Devuelve { ok: true, scriptName } si Cloudflare responde 200; lanza con
// mensaje del body si falla (4xx/5xx).
//
// Parámetros:
//   env       — env de sivostudio (necesita WFP_DEPLOY_TOKEN y
//               HTMLBOX_CLOUDFLARE_ACCOUNT_ID).
//   boxId     — ID del box (16 chars [a-z0-9]).
//   opts      — { bundleSource }: override del bundle (tests).
export async function deployStudioBoxWorker(env, boxId, opts = {}) {
  assertValid(boxId)

  const token = env.WFP_DEPLOY_TOKEN
  if (!token) {
    throw new Error('studio wfpDeployer: WFP_DEPLOY_TOKEN no configurado — corré ./scripts/setup-wfp-experiments.sh')
  }

  const accountId = env.HTMLBOX_CLOUDFLARE_ACCOUNT_ID
  if (!accountId) {
    throw new Error('studio wfpDeployer: HTMLBOX_CLOUDFLARE_ACCOUNT_ID no configurado')
  }

  const scriptName = `${SCRIPT_NAME_PREFIX}${boxId}`
  const fileName = `${scriptName}.mjs`
  const source = opts.bundleSource ?? BOX_WORKER_BUNDLE_SOURCE

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/dispatch/namespaces/${encodeURIComponent(STUDIO_NAMESPACE)}/scripts/${encodeURIComponent(scriptName)}`

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
    },
    body: form,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`studio wfpDeployer: Cloudflare respondió ${res.status} — ${text.slice(0, 500)}`)
  }

  return { ok: true, scriptName }
}

// deleteStudioBoxWorker — borra el per-box script del namespace WFP de sivostudio.
// Devuelve { ok: true } si Cloudflare responde 200; lanza si falla.
//   404 ("Worker not found") se considera éxito idempotente — la limpieza
//   es best-effort y queremos que el cron no falle si el script ya no existe.
export async function deleteStudioBoxWorker(env, boxId) {
  assertValid(boxId)

  const token = env.WFP_DEPLOY_TOKEN
  if (!token) {
    throw new Error('studio wfpDeployer: WFP_DEPLOY_TOKEN no configurado')
  }

  const accountId = env.HTMLBOX_CLOUDFLARE_ACCOUNT_ID
  if (!accountId) {
    throw new Error('studio wfpDeployer: HTMLBOX_CLOUDFLARE_ACCOUNT_ID no configurado')
  }

  const scriptName = `${SCRIPT_NAME_PREFIX}${boxId}`
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/dispatch/namespaces/${encodeURIComponent(STUDIO_NAMESPACE)}/scripts/${encodeURIComponent(scriptName)}`

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
    throw new Error(`studio wfpDeployer.delete: Cloudflare respondió ${res.status} — ${text.slice(0, 500)}`)
  }
  return { ok: true }
}