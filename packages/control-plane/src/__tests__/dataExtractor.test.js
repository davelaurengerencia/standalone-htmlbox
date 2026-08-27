// __tests__/dataExtractor.test.js — tests determinísticos del extractor.
// Lo más importante: NUNCA ejecutar código del tenant. Todos los inputs son
// HTML controlado, así que podemos hacer assertions exactas.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  findSingleInlineScript,
  extractArrayCandidates,
  buildReplacementForCandidate,
} from '../lib/dataExtractor.js'

// ─── findSingleInlineScript ──────────────────────────────────────────────

test('findSingleInlineScript devuelve null si no hay script', () => {
  const html = '<html><body><p>sin script</p></body></html>'
  assert.equal(findSingleInlineScript(html), null)
})

test('findSingleInlineScript devuelve null si hay 2+ scripts', () => {
  const html = '<script>const a = 1</script><script>const b = 2</script>'
  assert.equal(findSingleInlineScript(html), null)
})

test('findSingleInlineScript IGNORA scripts con src (1 inline + 1 src = 1 inline válido)', () => {
  const html = '<script src="x.js"></script><script>const a = 1</script>'
  const s = findSingleInlineScript(html)
  assert.ok(s)  // 1 inline → válido, el src no cuenta
  assert.match(s.content, /const a = 1/)
})

test('findSingleInlineScript ignora scripts con src (case-insensitive)', () => {
  const html = '<SCRIPT SRC="x.js"></SCRIPT><script>const a = 1</script>'
  const s = findSingleInlineScript(html)
  assert.ok(s)
  assert.match(s.content, /const a = 1/)
})

test('findSingleInlineScript devuelve null si hay 1 src pero 0 inline', () => {
  const html = '<script src="x.js"></script>'
  assert.equal(findSingleInlineScript(html), null)
})

test('findSingleInlineScript devuelve null si hay 1 src pero 2+ inline', () => {
  const html = '<script src="x.js"></script><script>const a=1</script><script>const b=2</script>'
  assert.equal(findSingleInlineScript(html), null)
})

test('findSingleInlineScript devuelve posiciones correctas para script simple', () => {
  const html = '<script>const x = 1</script>'
  const s = findSingleInlineScript(html)
  assert.ok(s)
  assert.equal(s.content, 'const x = 1')
  assert.equal(s.start, 0)
  assert.equal(s.end, html.length)
  // contentStart está justo después del '>' de apertura
  assert.equal(s.contentStart, '<script>'.length)
  assert.equal(s.contentEnd, '<script>'.length + 'const x = 1'.length)
})

test('findSingleInlineScript maneja atributos en el tag de apertura', () => {
  const html = '<script type="text/javascript">const x = 1</script>'
  const s = findSingleInlineScript(html)
  assert.ok(s)
  assert.match(s.attrs, /type="text\/javascript"/)
  assert.equal(s.content, 'const x = 1')
  assert.equal(s.contentStart, html.indexOf('>') + 1)
})

test('findSingleInlineScript maneja el ÚNICO caso edge: 0 scripts + un src', () => {
  const html = '<script src="x.js"></script>'
  assert.equal(findSingleInlineScript(html), null)
})

