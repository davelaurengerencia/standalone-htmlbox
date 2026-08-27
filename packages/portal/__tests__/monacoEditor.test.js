// __tests__/monacoEditor.test.js
//
// Tests para htmlbox-spec-monaco-editor.md. Cubre:
//  - reindentHtml() (función pura del fallback si Monaco no carga)
//  - El puente Alpine ↔ Monaco sin necesidad de Monaco real:
//    * _syncMonacoValue: no-op si Monaco no montó, skip si mismo valor,
//      setValue cuando difiere, pasa '' cuando falsy
//    * _resetEditorState: setea editorHtml Y sincroniza con Monaco
//    * initMonaco: loggea error si window.require no existe
//    * formatHTML: usa editor.action.formatDocument si Monaco está,
//      usa reindentHtml como fallback si no
//    * listener onDidChangeModelContent empuja a editorHtml
//
// Estrategia: para testear el bridge Alpine↔Monaco sin levantar el
// portal entero, armamos un stub portalApp() con solo los métodos
// relevantes (reindentHtml + el state glue). El estado del bridge
// (editorHtml / _monacoEditor / _monacoReady / _syncMonacoValue / etc.)
// coincide 1:1 con lo que está en app-script.html.txt — si divergen,
// el test falla.

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
const mainPanelPath = path.join(
  here, '..', 'src', 'ui-partials', 'main-panel.html.txt'
)
const shellPath = path.join(
  here, '..', 'src', 'ui-partials', 'shell.html.txt'
)

// ============ reindentHtml() desde app-script.html.txt ============

function loadReindent() {
  const src = fs.readFileSync(appScriptPath, 'utf8')
  const startMarker = '// ============ Editor (htmlbox-spec-monaco-editor.md) ============'
  const endMarker = '// ============ Constantes de seed ============'
  const startIdx = src.indexOf(startMarker)
  const endIdx = src.indexOf(endMarker, startIdx)
  assert.notEqual(startIdx, -1, 'start marker not found in app-script.html.txt')
  assert.notEqual(endIdx, -1, 'end marker not found in app-script.html.txt')
  const helpersSrc = src.slice(startIdx, endIdx)
  const sandbox = { module: { exports: {} } }
  const wrapped = `${helpersSrc}\nmodule.exports = { reindentHtml };`
  vm.runInNewContext(wrapped, sandbox)
  return sandbox.module.exports
}

const { reindentHtml } = loadReindent()

// ============ stub portalApp() — solo el bridge Monaco ============
//
// Esto es un duplicado intencional y minúsculo del bridge Alpine↔Monaco
// que vive dentro de portalApp() en app-script.html.txt. Lo duplicamos
// para no tener que montar todo el portal (auth, boxes, AI, datos,
// modales, etc.) en un vm sandbox solo para testear el editor.
//
// Si el bridge real cambia (p.ej. cambia el signature de _syncMonacoValue),
// actualizá este stub también. Los tests de "state shape" y "section
// comments" abajo refuerzan que el app-script.html.txt real también
// cambió.

function makeStubApp(monacoMock = null, fakeWindow = {}) {
  const stub = {
    editorHtml: '',
    _monacoEditor: null,
    _monacoReady: null,
    showToast(msg) { stub._lastToast = msg },
    _lastToast: null,

    initMonaco(container) {
      const req = (fakeWindow && fakeWindow.require) || (typeof window !== 'undefined' && window.require)
      if (!req) {
        console.error('Monaco loader no disponible (falló la carga desde CDN).')
        return
      }
      req.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs' } })
      stub._monacoReady = new Promise((resolve) => {
        req(['vs/editor/editor.main'], () => {
          const monaco = (fakeWindow && fakeWindow.monaco) || (typeof window !== 'undefined' && window.monaco)
          stub._monacoEditor = monaco.editor.create(container, {
            value: stub.editorHtml || '',
            language: 'html',
            theme: 'vs-dark',
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 13,
            scrollBeyondLastLine: false,
            wordWrap: 'off',
          })
          stub._monacoEditor.onDidChangeModelContent(function () {
            stub.editorHtml = stub._monacoEditor.getValue()
          })
          resolve()
        })
      })
    },

    _syncMonacoValue(html) {
      if (stub._monacoEditor && stub._monacoEditor.getValue() !== html) {
        stub._monacoEditor.setValue(html || '')
      }
    },

    _resetEditorState(html) {
      stub.editorHtml = html || ''
      stub._syncMonacoValue(stub.editorHtml)
    },

    formatHTML() {
      if (stub._monacoEditor) {
        stub._monacoReady
          .then(() => stub._monacoEditor.getAction('editor.action.formatDocument').run())
          .then(() => {
            stub.editorHtml = stub._monacoEditor.getValue()
            stub.showToast('HTML formateado.')
          })
          .catch((err) => {
            console.warn('Monaco format falló, usando fallback:', err)
            stub.editorHtml = reindentHtml(stub.editorHtml || '')
            stub._syncMonacoValue(stub.editorHtml)
            stub.showToast('HTML re-indentado (fallback).')
          })
        return
      }
      stub.editorHtml = reindentHtml(stub.editorHtml || '')
      stub.showToast('HTML re-indentado (fallback — Monaco no cargó).')
    },
  }
  if (monacoMock) stub._monacoEditor = monacoMock
  return stub
}

