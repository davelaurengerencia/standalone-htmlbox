// __tests__/codemirrorEditor.test.js
//
// Tests para htmlbox-spec-codemirror-editor.md. Cubre:
//  - reindentHtml() (función pura del fallback si js-beautify no carga)
//  - El puente Alpine ↔ CodeMirror 6 sin necesidad de CM real:
//    * _syncCMValue: no-op si CM no montó, skip si mismo valor,
//      dispatch cuando difiere, '' cuando falsy
//    * _resetEditorState: setea editorHtml Y sincroniza con CM
//    * mountCMIfNeeded: lazy + idempotente
//    * formatHTML: usa html_beautify si está, cae a reindentHtml
//  - State shape: verifica que los archivos reales tengan los nombres
//    nuevos (cmContainer, mountCMIfNeeded, etc.) y NO los viejos
//    (monacoContainer, mountMonacoIfNeeded, etc.) — guards contra
//    regresiones silenciosas.
//
// Estrategia: stub portalApp con solo el bridge CM. Para lo que NO se
// puede testear acá (cargar CM6 vía dynamic import desde Node), los
// tests verifican la lógica del bridge con un EditorView mockeado.
//
// Diferencias stub vs producción (intencionales para hacer el stub
// testable en Node):
//  - stub.formatHTML usa globalThis.window?.html_beautify (Node no tiene
//    `window` global). Producción usa window.html_beautify (idiomático
//    browser). Funcionalmente idénticos.
//  - stub.initCM acepta un _importFn opcional (default a una arrow
//    que llama `import(u)` — falla en Node con https pero es lo mismo
//    que producción). Tests pasan un mock.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

// Set up `window` global para los tests (en browser es globalThis.window
// y producción lo usa como `window.html_beautify` — el stub usa
// `globalThis.window?.html_beautify` para poder testearlo en Node).
if (typeof globalThis.window === 'undefined') globalThis.window = {}

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
  const startMarker = '// ============ Editor (htmlbox-spec-codemirror-editor.md) ============'
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

// ============ stub portalApp() — solo el bridge CM ============

function makeStubApp({ cmEditorView = null, refs = {}, activeTab = 'preview', importFn = null } = {}) {
  const stub = {
    editorHtml: '',
    _cmEditorView: cmEditorView,
    _cmReady: null,
    _cmMounted: false,
    _importFn: importFn,
    activeTab,
    $refs: refs,
    showToast(msg) { stub._lastToast = msg },
    _lastToast: null,
    _beautifyCalled: false,

    mountCMIfNeeded() {
      if (stub._cmMounted) return
      if (stub.activeTab !== 'editor') return
      const container = stub.$refs && stub.$refs.cmContainer
      if (!container) return
      stub._cmMounted = true
      return stub.initCM(container)
    },

    async initCM(container) {
      const imp = stub._importFn || ((u) => import(u))
      stub._cmReady = (async () => {
        const [
          { EditorView, EditorState, lineNumbers, history, keymap },
          { html },
          { defaultKeymap, historyKeymap },
          { oneDark },
        ] = await Promise.all([
          imp('https://esm.sh/codemirror@6.65.1'),
          imp('https://esm.sh/@codemirror/lang-html@6.4.9'),
          imp('https://esm.sh/@codemirror/commands@6.5.0'),
          imp('https://esm.sh/@codemirror/theme-one-dark@6.1.2'),
        ])

        const updateListener = EditorView.updateListener.of(function (update) {
          if (update.docChanged) {
            stub.editorHtml = update.state.doc.toString()
          }
        }.bind(stub))

        const state = EditorState.create({
          doc: stub.editorHtml || '',
          extensions: [
            lineNumbers(),
            history(),
            keymap.of([defaultKeymap, historyKeymap]),
            html(),
            oneDark,
            EditorView.theme({}, { dark: true }),
            updateListener,
          ],
        })

        stub._cmEditorView = new EditorView({ state, parent: container })
      })()
      await stub._cmReady
    },

    _syncCMValue(html) {
      if (!stub._cmEditorView) return
      const view = stub._cmEditorView
      const current = view.state.doc.toString()
      const next = html || ''
      if (current === next) return
      view.dispatch({
        changes: { from: 0, to: current.length, insert: next },
      })
    },

    _resetEditorState(html) {
      stub.editorHtml = html || ''
      stub._syncCMValue(stub.editorHtml)
    },

    formatHTML() {
      // Producción usa window.html_beautify; el stub usa
      // globalThis.window?.html_beautify para ser testable en Node
      // (donde `window` no es global). Idéntico en browsers.
      const beautify = (globalThis.window && globalThis.window.html_beautify)
      if (typeof beautify === 'function') {
        try {
          stub.editorHtml = beautify(stub.editorHtml || '', {
            indent_size: 2,
            wrap_line_length: 0,
            preserve_newlines: true,
          })
          stub._beautifyCalled = true
          stub._syncCMValue(stub.editorHtml)
          stub.showToast('HTML formateado.')
          return
        } catch (err) {
          console.warn('js-beautify falló, usando reindentHtml:', err)
        }
      }
      stub.editorHtml = reindentHtml(stub.editorHtml || '')
      stub._syncCMValue(stub.editorHtml)
      stub.showToast('HTML re-indentado (fallback — js-beautify no cargó).')
    },
  }
  return stub
}