test('findSingleInlineScript maneja HTML multilinea', () => {
  const html = `<html>
<body>
<script>
const x = [
  { a: 1 },
  { a: 2 },
]
</script>
</body>
</html>`
  const s = findSingleInlineScript(html)
  assert.ok(s)
  assert.match(s.content, /const x = \[/)
})

// ─── extractArrayCandidates ──────────────────────────────────────────────

test('extractArrayCandidates devuelve [] si no hay script', () => {
  assert.deepEqual(extractArrayCandidates('<html><body></body></html>'), [])
})

test('extractArrayCandidates extrae un const = [...]', () => {
  const html = '<script>const productos = [{"nombre":"Mesa","precio":100}]</script>'
  const cands = extractArrayCandidates(html)
  assert.equal(cands.length, 1)
  assert.equal(cands[0].varName, 'productos')
  assert.equal(cands[0].rowCount, 1)
  assert.deepEqual(cands[0].rows, [{ nombre: 'Mesa', precio: 100 }])
})

test('extractArrayCandidates extrae múltiples const', () => {
  const html = `<script>
const productos = [{"id":1},{"id":2}];
const usuarios = [{"id":1,"email":"a@b.com"}];
</script>`
  const cands = extractArrayCandidates(html)
  assert.equal(cands.length, 2)
  assert.equal(cands[0].varName, 'productos')
  assert.equal(cands[0].rowCount, 2)
  assert.equal(cands[1].varName, 'usuarios')
})

test('extractArrayCandidates extrae let también', () => {
  const html = '<script>let datos = [{"x":1}]</script>'
  const cands = extractArrayCandidates(html)
  assert.equal(cands.length, 1)
  assert.equal(cands[0].varName, 'datos')
})

test('extractArrayCandidates posiciones declStart/declEnd son absolutas en html', () => {
  const html = '<html><body><script>const productos = [{"x":1}]</script></body></html>'
  const cands = extractArrayCandidates(html)
  const c = cands[0]
  // La declaración empieza justo después del '>' del <script> de apertura
  // = 20 chars en este input
  assert.equal(c.declStart, '<html><body><script>'.length)
  assert.equal(html.slice(c.declStart, c.declEnd), 'const productos = [{"x":1}]')
  // Y aplicar splice: prefijo + replacement + sufijo reproduce la estructura
  const replacement = buildReplacementForCandidate(c, 'productos')
  const spliced = html.slice(0, c.declStart) + replacement + html.slice(c.declEnd)
  assert.match(spliced, /const productos = await HTMLBox\.table\('productos'\)\.rows/)
  assert.doesNotMatch(spliced, /const productos = \[\{"x":1\}\]/)
})

test('extractArrayCandidates DESCARTa arrays con comillas simples (no es JSON)', () => {
  const html = "<script>const productos = [{'nombre':'Mesa'}]</script>"
  const cands = extractArrayCandidates(html)
  assert.equal(cands.length, 0) // comillas simples → JSON.parse falla → se descarta
})

test('extractArrayCandidates DESCARTa arrays con trailing comma', () => {
  const html = '<script>const x = [{a:1,},]</script>'
  const cands = extractArrayCandidates(html)
  assert.equal(cands.length, 0)
})

test('extractArrayCandidates DESCARTa arrays vacíos', () => {
  const html = '<script>const x = []</script>'
  assert.equal(extractArrayCandidates(html).length, 0)
})

test('extractArrayCandidates DESCARTa arrays que NO son de objetos', () => {
  const html = '<script>const nums = [1,2,3]</script>'
  assert.equal(extractArrayCandidates(html).length, 0)
})

test('extractArrayCandidates acepta arrays mixtos donde todos son objetos', () => {
  const html = '<script>const x = [{"a":1}, {"b":2}]</script>'
  const cands = extractArrayCandidates(html)
  assert.equal(cands.length, 1)
  assert.equal(cands[0].rowCount, 2)
})

test('extractArrayCandidates DESCARTa si algún elemento no es objeto', () => {
  const html = '<script>const x = [{"a":1}, 42]</script>'
  assert.equal(extractArrayCandidates(html).length, 0)
})

test('extractArrayCandidates DESCARTa si hay elementos null', () => {
  const html = '<script>const x = [null, {"a":1}]</script>'
  assert.equal(extractArrayCandidates(html).length, 0)
})

test('extractArrayCandidates DECARTA código que parece array pero no lo es', () => {
  const html = '<script>const x = new Date().getTime()</script>'
  assert.equal(extractArrayCandidates(html).length, 0)
})

test('extractArrayCandidates con HTML complejo (mismo input que el spec)', () => {
  const html = `<html>
<body>
<script>
const productos = [
  {"nombre":"Mesa","precio":100},
  {"nombre":"Silla","precio":40}
]
renderTabla(productos)
</script>
</body>
</html>`
  const cands = extractArrayCandidates(html)
  assert.equal(cands.length, 1)
  assert.equal(cands[0].varName, 'productos')
  assert.equal(cands[0].rowCount, 2)
  assert.equal(cands[0].rows[0].nombre, 'Mesa')
})

test('extractArrayCandidates posiciones son correctas para HTML complejo', () => {
  const html = `<html>
<body>
<script>
const productos = [
  {"nombre":"Mesa","precio":100},
  {"nombre":"Silla","precio":40}
]
renderTabla(productos)
</script>
</body>
</html>`
  const cands = extractArrayCandidates(html)
  const c = cands[0]
  const replacement = buildReplacementForCandidate(c, 'productos')
  const spliced = html.slice(0, c.declStart) + replacement + html.slice(c.declEnd)
  // El resto del script (renderTabla(productos)) sigue presente
  assert.match(spliced, /renderTabla\(productos\)/)
  // La declaración está reemplazada
  assert.doesNotMatch(spliced, /const productos = \[/)
  assert.match(spliced, /const productos = await HTMLBox\.table\('productos'\)\.rows/)
})

test('extractArrayCandidates maneja múltiples scripts con src correctamente', () => {
  const html = `<html>
<head>
  <script src="jquery.js"></script>
</head>
<body>
<script>
const productos = [{"x":1}]
</script>
</body>
</html>`
  // 1 src + 1 inline = 1 inline → debe matchear
  const s = findSingleInlineScript(html)
  assert.ok(s)
  const cands = extractArrayCandidates(html)
  assert.equal(cands.length, 1)
})

test('extractArrayCandidates NO ejecuta código del tenant (seguridad)', () => {
  // Este input tiene código "maligno" — debe descartarse silenciosamente.
  const html = `<script>
const evil = [{"x":1}]
// intento de inyección: __proto__, eval, etc.
const payload = [{"constructor": {"prototype": {"polluted": true}}}]
</script>`
  // Solo "evil" es array JSON válido, "payload" también
  const cands = extractArrayCandidates(html)
  assert.equal(cands.length, 2)
  // Pero NUNCA se ejecutó nada — solo JSON.parse sobre texto literal
  // El test pasa si no crashea y devuelve el parse correcto
  assert.equal(cands[0].varName, 'evil')
  assert.equal(cands[0].rowCount, 1)
})

// ─── buildReplacementForCandidate ────────────────────────────────────────

test('buildReplacementForCandidate usa el SDK estándar', () => {
  const candidate = { varName: 'productos', declStart: 0, declEnd: 0, arrayText: '', rows: [], rowCount: 0 }
  const r = buildReplacementForCandidate(candidate, 'productos')
  assert.equal(r, "const productos = await HTMLBox.table('productos').rows({ limit: 1000 })")
})

test('buildReplacementForCandidate funciona con distintos slugs', () => {
  const c = { varName: 'usuarios' }
  assert.equal(
    buildReplacementForCandidate(c, 'users'),
    "const usuarios = await HTMLBox.table('users').rows({ limit: 1000 })",
  )
})

// ─── Round-trip: aplicar buildReplacementForCandidate en cascada ──────────

test('Round-trip: aplicar 2 reemplazos con orden DESCENDENTE conserva el resto', () => {
  const html = `<script>
const a = [{"x":1}]
const b = [{"y":2},{"y":3}]
// resto del código que NO queremos tocar
render(a, b)
</script>`
  const cands = extractArrayCandidates(html)
  assert.equal(cands.length, 2)
  // Orden descendente por declStart (igual que el spec §4 dice)
  cands.sort((x, y) => y.declStart - x.declStart)
  let result = html
  for (const c of cands) {
    const r = buildReplacementForCandidate(c, c.varName === 'a' ? 'tabla_a' : 'tabla_b')
    result = result.slice(0, c.declStart) + r + result.slice(c.declEnd)
  }
  // Ambos reemplazos están
  assert.match(result, /const a = await HTMLBox\.table\('tabla_a'\)/)
  assert.match(result, /const b = await HTMLBox\.table\('tabla_b'\)/)
  // El resto del script sigue intacto
  assert.match(result, /render\(a, b\)/)
  // Y NO quedan los arrays literales
  assert.doesNotMatch(result, /const a = \[\{/)
  assert.doesNotMatch(result, /const b = \[\{/)
})

test('Round-trip: agregar type="module" después de los reemplazos', () => {
  const html = '<script>const a = [{"x":1}]</script>'
  const cands = extractArrayCandidates(html)
  let result = html
  for (const c of cands.sort((x, y) => y.declStart - x.declStart)) {
    result = result.slice(0, c.declStart) + buildReplacementForCandidate(c, 'tabla_a') + result.slice(c.declEnd)
  }
  // Ahora aplicamos el truco del <script type="module">
  const s = findSingleInlineScript(result)
  assert.ok(s)
  const openTagEnd = s.start + '<script'.length + s.attrs.length
  result = result.slice(0, openTagEnd) + ' type="module"' + result.slice(openTagEnd)
  assert.match(result, /<script type="module">/)
  // El HTML ya modificado sigue matcheando findSingleInlineScript (para
  // casos donde se aplica 2 veces, no debería romper)
  const s2 = findSingleInlineScript(result)
  assert.ok(s2)
  assert.match(s2.attrs, /type="module"/)
})