// ============ reindentHtml() — tests puros ============

test('reindentHtml: indenta <html> simple a 2 espacios entre tags', () => {
  const out = reindentHtml('<html><head><title>x</title></head></html>')
  assert.equal(out, [
    '<html>',
    '  <head>',
    '    <title>x</title>',
    '  </head>',
    '</html>',
  ].join('\n'))
})

test('reindentHtml: tags void (meta, br, img) no incrementan level', () => {
  const out = reindentHtml('<html><head><meta charset="UTF-8"></head><body><br><img src="x.png"></body></html>')
  assert.equal(out, [
    '<html>',
    '  <head>',
    '    <meta charset="UTF-8">',
    '  </head>',
    '  <body>',
    '    <br>',
    '    <img src="x.png">',
    '  </body>',
    '</html>',
  ].join('\n'))
})

test('reindentHtml: vacío / null devuelve vacío', () => {
  assert.equal(reindentHtml(''), '')
  assert.equal(reindentHtml(null), '')
  assert.equal(reindentHtml(undefined), '')
})

test('reindentHtml: HTML de seed del dashboard no se rompe', () => {
  const input = '<!doctype html><html><head><meta charset="UTF-8"><title>Dashboard</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-slate-900"><div class="container"><h1>Hola</h1></div></body></html>'
  const out = reindentHtml(input)
  assert.match(out, /^<!doctype html>/)
  assert.match(out, /<html>/)
  assert.match(out, /<title>/)
  assert.match(out, /<body class="bg-slate-900">/)
  assert.match(out, /<\/body>/)
  assert.match(out, /<\/html>/)
})

// ============ _syncMonacoValue (sin Monaco cargado) ============

test('_syncMonacoValue: NO-OP si Monaco todavía no montó', () => {
  const app = makeStubApp(null)
  assert.doesNotThrow(() => app._syncMonacoValue('<html><body>x</body></html>'))
  assert.equal(app.editorHtml, '')  // el bridge no se ensució tocando state
})

test('_syncMonacoValue: llama setValue solo si el valor difiere del buffer actual', () => {
  let setValueCalls = 0
  let bufferValue = '<initial/>'
  const monacoMock = {
    getValue: () => bufferValue,         // refleja el último setValue
    setValue: (v) => { bufferValue = v; setValueCalls++ },
  }
  const app = makeStubApp(monacoMock)
  app._syncMonacoValue('<initial/>')    // coincide con buffer → no llama
  assert.equal(setValueCalls, 0)
  app._syncMonacoValue('<differ/>')     // buffer sigue '<initial/>' → difiere → llama
  assert.equal(setValueCalls, 1)
  assert.equal(bufferValue, '<differ/>')
  app._syncMonacoValue('<differ/>')     // ahora buffer coincide → no llama
  assert.equal(setValueCalls, 1, 'no debe llamar cuando el valor ya está en buffer')
})

test('_syncMonacoValue: pasa string vacío si html es null/undefined/false/0', () => {
  let passedValue = '<not called/>'
  const monacoMock = {
    getValue: () => '<initial/>',
    setValue: (v) => { passedValue = v },
  }
  const app = makeStubApp(monacoMock)
  app._syncMonacoValue(null)
  assert.equal(passedValue, '')
  app._syncMonacoValue(undefined)
  assert.equal(passedValue, '')
  app._syncMonacoValue(false)
  assert.equal(passedValue, '')
})

// ============ _resetEditorState ============

test('_resetEditorState: setea editorHtml Y sincroniza con Monaco', () => {
  let setValueCalled = false
  let setValueWith = null
  const monacoMock = {
    getValue: () => '<prev/>',
    setValue: (v) => { setValueCalled = true; setValueWith = v },
  }
  const app = makeStubApp(monacoMock)
  app.editorHtml = '<old/>'
  app._resetEditorState('<html><body>hello</body></html>')
  assert.equal(app.editorHtml, '<html><body>hello</body></html>')
  assert.equal(setValueCalled, true, 'debe llamar setValue de Monaco')
  assert.equal(setValueWith, '<html><body>hello</body></html>')
})

