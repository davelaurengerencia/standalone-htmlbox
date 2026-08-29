#!/usr/bin/env node
// scripts/inline-app-studio.mjs — embebe erp-build.js dentro de index.html.
//
// El prototipo de SIVO App Studio vive fuera de este repo, en
// /Chats/projects/repl-svelte/. Son DOS archivos: index.html (markup + módulo
// JS que orquesta) y erp-build.js (bundle compilado de Svelte, 132 KB).
// El HTML referencia erp-build.js como <script src="./erp-build.js">.
//
// Para embeberlo en el bundle del per-box worker de sivostudio (que no tiene
// filesystem relativo — todo es texto inlineado), este script reemplaza el
// <script src> por un <script> con el contenido completo de erp-build.js.
//
// Output: box-template/editors/app-studio.html.txt (~315 KB, un solo archivo).
//
// Fuente canónica:
//   ${SOURCE_DIR}/index.html    → markup + módulo JS
//   ${SOURCE_DIR}/erp-build.js  → bundle Svelte compilado
//
// Override por env:
//   SIVO_APP_STUDIO_SOURCE_DIR — ruta al directorio del prototipo
//                                 (default: $REPO_ROOT/../../Chats/projects/repl-svelte)

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const sivostudioRoot = path.resolve(here, '..')
const repoRoot = path.resolve(sivostudioRoot, '..', '..')

const sourceDir = process.env.SIVO_APP_STUDIO_SOURCE_DIR
  || path.resolve(repoRoot, '..', '..', '..', 'Chats', 'projects', 'repl-svelte')

const indexHtmlPath = path.join(sourceDir, 'index.html')
const erpBuildPath = path.join(sourceDir, 'erp-build.js')
const outputPath = path.join(sivostudioRoot, 'box-template', 'editors', 'app-studio.html.txt')

const indexHtml = await fs.readFile(indexHtmlPath, 'utf8')
const erpBuildJs = await fs.readFile(erpBuildPath, 'utf8')

// Validación: el index.html tiene que tener el <script src="./erp-build.js">.
const SCRIPT_TAG = '<script src="./erp-build.js"></script>'
if (!indexHtml.includes(SCRIPT_TAG)) {
  throw new Error(
    `No se encontró "${SCRIPT_TAG}" en ${indexHtmlPath}. ` +
    '¿Cambió la estructura del prototipo upstream?',
  )
}

// Inlining: escapamos el contenido del bundle dentro de un <script>...</script>.
// erp-build.js es bundle minificado de Svelte y CONTIENE la secuencia
// "</script>" adentro de strings literales (el runtime de Svelte maneja
// innerHTML de <script>). Si la dejáramos tal cual, el parser HTML cerraría
// nuestro <script> antes de tiempo.
//
// Solución estándar: reemplazar "</script>" por "<\/script>" adentro del
// contenido inlineado. En JS, '\/' === '/' dentro de strings y es seguro en
// regex/comments. No cambia el comportamiento del bundle.
//
// Bundle de Svelte suele tener 30-100 ocurrencias — logueamos la cantidad
// real como info, no como error.
const ESCAPED = '<\\/script>'
const occurrences = erpBuildJs.split('</script>').length - 1
const erpBuildEscaped = erpBuildJs.replaceAll('</script>', ESCAPED)

const inlined = indexHtml.replace(SCRIPT_TAG, `<script>\n${erpBuildEscaped}\n</script>`)

await fs.mkdir(path.dirname(outputPath), { recursive: true })
await fs.writeFile(outputPath, inlined, 'utf8')

const sizeKb = (Buffer.byteLength(inlined, 'utf8') / 1024).toFixed(1)
console.log(`✓ ${path.relative(repoRoot, outputPath)} (${sizeKb} KB)`)
console.log(`  source: ${path.relative(repoRoot, indexHtmlPath)}`)
console.log(`  inlined: ${path.relative(repoRoot, erpBuildPath)}`)
