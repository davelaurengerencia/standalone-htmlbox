// __tests__/editorSplit.test.js
//
// Tests para findEditableBlocks() y spliceBlock() — los helpers del
// editor split-view (htmlbox-spec-editor-split-view.md). Estos helpers
// están definidos como funciones globales dentro de
// `packages/portal/src/ui-partials/app-script.html.txt` (entre los
// marcadores `// ============ Editor split-view` y
// `// ============ Constantes de seed ============`). Para testearlos sin
// duplicar el código, los extraemos con regex y los ejecutamos en un
// vm sandbox (Node 18+ soporta el flag 'd' en RegExp, igual que el
// browser).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const appScriptPath = path.join(
  here, '..', 'src', 'ui-partials', 'app-script.html.txt'
)

function loadHelpers() {
  const src = fs.readFileSync(appScriptPath, 'utf8')
  const startMarker = '// ============ Editor split-view'
  const endMarker = '// ============ Constantes de seed ============'
  const startIdx = src.indexOf(startMarker)
  const endIdx = src.indexOf(endMarker, startIdx)
  assert.notEqual(startIdx, -1, 'start marker not found in app-script.html.txt — ¿se renombró la sección?')
  assert.notEqual(endIdx, -1, 'end marker not found in app-script.html.txt')
  const helpersSrc = src.slice(startIdx, endIdx)
  const sandbox = { module: { exports: {} } }
  const wrapped = `${helpersSrc}\nmodule.exports = { findEditableBlocks, countEditableBlocks, spliceBlock };`
  vm.runInNewContext(wrapped, sandbox)
  return sandbox.module.exports
}

const { findEditableBlocks, countEditableBlocks, spliceBlock } = loadHelpers()

test('findEditableBlocks: detecta exactamente un <script> inline', () => {
  const html = '<html><body><script>const x = 1</script></body></html>'
  const r = findEditableBlocks(html)
  assert.ok(r.script, 'debería detectar el <script>')
  assert.equal(r.script.content, 'const x = 1')
  assert.equal(r.script.innerStart, html.indexOf('const x = 1'))
  assert.equal(r.script.innerEnd, html.indexOf('const x = 1') + 'const x = 1'.length)
  assert.equal(r.style, null)
})

test('findEditableBlocks: ignora <script src=...> externos', () => {
  const html = '<head><script src="https://cdn.tailwindcss.com"></script></head><body><script>const x = 1</script></body>'
  const r = findEditableBlocks(html)
  assert.ok(r.script, 'debería encontrar SOLO el script inline (no el externo)')
  assert.equal(r.script.content, 'const x = 1')
})

test('findEditableBlocks: detecta exactamente un <style>', () => {
  const html = '<head><style>.foo { color: red }</style></head><body></body>'
  const r = findEditableBlocks(html)
  assert.equal(r.script, null)
  assert.ok(r.style)
  assert.equal(r.style.content, '.foo { color: red }')
})

test('findEditableBlocks: 0 <script> → null', () => {
  const html = '<html><body><p>hola</p></body></html>'
  assert.equal(findEditableBlocks(html).script, null)
})

test('findEditableBlocks: 2+ <script> → null (filtro intencional v1)', () => {
  const html = '<html><body><script>a</script><script>b</script></body></html>'
  assert.equal(findEditableBlocks(html).script, null)
})

test('findEditableBlocks: 0 <style> → null', () => {
  const html = '<html><body><p>x</p></body></html>'
  assert.equal(findEditableBlocks(html).style, null)
})

test('findEditableBlocks: 2+ <style> → null', () => {
  const html = '<html><head><style>a</style><style>b</style></head></html>'
  assert.equal(findEditableBlocks(html).style, null)
})

test('findEditableBlocks: script externo + script inline → encuentra el inline', () => {
  const html = '<script src="a.js"></script><script>inline</script>'
  const r = findEditableBlocks(html)
  assert.ok(r.script)
  assert.equal(r.script.content, 'inline')
})

test('findEditableBlocks: posiciones son absolutas (match.indices), no relativas', () => {
  const html = 'XXXXX<script>const x = 1</script>YYYYY'
  const r = findEditableBlocks(html)
  assert.ok(r.script)
  assert.equal(html.slice(r.script.innerStart, r.script.innerEnd), 'const x = 1')
  assert.equal(html.slice(0, r.script.innerStart), 'XXXXX<script>')
  assert.equal(html.slice(r.script.innerEnd), '</script>YYYYY')
})

