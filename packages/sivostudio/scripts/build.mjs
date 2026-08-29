#!/usr/bin/env node
// scripts/build.mjs — bundlea box-template/worker.js → dist/box-worker.mjs.
//
// Qué hace:
//   1. Lee box-template/editors/app-studio.html.txt y editor-vanilla.html.txt.
//   2. Reemplaza los placeholders __APP_STUDIO_HTML_PLACEHOLDER__ y
//      __EDITOR_VANILLA_HTML_PLACEHOLDER__ en box-template/worker.js por
//      template literals (backticks) del contenido de cada editor, escapando
//      `\`, `` ` `` y `$` para que sean JS-safe.
//   3. Bundlea con esbuild → dist/box-worker.mjs (formato ESM, target esnext,
//      minify — Workers for Platforms acepta hasta 1 MB).
//   4. Genera src/box-worker-bundle.mjs.js (un wrapper que exporta el bundle
//      como string) para que src/worker.js lo importe como módulo regular
//      y wfpDeployer lo suba a WFP. Workers no tienen node:fs.
//
// src/box-worker-bundle.mjs.js SE COMMITEA (es el artefacto importable por
// el launcher-worker); dist/box-worker.mjs es intermediate y se regenera.
// Mismo patrón que packages/runtime-box-worker/scripts/build.mjs.

import { build } from 'esbuild'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const TEMPLATE_PATH = path.join(root, 'box-template', 'worker.js')
const APP_STUDIO_PATH = path.join(root, 'box-template', 'editors', 'app-studio.html.txt')
const EDITOR_VANILLA_PATH = path.join(root, 'box-template', 'editors', 'editor-vanilla.html.txt')

const OUT_DIR = path.join(root, 'dist')
const BUNDLE_PATH = path.join(OUT_DIR, 'box-worker.mjs')
const STRING_WRAPPER_PATH = path.join(root, 'src', 'box-worker-bundle.mjs.js')

// 1) Leer fuentes.
const [template, appStudioHtml, editorVanillaHtml] = await Promise.all([
  fs.readFile(TEMPLATE_PATH, 'utf8'),
  fs.readFile(APP_STUDIO_PATH, 'utf8'),
  fs.readFile(EDITOR_VANILLA_PATH, 'utf8'),
])

// 2) Reemplazar placeholders por template literals con el contenido.
//
//    ¿Por qué template literals (backticks) y no JSON.stringify?
//    JSON.stringify devuelve `"<html>..."` (envuelto en comillas dobles).
//    Si lo meto directo en el código fuente queda:
//        const X = '"<html>..."'
//    Que es JS válido PERO produce: string vacío + identificador `"<html>..."`
//    sin cerrar. Por eso falla esbuild con "Expected ; but found help".
//
//    Con template literals queda:
//        const X = `<html>...`
//    Que sí es válido — los backticks encierran todo el contenido, sin
//    importar comillas simples/dobles internas.
//
//    Escapamos manualmente lo que rompería un template literal:
//      `  →  \`     (cierre del template)
//      $  →  \$     (inicio de ${...} interpolation)
//      \  →  \\     (escape de backslash)
//    El HTML de App Studio no debería contener ninguno de los tres, pero
//    el escape defensivo cuesta nada y previene foot-guns.
function escapeForTemplateLiteral(str) {
  return str
    .replaceAll('\\', '\\\\')
    .replaceAll('`', '\\`')
    .replaceAll('$', '\\$')
}

if (!template.includes("'__APP_STUDIO_HTML_PLACEHOLDER__'")) {
  throw new Error(
    `Placeholder '__APP_STUDIO_HTML_PLACEHOLDER__' (con comillas) no encontrado en ${TEMPLATE_PATH}. ` +
    'El template debe tener la forma: const X = \'__PLACEHOLDER__\'\n' +
    '¿Renombraste la constante sin actualizar este build?',
  )
}
if (!template.includes("'__EDITOR_VANILLA_HTML_PLACEHOLDER__'")) {
  throw new Error(
    `Placeholder '__EDITOR_VANILLA_HTML_PLACEHOLDER__' (con comillas) no encontrado en ${TEMPLATE_PATH}.`,
  )
}

