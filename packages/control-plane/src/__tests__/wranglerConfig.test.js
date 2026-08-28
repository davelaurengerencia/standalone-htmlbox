// __tests__/wranglerConfig.test.js — regression guards para control-plane/wrangler.jsonc.
//
// Estos tests existen porque el dev experience se rompe silenciosamente
// si alguien remueve flags críticos del config:
//   - Routes controlplane.sivocloud.dev/* son la URL pública del admin.
//   - Vars top-level (HTMLBOX_PORTAL_ORIGIN, etc.) son las URLs de prod —
//     dev usa las mismas por ahora (limitación documentada en AGENTS.md §2:
//     service bindings en wrangler 4 --remote NO propagan vars de env.dev,
//     así que los cross-origin URLs apuntan a prod incluso en dev).
//
// Si alguno de estos tests falla, alguien cambió el config sin entender el
// blast radius. Reversión: leer el git log del archivo.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
// here = packages/control-plane/src/__tests__/
// target = packages/control-plane/wrangler.jsonc (3 dirs up)
const cpWrangler = path.resolve(here, '..', '..', 'wrangler.jsonc')

test('control-plane/wrangler.jsonc existe y parsea como JSON', async () => {
  const raw = await fs.readFile(cpWrangler, 'utf8')
  // Quitamos los comentarios `//` para que sea JSON válido (jsonc con strips).
  const stripped = raw.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const cfg = JSON.parse(stripped)
  assert.equal(cfg.name, 'htmlbox-control-plane')
})

test('control-plane/wrangler.jsonc sigue publicando controlplane.sivocloud.dev/*', async () => {
  const raw = await fs.readFile(cpWrangler, 'utf8')
  const stripped = raw.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const cfg = JSON.parse(stripped)
  const routes = cfg.routes || []
  const cp = routes.filter(r => r.zone_name === 'sivocloud.dev')
  assert.ok(cp.length >= 1, 'debe haber al menos una ruta en zone sivocloud.dev')
  // El patrón DEBE terminar en `/*` para matchear subpaths (mismo bug que runtime).
  const hasCp = cp.some(r => r.pattern === 'controlplane.sivocloud.dev/*')
  assert.ok(hasCp, 'ruta controlplane.sivocloud.dev/* (admin) debe existir')
})

test('control-plane/wrangler.jsonc vars top-level apuntan a prod (dev usa los mismos)', async () => {
  const raw = await fs.readFile(cpWrangler, 'utf8')
  const stripped = raw.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const cfg = JSON.parse(stripped)
  const vars = cfg.vars || {}
  // Vars críticas de prod. En dev, el magic link vía portal proxy usa
  // estos vars (no los de env.dev — wrangler 4 service binding no
  // propaga env-specific vars). Workaround: editar el host del magic
  // link manualmente, o testear via `curl http://controlplane.localhost:8781/...`
  // (que sí pasa por la preview env.dev del control-plane local).
  assert.equal(vars.HTMLBOX_PORTAL_ORIGIN, 'https://studio.sivocloud.dev',
    'top-level HTMLBOX_PORTAL_ORIGIN debe apuntar al portal prod')
  assert.equal(vars.HTMLBOX_PUBLIC_ORIGIN, 'https://controlplane.sivocloud.dev',
    'top-level HTMLBOX_PUBLIC_ORIGIN debe apuntar a controlplane prod')
  assert.equal(vars.HTMLBOX_RUNTIME_ORIGIN, 'https://sivocloud.dev',
    'top-level HTMLBOX_RUNTIME_ORIGIN debe apuntar al apex prod')
  assert.equal(vars.HTMLBOX_SESSION_DOMAIN, '.sivocloud.dev',
    'top-level HTMLBOX_SESSION_DOMAIN debe ser ".sivocloud.dev" — cookies cross-subdomain en prod')
  assert.equal(vars.HTMLBOX_EMAIL_MODE, 'prod',
    'top-level HTMLBOX_EMAIL_MODE debe ser "prod" — Email Service en prod')
  assert.equal(vars.HTMLBOX_ENV, 'production',
    'top-level HTMLBOX_ENV debe ser "production"')
})