test('findEditableBlocks: múltiples scripts externos + 1 inline sigue contando solo el inline', () => {
  const html = '<script src="a"></script><script src="b"></script><script>only</script>'
  const r = findEditableBlocks(html)
  assert.ok(r.script)
  assert.equal(r.script.content, 'only')
})

test('findEditableBlocks: <script src=...> con atributo extra sigue siendo externo', () => {
  const html = '<script type="module" src="a.js"></script><script>inline</script>'
  const r = findEditableBlocks(html)
  assert.ok(r.script)
  assert.equal(r.script.content, 'inline')
})

test('spliceBlock: reemplaza el rango exacto y conserva TODO el resto intacto', () => {
  const html = '<html><head></head><body><script>A</script></body></html>'
  const r = findEditableBlocks(html)
  const nuevo = spliceBlock(html, r.script, 'B')
  assert.equal(nuevo, '<html><head></head><body><script>B</script></body></html>')
})

test('spliceBlock: cualquier cambio FUERA del rango se preserva (incluso espacios/whitespace)', () => {
  // El carácter de la izquierda y derecha del bloque no deben tocarse, ni siquiera
  // whitespace raro (esto es exactamente lo que prohibe el spec: nada de
  // DOMParser + reserializar). NOTA: la regex del spec NO matchea
  // `</script  >` (whitespace entre `t` y `>`) — usar formato canónico
  // `<script>...</script>` para este test.
  //
  // Lo que se preserva es TODO lo de afuera del bloque: tags, whitespace y
  // caracteres "raros" como entities, CDATA, comillas unicode, etc. Lo de
  // ADENTRO del `<script>...</script>` se reemplaza entero.
  const html = '<body  >\n<script>\n<![CDATA[]]>\na&amp;b\n</script>\n</body>'
  const r = findEditableBlocks(html)
  assert.ok(r.script)
  const nuevo = spliceBlock(html, r.script, 'XYZ')
  // Antes (`<body  >\n<script>`) + nuevo contenido + después (`</script>\n</body>`)
  // Cualquier `\n<![CDATA[]]>` o `a&amp;b` previo al script sigue presente
  // en el resto del documento, pero el contenido INTERNO del script se
  // reemplazó entero.
  assert.equal(nuevo, '<body  >\n<script>XYZ</script>\n</body>')
  // Y verificamos invariantes más finos: tamaño, presencia del <body> exterior, ausencia del viejo contenido.
  assert.ok(nuevo.startsWith('<body  >\n<script>'), 'la parte EXTERIOR izquierda queda intacta')
  assert.ok(nuevo.endsWith('</script>\n</body>'), 'la parte EXTERIOR derecha queda intacta')
  assert.equal(nuevo.length, '<body  >\n<script>XYZ</script>\n</body>'.length)
  assert.ok(!nuevo.includes('<![CDATA[]]>'), 'el viejo contenido del script no debe quedar')
  assert.ok(!nuevo.includes('a&amp;b'), 'los entities del viejo contenido no deben quedar')
})

test('spliceBlock + findEditableBlocks: round-trip preserva el resto del documento', () => {
  // El caso típico de la IA: markup + script + markup. Reemplazamos el script
  // y verificamos que todo el resto sigue exactamente igual, sin re-serializar.
  const original = `<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950">
  <h1>Hola mundo</h1>
  <p>acá va texto con entities &amp; símbolos raros "ñ"</p>
  <script>
    const productos = [
      { id: 1, nombre: 'A' },
      { id: 2, nombre: 'B' },
    ]
    console.log(productos)
  </script>
  <footer>fin</footer>
</body>
</html>`
  const r = findEditableBlocks(original)
  assert.ok(r.script, 'debería encontrar el único <script> inline')
  const nuevoScript = "const productos = await HTMLBox.table('productos').rows({ limit: 1000 })"
  const nuevo = spliceBlock(original, r.script, nuevoScript)
  // El resto del HTML debe ser IDÉNTICO carácter por carácter. La identidad
  // se chequea en tres pedazos (antes, contenidomodificado, después) más
  // como verificación cruzada: el contenido viejo NO debe sobrevivir.
  const antes = original.slice(0, r.script.innerStart)
  const despues = original.slice(r.script.innerEnd)
  assert.equal(nuevo, antes + nuevoScript + despues)
  assert.ok(nuevo.includes('<footer>fin</footer>'), 'el <footer> siguiente debe sobrevivir intacto')
  assert.ok(!nuevo.includes('console.log(productos)'), 'el JS viejo NO debe quedar')
  // Tamaños coherentes: la diferencia entre el nuevo y el viejo es exacta.
  assert.equal(nuevo.length - original.length, nuevoScript.length - (r.script.innerEnd - r.script.innerStart))
})

