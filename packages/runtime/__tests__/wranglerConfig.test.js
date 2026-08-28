// __tests__/wranglerConfig.test.js — regression guards para wrangler.jsonc.
//
// Estos tests existen porque el dev experience se rompe silenciosamente
// si alguien remueve flags críticos de runtime/wrangler.jsonc:
//   - dispatch_namespaces.remote=true es REQUERIDO en dev local — wrangler
//     NO emula dispatch namespaces, sin este flag cada boot escupe un
//     warning y el BOX_DISPATCH binding queda inerte.
//   - routes *.sivocloud.dev son las URLs públicas — sin ellas el Worker
//     no responde a subdominios reales.
//
// Si alguno de estos tests falla, alguien cambió el config sin entender
// el blast radius. Reversión: leer el git log del archivo.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
// here = packages/runtime/__tests__/
// target = packages/runtime/wrangler.jsonc (sibling of __tests__/)
const runtimeWrangler = path.resolve(here, '..', 'wrangler.jsonc')

test('runtime/wrangler.jsonc existe y parsea como JSON', async () => {
  const raw = await fs.readFile(runtimeWrangler, 'utf8')
  // Quitamos los comentarios `//` para que sea JSON válido (jsonc con strips).
  const stripped = raw.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const cfg = JSON.parse(stripped)
  assert.equal(cfg.name, 'htmlbox-runtime')
})

test('runtime/wrangler.jsonc tiene BOX_DISPATCH binding con remote=true', async () => {
  const raw = await fs.readFile(runtimeWrangler, 'utf8')
  const stripped = raw.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const cfg = JSON.parse(stripped)
  const bindings = cfg.dispatch_namespaces || []
  const boxDispatch = bindings.find(b => b.binding === 'BOX_DISPATCH')
  assert.ok(boxDispatch, 'BOX_DISPATCH binding debe existir (WFP Phase 2)')
  assert.equal(boxDispatch.namespace, 'htmlbox-boxes')
  assert.equal(
    boxDispatch.remote,
    true,
    'BOX_DISPATCH.remote debe ser true — wrangler --local no emula dispatch namespaces, sin este flag el binding queda inerte y aparece un warning en cada dev'
  )
})

test('runtime/wrangler.jsonc sigue publicando *.sivocloud.dev/*', async () => {
  const raw = await fs.readFile(runtimeWrangler, 'utf8')
  const stripped = raw.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const cfg = JSON.parse(stripped)
  const routes = cfg.routes || []
  const sivo = routes.filter(r => r.zone_name === 'sivocloud.dev')
  assert.ok(sivo.length >= 1, 'debe haber al menos una ruta en zone sivocloud.dev')
  // El patrón DEBE terminar en `/*` para matchear subpaths — sin el `/*`,
  // Cloudflare solo matchea el path raíz `/` y todo lo demás se queda en
  // el limbo (522 en 20s). Bug confirmado en wrangler 4.127+.
  const hasWild = sivo.some(r => r.pattern === '*.sivocloud.dev/*')
  assert.ok(hasWild, 'ruta *.sivocloud.dev/* (wildcard subdomains para tenant boxes) debe existir')
})

test('runtime/wrangler.jsonc NO tiene BOX_DISPATCH comentado (debe estar activo)', async () => {
  const raw = await fs.readFile(runtimeWrangler, 'utf8')
  // Patrón: línea `// ` justo antes de "BOX_DISPATCH" indica que está comentado.
  // Si alguien comenta el binding por error, este test atrapa el cambio.
  const commentedOut = /\/\/\s*\{?\s*"binding"\s*:\s*"BOX_DISPATCH"/.test(raw)
  assert.equal(commentedOut, false, 'BOX_DISPATCH NO debe estar comentado — WFP está prendido')
})