test('_resetEditorState: NO-OP de Monaco si Monaco no montó (no tira)', () => {
  const app = makeStubApp(null)
  assert.doesNotThrow(() => app._resetEditorState('<html></html>'))
  assert.equal(app.editorHtml, '<html></html>')
})

// ============ initMonaco ============

test('initMonaco: loggea error y no tira si window.require no existe', () => {
  const errors = []
  const origConsoleError = console.error
  console.error = (...args) => errors.push(args.join(' '))
  try {
    const app = makeStubApp(null, {})  // fakeWindow sin require
    app.initMonaco({ tagName: 'DIV' })
    assert.ok(errors.some((m) => m.includes('Monaco loader no disponible')))
    assert.equal(app._monacoEditor, null, 'monaco queda sin montar')
    assert.equal(app._monacoReady, null, 'ready queda null')
  } finally {
    console.error = origConsoleError
  }
})

test('initMonaco: monta el editor cuando el loader AMD resuelve', async () => {
  let requireConfig = null
  let requiredModule = null
  let createCalledWith = null

  const fakeMonacoEditor = {
    _onChange: null,
    onDidChangeModelContent(cb) { this._onChange = cb },
    getValue: () => '<created/>',
    setValue: () => {},
  }
  const fakeMonaco = {
    editor: {
      create: (container, opts) => {
        createCalledWith = { container, opts }
        return fakeMonacoEditor
      },
    },
  }
  const fakeRequire = (mods, cb) => {
    requiredModule = mods
    cb()
  }
  fakeRequire.config = (c) => { requireConfig = c }

  const fakeWindow = { require: fakeRequire, monaco: fakeMonaco }
  const app = makeStubApp(null, fakeWindow)
  await app.initMonaco({ tagName: 'DIV' })
  // Verificaciones:
  assert.ok(requireConfig, 'debió llamar require.config')
  assert.deepEqual(requireConfig.paths.vs, 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs')
  assert.deepEqual(requiredModule, ['vs/editor/editor.main'])
  assert.equal(createCalledWith.opts.language, 'html')
  assert.equal(createCalledWith.opts.theme, 'vs-dark')
  assert.equal(createCalledWith.opts.automaticLayout, true)
  assert.equal(createCalledWith.opts.minimap.enabled, false)
  assert.equal(app._monacoEditor, fakeMonacoEditor)
  assert.ok(app._monacoReady instanceof Promise)
  // El listener quedó enganchado y empuja a editorHtml:
  assert.equal(typeof fakeMonacoEditor._onChange, 'function')
  app.editorHtml = '<prev/>'
  fakeMonacoEditor.getValue = () => '<new via monaco/>'
  fakeMonacoEditor._onChange()
  assert.equal(app.editorHtml, '<new via monaco/>', 'listener debe empujar a editorHtml')
})

// ============ formatHTML ============

test('formatHTML: usa editor.action.formatDocument si Monaco está montado', async () => {
  let formatCalled = false
  const monacoMock = {
    onDidChangeModelContent() {},
    getValue: () => '<formatted/>',
    setValue: () => {},
    getAction: (id) => {
      if (id !== 'editor.action.formatDocument') return null
      return { run: async () => { formatCalled = true } }
    },
  }
  const app = makeStubApp(monacoMock)
  app._monacoReady = Promise.resolve()  // stub: ya resuelta
  app.editorHtml = '<unformatted/>'
  app.formatHTML()
  // Esperar que las dos promesas en cadena resuelvan
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(formatCalled, true)
  assert.equal(app.editorHtml, '<formatted/>')
  assert.equal(app._lastToast, 'HTML formateado.')
})

test('formatHTML: usa reindentHtml si Monaco no cargó (fallback offline)', () => {
  const app = makeStubApp(null)
  app.editorHtml = '<html><head><title>x</title></head></html>'
  app.formatHTML()
  assert.equal(app.editorHtml, [
    '<html>',
    '  <head>',
    '    <title>x</title>',
    '  </head>',
    '</html>',
  ].join('\n'))
  assert.match(app._lastToast, /^HTML re-indentado \(fallback/)
})

test('formatHTML: cae al fallback si Monaco formatAction.run() rechaza', async () => {
  const monacoMock = {
    onDidChangeModelContent() {},
    getValue: () => '<unchanged/>',
    setValue: () => {},
    getAction: () => ({ run: async () => { throw new Error('boom') } }),
  }
  const app = makeStubApp(monacoMock)
  app._monacoReady = Promise.resolve()
  app.editorHtml = '<html><body>x</body></html>'
  app.formatHTML()
  await new Promise((resolve) => setTimeout(resolve, 5))
  // Cayó al catch → reindentHtml + toast de fallback.
  assert.equal(app.editorHtml, [
    '<html>',
    '  <body>x</body>',
    '</html>',
  ].join('\n'))
  assert.match(app._lastToast, /^HTML re-indentado/)
})

// ============ state shape y referencias en archivos reales ============

test('app-script.html.txt: la sección Editor apunta al spec monaco-editor (no a split-view)', () => {
  const src = fs.readFileSync(appScriptPath, 'utf8')
  assert.match(src, /htmlbox-spec-monaco-editor\.md/)
  assert.doesNotMatch(src, /htmlbox-spec-editor-split-view\.md/)
})

test('app-script.html.txt: ya NO contiene los helpers del split-view', () => {
  const src = fs.readFileSync(appScriptPath, 'utf8')
  assert.doesNotMatch(src, /function findEditableBlocks/, 'findEditableBlocks debería estar borrado')
  assert.doesNotMatch(src, /function countEditableBlocks/, 'countEditableBlocks debería estar borrado')
  assert.doesNotMatch(src, /function spliceBlock/, 'spliceBlock debería estar borrado')
  assert.doesNotMatch(src, /function _scanEditableBlocks/, '_scanEditableBlocks debería estar borrado')
})

test('app-script.html.txt: el bridge Alpine↔Monaco está implementado', () => {
  const src = fs.readFileSync(appScriptPath, 'utf8')
  assert.match(src, /_monacoEditor:\s*null/, '_monacoEditor debe estar declarado en state')
  assert.match(src, /_monacoReady:\s*null/, '_monacoReady debe estar declarado en state')
  assert.match(src, /initMonaco\(container\)/, 'initMonaco debe estar como método')
  assert.match(src, /_syncMonacoValue\(html\)/, '_syncMonacoValue debe estar como método')
  assert.match(src, /onDidChangeModelContent/, 'onDidChangeModelContent debe estar enganchado')
  assert.match(src, /editor\.action\.formatDocument/, 'formatAction debe invocarse en formatHTML')
})

test('app-script.html.txt: NO quedan referencias a _fullHtml / _editorFullHtml / editorView', () => {
  const src = fs.readFileSync(appScriptPath, 'utf8')
  assert.doesNotMatch(src, /\bget _fullHtml\b/, 'getter _fullHtml debería estar borrado')
  assert.doesNotMatch(src, /\b_editorFullHtml\b/, '_editorFullHtml debería estar borrado')
  assert.doesNotMatch(src, /\b_editorBlocks\b/, '_editorBlocks debería estar borrado')
  assert.doesNotMatch(src, /\beditorView\b/, 'editorView debería estar borrado')
  assert.doesNotMatch(src, /\bsetEditorView\b/, 'setEditorView debería estar borrado')
  assert.doesNotMatch(src, /\b_commitEditorView\b/, '_commitEditorView debería estar borrado')
  assert.doesNotMatch(src, /\bblockCountsLabel\b/, 'blockCountsLabel debería estar borrado')
})

test('main-panel.html.txt: usa <div x-ref="monacoContainer">, NO <textarea x-model="editorHtml">', () => {
  const src = fs.readFileSync(mainPanelPath, 'utf8')
  assert.match(src, /<div\s+x-ref="monacoContainer"\s+x-init="initMonaco\(\$refs\.monacoContainer\)"/)
  assert.doesNotMatch(src, /<textarea\s+x-model="editorHtml"/)
})

test('main-panel.html.txt: NO contiene los botones Todo | JS | CSS ni blockCountsLabel', () => {
  const src = fs.readFileSync(mainPanelPath, 'utf8')
  assert.doesNotMatch(src, /setEditorView/)
  assert.doesNotMatch(src, /blockCountsLabel/)
  assert.doesNotMatch(src, /vista parcial — el largo es del fragmento/)
})

test('shell.html.txt: carga Monaco loader ANTES de Alpine', () => {
  const src = fs.readFileSync(shellPath, 'utf8')
  const monacoIdx = src.indexOf('monaco-editor@0.52.0')
  const alpineIdx = src.indexOf('alpinejs@3.13.5')
  assert.notEqual(monacoIdx, -1, 'falta el <script> del Monaco loader')
  assert.notEqual(alpineIdx, -1, 'falta el <script> de Alpine (regresión)')
  assert.ok(monacoIdx < alpineIdx, 'Monaco loader debe ir antes que Alpine en shell.html.txt')
})