// ============ Mock de CodeMirror 6 (EditorView + EditorState) ============
//
// Devuelve un array de 4 módulos mockeados en el orden esperado por
// initCM: [core, lang-html, commands, theme]. Los tests inyectan esto
// vía `_importFn` en makeStubApp.

function makeCMMock() {
  const listeners = []
  const fakeKeymap = { of(arr) { return { __keymap: arr } } }
  const fakeState = {
    create({ doc, extensions }) {
      return {
        doc: {
          toString() { return doc || '' },
          get length() { return (doc || '').length },
        },
        extensions,
      }
    },
  }
  function fakeEditorView(config) {
    const self = {
      state: config.state,
      dispatch(changes) {
        const next = changes.changes.insert
        self.state = fakeState.create({ doc: next, extensions: self.state.extensions })
        listeners.forEach((cb) => cb({ docChanged: true }))
      },
    }
    return self
  }
  fakeEditorView.updateListener = {
    of(fn) {
      listeners.push(fn)
      return { __listener: true }
    },
  }
  fakeEditorView.theme = () => ({ __theme: true })

  return [
    { EditorView: fakeEditorView, EditorState: fakeState, lineNumbers: () => ({}), history: () => ({}), keymap: fakeKeymap },
    { html: () => ({ __langHtml: true }) },
    { defaultKeymap: [], historyKeymap: [] },
    { oneDark: {} },
  ]
}

function makeImportFn(urls) {
  return async (url) => {
    const idx = urls.indexOf(url)
    if (idx === -1) throw new Error(`Mock no preparado para ${url}`)
    return urls[`__${idx}__`] || urls[idx]
  }
}

// ============ reindentHtml() ============

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

// ============ _syncCMValue (sin CM cargado) ============

test('_syncCMValue: NO-OP si CM todavía no montó', () => {
  const app = makeStubApp({ cmEditorView: null })
  assert.doesNotThrow(() => app._syncCMValue('<html><body>x</body></html>'))
  assert.equal(app.editorHtml, '', 'el bridge no se ensució tocando state')
})

test('_syncCMValue: dispatch solo si el doc actual difiere', () => {
  let dispatchCalls = 0
  const view = {
    state: { doc: { toString: () => '<same/>', get length() { return 6 } } },
    dispatch() { dispatchCalls++ },
  }
  const app = makeStubApp({ cmEditorView: view })
  app._syncCMValue('<same/>')     // coincide → no dispatch
  assert.equal(dispatchCalls, 0)
  app._syncCMValue('<differ/>')   // buffer sigue '<same/>' → dispatch ++
  assert.equal(dispatchCalls, 1)
})

test('_syncCMValue: pasa string vacío si html es null/undefined/false/0', () => {
  let passedInsert = '<not called/>'
  const view = {
    state: { doc: { toString: () => '<initial/>', get length() { return 9 } } },
    dispatch(changes) { passedInsert = changes.changes.insert },
  }
  const app = makeStubApp({ cmEditorView: view })
  app._syncCMValue(null)
  assert.equal(passedInsert, '')
  app._syncCMValue(undefined)
  assert.equal(passedInsert, '')
  app._syncCMValue(false)
  assert.equal(passedInsert, '')
})

