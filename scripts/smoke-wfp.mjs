// scripts/smoke-wfp.mjs — valida end-to-end que wfpDeployer funciona contra
// el namespace real. Crea un script dummy, verifica que aparece en el
// namespace, lo borra.
//
// Uso: node scripts/smoke-wfp.mjs
// Requisitos: control-plane deployado con WFP_DEPLOY_TOKEN secret set.

import { deployBoxWorker, deleteBoxWorker } from '../packages/control-plane/src/lib/wfpDeployer.js'
import BOX_WORKER_BUNDLE_SOURCE from '../packages/control-plane/src/ui-partials/box-worker.mjs.js'

const ACCOUNT_ID = 'bbd6bb71e68887eb0fa9cc8e872ed588'
const NAMESPACE = 'htmlbox-boxes'
const SMOKE_BOX_ID = 'wfpsmoketest0001'

async function listScripts() {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces/${NAMESPACE}/scripts`,
    {
      headers: { Authorization: `Bearer ${process.env.WFP_DEPLOY_TOKEN}` },
    }
  )
  if (!res.ok) {
    throw new Error(`list failed: ${res.status} ${await res.text()}`)
  }
  const data = await res.json()
  return data.result.map(s => s.id)
}

async function main() {
  console.log(`[smoke] usando namespace: ${NAMESPACE}`)
  console.log(`[smoke] boxId de prueba: ${SMOKE_BOX_ID}`)
  console.log()

  console.log(`[smoke] leyendo WFP_DEPLOY_TOKEN de env...`)
  if (!process.env.WFP_DEPLOY_TOKEN) {
    console.error('ERROR: WFP_DEPLOY_TOKEN no está en env.')
    console.error('Cargá el token así: WFP_DEPLOY_TOKEN=xxx node scripts/smoke-wfp.mjs')
    process.exit(1)
  }

  const env = {
    WFP_DEPLOY_TOKEN: process.env.WFP_DEPLOY_TOKEN,
    HTMLBOX_R2_BUCKET_NAME: 'htmlbox-content',
    HTMLBOX_PUBLIC_ORIGIN: 'https://controlplane.htmlbox.dev',
  }

  // Cleanup previo (idempotente — por si quedó un smoke viejo).
  console.log(`[smoke] cleanup previo (delete idempotente)...`)
  try {
    const r = await deleteBoxWorker(env, ACCOUNT_ID, NAMESPACE, SMOKE_BOX_ID)
    console.log(`[smoke] delete previo: ${JSON.stringify(r)}`)
  } catch (e) {
    console.log(`[smoke] delete previo: ${e.message} (ok si 404)`)
  }

  console.log()
  console.log(`[smoke] scripts ANTES del deploy:`)
  let before = await listScripts()
  console.log(`  count=${before.length}: ${before.slice(0, 5).join(', ')}${before.length > 5 ? '...' : ''}`)
  console.log()

  console.log(`[smoke] deployBoxWorker...`)
  const out = await deployBoxWorker(env, ACCOUNT_ID, NAMESPACE, SMOKE_BOX_ID, {
    bundleSource: BOX_WORKER_BUNDLE_SOURCE,
  })
  console.log(`[smoke] deploy result: ${JSON.stringify(out)}`)
  console.log()

  // Verificar que aparece en el namespace.
  console.log(`[smoke] verificando que aparece en el namespace...`)
  const after = await listScripts()
  const found = after.includes(`box-${SMOKE_BOX_ID}`)
  if (!found) {
    console.error(`FAIL: box-${SMOKE_BOX_ID} no aparece en el namespace`)
    console.error(`  scripts en namespace: ${after.join(', ')}`)
    process.exit(1)
  }
  console.log(`[smoke] ✓ box-${SMOKE_BOX_ID} está en el namespace`)
  console.log(`[smoke]   count después: ${after.length} (antes: ${before.length})`)
  console.log()

  // Verificar el contenido del script vía GET.
  console.log(`[smoke] GET script content (verificando que no esté vacío)...`)
  const getRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces/${NAMESPACE}/scripts/box-${SMOKE_BOX_ID}`,
    {
      headers: { Authorization: `Bearer ${process.env.WFP_DEPLOY_TOKEN}` },
    }
  )
  if (!getRes.ok) {
    console.error(`GET failed: ${getRes.status}`)
    process.exit(1)
  }
  const scriptData = await getRes.json()
  console.log(`[smoke] script info:`)
  console.log(`  created_on: ${scriptData.result.created_on}`)
  console.log(`  modified_on: ${scriptData.result.modified_on}`)
  console.log(`  handlers: ${JSON.stringify(scriptData.result.handlers)}`)
  console.log(`  modules: ${JSON.stringify(Object.keys(scriptData.result.modules || {}))}`)
  console.log()

  // Cleanup final.
  console.log(`[smoke] cleanup final (delete)...`)
  const r2 = await deleteBoxWorker(env, ACCOUNT_ID, NAMESPACE, SMOKE_BOX_ID)
  console.log(`[smoke] delete result: ${JSON.stringify(r2)}`)

  const final = await listScripts()
  console.log(`[smoke] scripts después del cleanup: ${final.length}`)
  console.log()

  if (final.length !== before.length) {
    console.error(`FAIL: namespace no quedó limpio (antes ${before.length}, después ${final.length})`)
    console.error(`  remaining: ${final.join(', ')}`)
    process.exit(1)
  }
  console.log(`[smoke] ✓ namespace quedó como estaba antes del test`)
  console.log()
  console.log(`[smoke] ✓ TODOS LOS PASOS OK — wfpDeployer funciona end-to-end`)
}

main().catch(e => {
  console.error(`[smoke] FATAL:`, e)
  process.exit(1)
})