test('spliceBlock: newContent puede ser más largo o más corto', () => {
  const html = '<script>short</script>'
  const r = findEditableBlocks(html)
  assert.equal(spliceBlock(html, r.script, 'UNO_MUY_LARGO_QUE_INCLUYE_VARIAS_LINEAS\nY_CARACTERES_especiales'), '<script>UNO_MUY_LARGO_QUE_INCLUYE_VARIAS_LINEAS\nY_CARACTERES_especiales</script>')
  assert.equal(spliceBlock(html, r.script, 'a'), '<script>a</script>')
  assert.equal(spliceBlock(html, r.script, ''), '<script></script>')
})

test('findEditableBlocks: case-insensitive en el tag name', () => {
  const html = '<SCRIPT>x</SCRIPT>'
  const r = findEditableBlocks(html)
  assert.ok(r.script, '<SCRIPT> mayúsculas debería matchear')
  assert.equal(r.script.content, 'x')
})

test('findEditableBlocks: maneja <script> con atributos (type, async, defer)', () => {
  const html = '<script type="module" defer>const x = 1</script>'
  const r = findEditableBlocks(html)
  assert.ok(r.script)
  assert.equal(r.script.content, 'const x = 1')
})

test('findEditableBlocks: NO matchea tag como substring (regex /gid no se confunde)', () => {
  // <noscript> no debe matchear como <script>
  const html = '<noscript>foo</noscript><script>bar</script>'
  const r = findEditableBlocks(html)
  assert.ok(r.script, 'debería encontrar 1 <script> y NO contar <noscript>')
  assert.equal(r.script.content, 'bar')
})

test('countEditableBlocks: cuenta correcta para 0/1/2+ scripts y styles', () => {
  function check(html, expectedScript, expectedStyle, msg) {
    const r = countEditableBlocks(html)
    assert.equal(r.script, expectedScript, `${msg}: scripts=${r.script} esperado=${expectedScript}`)
    assert.equal(r.style, expectedStyle, `${msg}: styles=${r.style} esperado=${expectedStyle}`)
  }
  check('<p>x</p>', 0, 0, 'plain HTML')
  check('<script>a</script>', 1, 0, '1 inline script')
  check('<script src="a.js"></script>', 0, 0, 'externo se ignora')
  check('<script>a</script><script>b</script>', 2, 0, '2 inline scripts')
  check('<style>x</style>', 0, 1, '1 style')
  check('<style>a</style><style>b</style>', 0, 2, '2 styles')
  check('<script>a</script><style>x</style><script src="ext"></script><style>y</style>', 1, 2, 'mixto: ignora externos')
})

test('countEditableBlocks: no falla con HTML vacío', () => {
  const r1 = countEditableBlocks('')
  assert.equal(r1.script, 0)
  assert.equal(r1.style, 0)
  const r2 = countEditableBlocks('<html><body></body></html>')
  assert.equal(r2.script, 0)
  assert.equal(r2.style, 0)
})

test('countEditableBlocks: reproduce el caso del bug del usuario (Tailwind config + app)', () => {
  // Caso de uso real que disparó el bug: 1 src= externo (Tailwind CDN) +
  // 1 inline de tailwind.config + 1 inline de app = 2 inline scripts.
  const html = `
    <head>
      <script src="https://cdn.tailwindcss.com"></script>
      <script>tailwind.config = { darkMode: 'class' }</script>
      <style>::-webkit-scrollbar { width: 6px; }</style>
    </head>
    <body>
      <script>let state = { theme: 'dark' }</script>
    </body>
  `
  const r = countEditableBlocks(html)
  assert.equal(r.script, 2, 'contamos 2 inline scripts')
  assert.equal(r.style, 1, 'contamos 1 style')
  // Y findEditableBlocks devuelve null en script (regla de "exactamente 1")
  // pero style sigue válido.
  const fb = findEditableBlocks(html)
  assert.equal(fb.script, null, '2 inline scripts → null (regla v1 intencional)')
  assert.ok(fb.style, '1 style → bloque')
})