// ============ _resetEditorState ============

test('_resetEditorState: setea editorHtml Y sincroniza con CM', () => {
  let dispatched = false
  let insertArg = null
  const view = {
    state: { doc: { toString: () => '<prev/>', get length() { return 6 } } },
    dispatch(changes) { dispatched = true; insertArg = changes.changes.insert },
  }
  const app = makeStubApp({ cmEditorView: view })
  app.editorHtml = '<old/>'
  app._resetEditorState('<html><body>hello</body></html>')
  assert.equal(app.editorHtml, '<html><body>hello</body></html>')
  assert.equal(dispatched, true)
  assert.equal(insertArg, '<html><body>hello</body></html>')
})

test('_resetEditorState: NO-OP de CM si CM no montó (no tira)', () => {
  const app = makeStubApp({ cmEditorView: null })
  assert.doesNotThrow(() => app._resetEditorState('<html></html>'))
  assert.equal(app.editorHtml, '<html></html>')
})

// ============ mountCMIfNeeded ============

test('mountCMIfNeeded: NO monta si activeTab !== "editor"', async () => {
  const app = makeStubApp({
    activeTab: 'preview',
    refs: { cmContainer: { tagName: 'DIV' } },
    importFn: async () => makeCMMock()[0],
  })
  await app.mountCMIfNeeded()
  assert.equal(app._cmMounted, false)
  assert.equal(app._cmEditorView, null)
})

test('mountCMIfNeeded: NO monta si ya montó (idempotente)', () => {
  const sentinel = { __mounted: true, state: { doc: { toString: () => '' } } }
  const app = makeStubApp({ cmEditorView: sentinel, activeTab: 'editor' })
  app._cmMounted = true
  app.mountCMIfNeeded()
  assert.equal(app._cmEditorView, sentinel, 'no se reemplaza el editor existente')
})

test('mountCMIfNeeded: NO monta si $refs.cmContainer no existe', async () => {
  const app = makeStubApp({ activeTab: 'editor', refs: {} })
  await app.mountCMIfNeeded()
  assert.equal(app._cmMounted, false)
  assert.equal(app._cmEditorView, null)
})

test('mountCMIfNeeded: monta cuando activeTab === "editor" y refs OK', async () => {
  const [core, langHtml, commands, theme] = makeCMMock()
  const importFn = async (url) => {
    if (url.includes('codemirror@6')) return core
    if (url.includes('lang-html')) return langHtml
    if (url.includes('commands')) return commands
    if (url.includes('theme-one-dark')) return theme
    throw new Error(`Mock no preparado para ${url}`)
  }
  const app = makeStubApp({
    activeTab: 'editor',
    refs: { cmContainer: { tagName: 'DIV' } },
    importFn,
  })
  await app.mountCMIfNeeded()
  assert.equal(app._cmMounted, true)
  assert.ok(app._cmReady instanceof Promise)
  assert.ok(app._cmEditorView, 'debe quedar el EditorView montado')
})

// ============ initCM (dynamic import mockeado) ============

test('initCM: importa 4 módulos en paralelo (codemirror, lang-html, commands, theme)', async () => {
  const calls = []
  const [core, langHtml, commands, theme] = makeCMMock()
  const importFn = async (url) => {
    calls.push(url)
    if (url.includes('codemirror@6')) return core
    if (url.includes('lang-html')) return langHtml
    if (url.includes('commands')) return commands
    if (url.includes('theme-one-dark')) return theme
    throw new Error(`Mock no preparado para ${url}`)
  }
  const app = makeStubApp({ importFn })
  await app.initCM({ tagName: 'DIV' })
  assert.equal(calls.length, 4)
  assert.ok(calls[0].includes('codemirror@6'))
  assert.ok(calls[1].includes('lang-html'))
  assert.ok(calls[2].includes('commands'))
  assert.ok(calls[3].includes('theme-one-dark'))
  assert.ok(app._cmEditorView)
})