// Reemplazamos el LITERAL ENTERO (placeholder + comillas exteriores) por el
// template literal con backticks. Sin esto, las comillas simples del template
// original quedarían al lado del backtick: const X = '`<html>...` → inválido.
const inlined = template
  .replace("'__APP_STUDIO_HTML_PLACEHOLDER__'", '`' + escapeForTemplateLiteral(appStudioHtml) + '`')
  .replace("'__EDITOR_VANILLA_HTML_PLACEHOLDER__'", '`' + escapeForTemplateLiteral(editorVanillaHtml) + '`')

const inlinedPath = path.join(OUT_DIR, 'box-worker.inlined.mjs')
await fs.mkdir(OUT_DIR, { recursive: true })
await fs.writeFile(inlinedPath, inlined, 'utf8')

// 3) Bundle con esbuild.
//
// Truco importante: `external: ['node:*']` deja los imports `node:fs/promises`,
// `node:path`, `node:url` (que usa flow-engine internamente) TAL CUAL en el
// bundle. Esbuild NO intenta resolverlos como paquetes npm (lo cual falla
// con `platform: 'neutral'`). En runtime, Workers con `nodejs_compat` los
// resuelve nativo. El `compatibility_flags: ['nodejs_compat']` está en
// wfpDeployer.js (metadata del PUT al namespace WFP).
//
// Truco 2: `loader: { '.html': 'text' }` para que esbuild pueda resolver
// el dynamic import `await import('./editor-vanilla/index.html')` que hace
// flow-engine en runtime='worker'. Sin esto, esbuild tira "No loader is
// configured for .html files". wrangler tiene `rules: [{type: Text, ...}]`
// para lo mismo, pero acá bundleamos con esbuild directo.
//
// Truco 3: `loader: { '.flow.json': 'json' }` por si flow-engine importa
// flows como JSON modules.
await build({
  entryPoints: [inlinedPath],
  outfile: BUNDLE_PATH,
  bundle: true,
  format: 'esm',
  target: 'esnext',
  platform: 'neutral',
  // mainFields explícito: con `platform: 'neutral'`, esbuild NO respeta
  // automáticamente el `main`/`module` field de los package.json de las
  // dependencias. Acá le decimos: probá `module` primero (ESM moderno),
  // después `main` (CJS legacy). Sin esto, jsonata (que tiene `main` pero
  // no `module`) no se resuelve.
  mainFields: ['module', 'main'],
  conditions: ['import', 'module', 'default'],
  external: ['node:*'],
  loader: {
    '.html': 'text',
    '.json': 'json',
  },
  minify: true,
  sourcemap: false,
  banner: { js: '// htmlbox sivostudio box-template (built ' + new Date().toISOString() + ')' },
  metafile: false,
  logLevel: 'info',
})

// 4) Wrapper que exporta el bundle como string — para que wfpDeployer lo
//    importe como módulo regular (sin wrangler Text rule). Patrón copiado
//    de runtime-box-worker/scripts/build.mjs.
const bundleSource = await fs.readFile(BUNDLE_PATH, 'utf8')
const encoded = JSON.stringify(bundleSource)
const wrapper =
  `// Auto-generated by packages/sivostudio/scripts/build.mjs.\n` +
  `// Do NOT edit by hand — re-run \`npm run build -w @htmlbox/sivostudio\` instead.\n` +
  `export default ${encoded};\n`
await fs.writeFile(STRING_WRAPPER_PATH, wrapper, 'utf8')

const bundleSizeKb = (Buffer.byteLength(bundleSource, 'utf8') / 1024).toFixed(1)
console.log(`✓ built ${path.relative(root, BUNDLE_PATH)} (${bundleSizeKb} KB)`)
console.log(`✓ wrapper ${path.relative(root, STRING_WRAPPER_PATH)}`)
console.log(`✓ inlined intermediate cleaned: ${path.relative(root, inlinedPath)}`)

// Limpiar el intermediate inlined — solo lo necesitamos como entry para
// esbuild, no como artefacto.
await fs.unlink(inlinedPath)