test('initCM: engancha updateListener que empuja a editorHtml en docChanged', async () => {
  const listeners = []
  const fakeKeymap = { of() { return {} } }
  const fakeState = {
    create({ doc, extensions }) {
      return { doc: { toString: () => doc || '', get length() { return (doc || '').length } }, extensions }
    },
  }
  const fakeEditorView = function (config) {
    const self = { state: config.state, dispatch() {} }
    return self
  }
  fakeEditorView.updateListener = {
    of(fn) { listeners.push(fn); return {} },
  }
  fakeEditorView.theme = () => ({})

  const allInOne = {
    EditorView: fakeEditorView,
    EditorState: fakeState,
    lineNumbers: () => ({}),
    history: () => ({}),
    keymap: fakeKeymap,
    html: () => ({}),
    defaultKeymap: [],
    historyKeymap: [],
    oneDark: {},
  }
  const fn = async () => allInOne
  const app = makeStubApp({ importFn: fn })
  await app.initCM({ tagName: 'DIV' })
  // Disparar el listener manualmente como si CM hubiera hecho docChanged.
  // En CM real, el listener recibe {docChanged: true, state: <nuevo state>};
  // en el stub el state actual tiene doc=initial-doc-string (lo que pasamos
  // al EditorState.create). Simulamos que el nuevo doc es 'X'.
  app.editorHtml = '<prev/>'
  const newState = {
    doc: { toString: () => 'X' },
    extensions: [],
  }
  for (const fn2 of listeners) fn2({ docChanged: true, state: newState })
  // El listener debe haber ejecutado y seteado editorHtml='X'.
  assert.equal(app.editorHtml, 'X', 'listener debe empujar doc.toString() a editorHtml')
  assert.ok(app._cmEditorView)
})

// ============ formatHTML ============

test('formatHTML: usa window.html_beautify si está disponible', () => {
  let beautifyArgs = null
  globalThis.window.html_beautify = (input, opts) => {
    beautifyArgs = { input, opts }
    return '<beautified/>'
  }
  try {
    const view = {
      state: { doc: { toString: () => 'X', get length() { return 1 } } },
      dispatch() {},
    }
    const app = makeStubApp({ cmEditorView: view })
    app.editorHtml = '<unformatted/>'
    app.formatHTML()
    assert.ok(beautifyArgs, 'debe llamar html_beautify')
    assert.equal(beautifyArgs.input, '<unformatted/>')
    assert.equal(beautifyArgs.opts.indent_size, 2)
    assert.equal(beautifyArgs.opts.preserve_newlines, true)
    assert.equal(app.editorHtml, '<beautified/>')
    assert.equal(app._beautifyCalled, true)
    assert.equal(app._lastToast, 'HTML formateado.')
  } finally {
    delete globalThis.window.html_beautify
  }
})

test('formatHTML: usa reindentHtml si window.html_beautify no está', () => {
  // Asegurar que html_beautify NO está
  delete globalThis.window.html_beautify
  const app = makeStubApp()
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

test('formatHTML: cae al fallback si html_beautify tira excepción', () => {
  globalThis.window.html_beautify = () => { throw new Error('boom') }
  const app = makeStubApp()
  app.editorHtml = '<html><body>x</body></html>'
  app.formatHTML()
  // Cayó al catch → reindentHtml.
  assert.equal(app.editorHtml, '<html>\n  <body>x</body>\n</html>')
  assert.match(app._lastToast, /^HTML re-indentado/)
  delete globalThis.window.html_beautify
})

// ============ state shape y referencias en archivos reales ============

test('app-script.html.txt: la sección Editor apunta al spec codemirror-editor (no monaco)', () => {
  const src = fs.readFileSync(appScriptPath, 'utf8')
  assert.match(src, /htmlbox-spec-codemirror-editor\.md/, 'debe referenciar el nuevo spec')
  assert.doesNotMatch(src, /htmlbox-spec-monaco-editor\.md/, 'no debe quedar referencia operativa al spec viejo')
})

test('app-script.html.txt: ya NO contiene los helpers del split-view', () => {
  const src = fs.readFileSync(appScriptPath, 'utf8')
  assert.doesNotMatch(src, /function findEditableBlocks/, 'findEditableBlocks debería estar borrado')
  assert.doesNotMatch(src, /function countEditableBlocks/, 'countEditableBlocks debería estar borrado')
  assert.doesNotMatch(src, /function spliceBlock/, 'spliceBlock debería estar borrado')
  assert.doesNotMatch(src, /function _scanEditableBlocks/, '_scanEditableBlocks debería estar borrado')
})

test('app-script.html.txt: el bridge Alpine↔CM6 está implementado', () => {
  const src = fs.readFileSync(appScriptPath, 'utf8')
  assert.match(src, /_cmEditorView:\s*null/, '_cmEditorView debe estar declarado en state')
  assert.match(src, /_cmReady:\s*null/, '_cmReady debe estar declarado en state')
  assert.match(src, /_cmMounted:\s*false/, '_cmMounted debe estar declarado en state')
  assert.match(src, /\basync initCM\(container\)/, 'initCM debe estar como método async')
  assert.match(src, /mountCMIfNeeded/, 'mountCMIfNeeded debe estar como método (mount lazy)')
  assert.match(src, /_syncCMValue\(html\)/, '_syncCMValue debe estar como método')
  assert.match(src, /EditorView\.updateListener\.of/, 'updateListener debe estar enganchado')
  assert.match(src, /window\.html_beautify/, 'formatHTML debe usar window.html_beautify')
})

test('app-script.html.txt: NO quedan referencias operativas a _monaco / monacoEditor / automaticLayout', () => {
  const src = fs.readFileSync(appScriptPath, 'utf8')
  assert.doesNotMatch(src, /_monacoEditor/, '_monacoEditor debería estar borrado')
  assert.doesNotMatch(src, /_monacoReady/, '_monacoReady debería estar borrado')
  assert.doesNotMatch(src, /_monacoMounted/, '_monacoMounted debería estar borrado')
  assert.doesNotMatch(src, /mountMonacoIfNeeded/, 'mountMonacoIfNeeded debería estar borrado')
  assert.doesNotMatch(src, /\binitMonaco\b/, 'initMonaco debería estar borrado')
  assert.doesNotMatch(src, /_syncMonacoValue/, '_syncMonacoValue debería estar borrado')
  assert.doesNotMatch(src, /automaticLayout/, 'automaticLayout no debe quedar en el código')
  assert.doesNotMatch(src, /monacoContainer/, 'monacoContainer ref debería estar borrado')
})

test('main-panel.html.txt: usa <div x-ref="cmContainer"> con x-effect (mount lazy), NO x-init', () => {
  const src = fs.readFileSync(mainPanelPath, 'utf8')
  assert.match(src, /<div\s+x-ref="cmContainer"\s+x-effect="activeTab === 'editor' && mountCMIfNeeded\(\)"/)
  assert.doesNotMatch(src, /<div[^>]*x-ref="cmContainer"[^>]*x-init/, 'x-init está prohibido acá')
  assert.doesNotMatch(src, /<textarea\s+x-model="editorHtml"/)
  assert.doesNotMatch(src, /monacoContainer/, 'no debe quedar el ref viejo')
  assert.doesNotMatch(src, /mountMonacoIfNeeded/, 'no debe quedar el método viejo')
})

test('shell.html.txt: NO carga Monaco, SÍ carga js-beautify', () => {
  const src = fs.readFileSync(shellPath, 'utf8')
  assert.doesNotMatch(src, /monaco-editor/, 'shell.html.txt NO debe incluir monaco-editor')
  assert.doesNotMatch(src, /vs\/loader\.js/, 'shell.html.txt NO debe incluir el AMD loader de Monaco')
  assert.match(src, /js-beautify/, 'shell.html.txt SÍ debe incluir js-beautify')
  assert.match(src, /cdnjs\.cloudflare\.com/, 'js-beautify debe venir de cdnjs')
})

test('shell.html.txt: Alpine sigue cargándose (sin regresión)', () => {
  const src = fs.readFileSync(shellPath, 'utf8')
  assert.match(src, /alpinejs@3\.13\.5/, 'Alpine debe seguir cargándose (sin regresión)')
})

test('spec htmlbox-spec-codemirror-editor.md existe en la raíz del repo', () => {
  const repoRoot = path.join(here, '..', '..', '..')
  const specPath = path.join(repoRoot, 'htmlbox-spec-codemirror-editor.md')
  assert.ok(fs.existsSync(specPath), `spec debe existir en ${specPath}`)
})
