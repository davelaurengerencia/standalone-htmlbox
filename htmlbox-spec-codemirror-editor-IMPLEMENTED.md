# HTMLBox — Spec: reemplazar Monaco por CodeMirror 6

**Esta spec reemplaza `htmlbox-spec-monaco-editor-IMPLEMENTED.md`.** El bridge Monaco → Alpine está implementado y funciona (commits `5bebf3e` + `5de73d5`), pero trae 3 problemas concretos que justifican el switch:

1. **Bundle grande**: Monaco core + lenguaje HTML + JS + CSS + workers pesa ~2-3 MB gzip. CM6 con `@codemirror/lang-html` (que ya trae `lang-javascript` y `lang-css` para bloques embebidos) más `@codemirror/theme-one-dark` pesa ~600KB-1MB. Para un editor interno de un portal donde la mayoría de los usuarios están en Latam/mobile, 2-3 MB es mucha puerta de entrada.

2. **Polling de `automaticLayout` con `display: none`**: bug clásico de Monaco. Ya lo arreglamos con mount lazy (commit `5de73d5`), pero la solución es defensiva — si alguien vuelve a tocar el flujo y olvida el guard, el freeze vuelve. CM6 no necesita `automaticLayout`; el layout se ajusta con CSS puro. Imposible reproducir el bug.

3. **Web workers**: Monaco usa web workers por lenguaje. Pueden fallar a cargar por CORS, MIME type, sandbox del browser. Si fallan, Monaco degrada silenciosamente (syntax highlighting sigue funcionando en main thread, pero más lento). CM6 no usa workers.

El bridge Alpine↔editor mantiene el mismo shape (`_syncXxxValue`, `_xxxEditorView`, `initXxx(container)`, mount lazy), solo cambian los nombres. La ganancia principal de migrar es eliminar el riesgo de regresiones futuras sin agregar complejidad.

## 1. Qué cambia

### `packages/portal/src/ui-partials/shell.html.txt`

Borrar:

```html
<!-- Monaco editor (htmlbox-spec-monaco-editor.md): el loader AMD ... -->
<script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs/loader.js"></script>
```

Agregar (antes de Alpine, sin `defer` — debe estar listo cuando el usuario clickea Formatear):

```html
<!-- js-beautify UMD (~200KB) — usado por Formatear. CodeMirror 6 NO se carga
     con <script>: es ESM puro, se importa dinámicamente desde initCM() cuando
     el usuario abre la tab editor (cero costo inicial para quien no edita). -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/js-beautify/1.14.11/beautify-html.min.js"></script>
```

### `packages/portal/src/ui-partials/main-panel.html.txt`

```diff
- <div x-ref="monacoContainer"
-      x-effect="activeTab === 'editor' && mountMonacoIfNeeded()"
+ <div x-ref="cmContainer"
+      x-effect="activeTab === 'editor' && mountCMIfNeeded()"
       class="flex-1 w-full code-editor"></div>
```

### `packages/portal/src/ui-partials/app-script.html.txt`

State de `portalApp()`:

```diff
- _monacoEditor: null,
- _monacoReady: null,
- _monacoMounted: false,
+ _cmEditorView: null,    // instancia de EditorView una vez mount() resolvió
+ _cmReady: null,         // Promesa; resuelve cuando EditorView está montado
+ _cmMounted: false,      // guard de mount lazy (mismo rationale que _monacoMounted)
```

Métodos reescritos (mismo shape, nombres cambiados — el comportamiento es 1-a-1 con el bridge Monaco):

```js
mountCMIfNeeded() {
  if (this._cmMounted) return
  if (this.activeTab !== 'editor') return
  const container = this.$refs && this.$refs.cmContainer
  if (!container) return
  this._cmMounted = true
  this.initCM(container)
},

async initCM(container) {
  // CM6 es ESM puro. Importamos desde esm.sh (CDN que wrappea cada
  // dependencia en un módulo ESM con deps resueltas). Tres imports en
  // paralelo: codemirror core, lang-html (que ya trae lang-javascript y
  // lang-css para bloques <script>/<style> embebidos), theme-one-dark.
  this._cmReady = (async () => {
    const [
      { EditorView, EditorState, basicSetup, lineNumbers, history, keymap },
      { html },
      { defaultKeymap, historyKeymap },
      { oneDark },
    ] = await Promise.all([
      import('https://esm.sh/codemirror@6.65.1'),
      import('https://esm.sh/@codemirror/lang-html@6.4.9'),
      import('https://esm.sh/@codemirror/commands@6.5.0'),
      import('https://esm.sh/@codemirror/theme-one-dark@6.1.2'),
    ])

    // CM → Alpine: cada cambio del doc empuja a editorHtml. UpdateListener
    // solo dispara en docChanged para no spamear eventos en transacciones
    // que no modifican el doc (selección, scroll, etc.).
    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        this.editorHtml = update.state.doc.toString()
      }
    }.bind(this))

    const state = EditorState.create({
      doc: this.editorHtml || '',
      extensions: [
        lineNumbers(),
        history(),
        keymap.of([defaultKeymap, historyKeymap]),
        // lang-html: html() ya configura JS embebido en <script> y CSS en
        // <style>, sin necesidad de registrar lenguajes aparte.
        html(),
        oneDark,
        EditorView.theme({
          '&': { height: '100%', fontSize: '13px' },
          '.cm-scroller': { overflow: 'auto' },
          '.cm-gutters': { backgroundColor: 'transparent', borderRight: '1px solid rgba(255,255,255,0.05)' },
        }, { dark: true }),
        updateListener,
      ],
    })

    this._cmEditorView = new EditorView({ state, parent: container })
  })()
  await this._cmReady
},

_syncCMValue(html) {
  if (!this._cmEditorView) return
  const view = this._cmEditorView
  const current = view.state.doc.toString()
  const next = html || ''
  if (current === next) return
  view.dispatch({
    changes: { from: 0, to: current.length, insert: next },
  })
},
```

`formatHTML()` se simplifica (sin la rama async de Monaco):

```js
formatHTML() {
  if (typeof window.html_beautify === 'function') {
    try {
      this.editorHtml = window.html_beautify(this.editorHtml || '', {
        indent_size: 2,
        wrap_line_length: 0,
        preserve_newlines: true,
      })
      this._syncCMValue(this.editorHtml)
      this.showToast('HTML formateado.')
      return
    } catch (err) {
      console.warn('js-beautify falló, usando reindentHtml:', err)
    }
  }
  // Fallback si js-beautify no cargó (CDN caído). reindentHtml es offline
  // y best-effort — no maneja HTML+JS+CSS embebido tan bien como js-beautify.
  this.editorHtml = reindentHtml(this.editorHtml || '')
  this._syncCMValue(this.editorHtml)
  this.showToast('HTML re-indentado (fallback — js-beautify no cargó).')
},
```

`_resetEditorState(html)` cambia `_syncMonacoValue` → `_syncCMValue` (mismo shape):

```js
_resetEditorState(html) {
  this.editorHtml = html || ''
  this._syncCMValue(this.editorHtml)
},
```

## 2. Por qué js-beautify para Formatear (no Prettier, no solo reindentHtml)

| Opción | Bundle | Output | Latencia |
|---|---|---|---|
| Prettier standalone + plugin-html | ~1 MB extra | Excelente (gold standard) | Lento en docs >100KB |
| js-beautify UMD | ~200 KB | Bueno (maneja HTML+JS+CSS embebido) | Rápido |
| `reindentHtml` (custom) | 0 KB | Limitado (no entiende JS/CSS embebido) | Súper rápido |

Elegido: **js-beautify**. Bundle mediano (no 1MB como Prettier), output decente que sí entiende bloques `<script>`/`<style>` embebidos, sin latencia notable. Si en el futuro se necesita formato gold-standard, se puede agregar Prettier como upgrade sin tocar la integración actual.

`reindentHtml` se queda como fallback si js-beautify no carga (CDN caído).

## 3. Por qué dynamic import (no `<script>` tag para CM6)

CM6 es ESM puro. Opciones para usarlo en el browser:

| Opción | Pros | Contras |
|---|---|---|
| `<script type="module">` con `import` | Estándar | Descarga TODO al cargar la página, incluso si el usuario nunca abre la tab editor |
| Dynamic `import()` en `initCM()` | Cero costo para quien no edita | Más complejo de testear |

Elegido: **dynamic import**. Los usuarios que solo crean boxes desde el seed o que solo ven el preview nunca descargan el bundle de CM6. El bundle solo se baja la primera vez que abren la tab editor y se cachea entre sesiones.

## 4. Por qué NO usar `<script type="module">` con bundle precompilado

CM6 tiene un "official bundle" en `https://esm.sh/codemirror@6` pero pesa ~600KB sin las extensiones. Las extensiones (`@codemirror/lang-html`, `@codemirror/theme-one-dark`) son paquetes separados que tree-shaking solo funciona con un bundler. Como no usamos bundler (es HTML crudo), ir por dynamic import nos da tree-shaking gratis a nivel de import por archivo: solo se baja lo que necesitamos.

## 5. Mount lazy: por qué y cómo

**Por qué**: la tab editor arranca oculta (`x-show="activeTab === 'editor'"`, default `'preview'`). Si CM6 se monta al cargar la página (vía `x-init`), monta sobre un contenedor 0×0 con CSS que aún no tiene tamaño computado. Algunos editores de código manejan esto; CM6 lo maneja pero queremos consistencia con el comportamiento anterior.

**Cómo**: el `<div>` usa `x-effect="activeTab === 'editor' && mountCMIfNeeded()"`. La función `mountCMIfNeeded()` tiene guards idempotentes (NO-OP si ya montó / tab no es editor / sin `$refs`). La primera vez que `activeTab` pasa a `'editor'`, dispara el mount; después es no-op.

## 6. Puente Alpine ↔ CM (mismo rationale que con Monaco)

CM6 mantiene su propio `EditorState` (undo stack, cursor, syntax). Forzar re-render en cada cambio reactivo de Alpine (como haría un `x-text` o un watcher ingenuo) resetea el cursor y la pila de undo en cada tecla. El patrón correcto:

- **CM → Alpine**: `EditorView.updateListener.of((u) => { if (u.docChanged) this.editorHtml = u.state.doc.toString() })`. Solo dispara en `docChanged`, no en cada selección.
- **Alpine → CM**: `_syncCMValue(html)` despacha un cambio `{from:0, to:doc.length, insert:html}` solo si el doc actual difiere. Usado desde `_resetEditorState()` y desde `formatHTML()` cuando reasigna `editorHtml`.

## 7. Lo que NO cambia

- `editorHtml` sigue siendo el "snapshot" reactivo de Alpine; CM es el editor real.
- `saveCurrentBox`, `previewSrcdoc`, `aiAnalyze`, `aiApply` siguen leyendo `this.editorHtml` directo (después del refactor anterior no hay `_fullHtml` getter).
- La sección `Editor (htmlbox-spec-…)` del `app-script.html.txt` solo tiene `reindentHtml` como función pura; todo lo demás vive dentro de `portalApp()`.
- Costo del CDN afecta SOLO el portal, nunca el HTML publicado de un box (que sale de runtime/R2 como static).
- Sin autocompletado de `HTMLBox.table(...)` ni linting — sigue siendo un editor "tonto" sobre el buffer, no un IDE.

## 8. CDN elegidos

| Recurso | Versión | Por qué |
|---|---|---|
| `https://esm.sh/codemirror@6.65.1` | 6.65.1 | Última estable de la 6.x (la 7.x está en preview). |
| `https://esm.sh/@codemirror/lang-html@6.4.9` | 6.4.9 | Trae `lang-javascript` y `lang-css` para bloques embebidos. |
| `https://esm.sh/@codemirror/commands@6.5.0` | 6.5.0 | Para `defaultKeymap` y `historyKeymap` (Ctrl+Z, etc.). |
| `https://esm.sh/@codemirror/theme-one-dark@6.1.2` | 6.1.2 | Equivalente al `vs-dark` de Monaco. |
| `https://cdnjs.cloudflare.com/ajax/libs/js-beautify/1.14.11/beautify-html.min.js` | 1.14.11 | UMD, expone `window.html_beautify`. |

**Por qué esm.sh y no jsdelivr/unpkg directo para CM6**: esm.sh wrappea cada paquete npm en un módulo ESM con todas sus deps resueltas (incluso las peer deps que CM6 tiene entre sus sub-paquetes, que son un quilombo). jsdelivr sirve el `main` de cada paquete tal cual, que a veces es CJS — incompatible con `<script type="module">`. esm.sh es la opción más predecible para browser sin bundler.

**Por qué cdnjs.cloudflare.com para js-beautify**: es UMD (no ESM), se sirve con `<script>` clásico. cdnjs es el CDN más estable para UMD.

## 9. Checklist de implementación

1. Borrar `<script src="...monaco-editor@0.52.0/.../loader.js">` de `shell.html.txt`.
2. Agregar `<script src=".../js-beautify/.../beautify-html.min.js">` antes de Alpine en `shell.html.txt`.
3. En `main-panel.html.txt`: renombrar `monacoContainer` → `cmContainer` y `mountMonacoIfNeeded` → `mountCMIfNeeded`.
4. En `app-script.html.txt`:
   - Renombrar state: `_monacoEditor` → `_cmEditorView`, `_monacoReady` → `_cmReady`, `_monacoMounted` → `_cmMounted`.
   - Reemplazar métodos `mountMonacoIfNeeded`, `initMonaco`, `_syncMonacoValue` por `mountCMIfNeeded`, `initCM`, `_syncCMValue`.
   - `_resetEditorState` llama `_syncCMValue` en vez de `_syncMonacoValue`.
   - `formatHTML` usa `window.html_beautify` (con fallback a `reindentHtml`).
5. Borrar `packages/portal/__tests__/monacoEditor.test.js`. Crear `packages/portal/__tests__/codemirrorEditor.test.js` con la misma estructura: 4 de `reindentHtml`, 3 de `_syncCMValue`, 2 de `_resetEditorState`, 3 de `mountCMIfNeeded`, 2 de `initCM` (mockeando `import()`), 2 de `formatHTML`, 8 de state shape en archivos reales.
6. Probar manualmente: login → click Editor → CM6 bundle descarga lazy → resaltado correcto de HTML+`<script>`+`<style>` → Formatear usa js-beautify → escribir y ver el contador de caracteres moverse → guardar y confirmar que `saveCurrentBox` manda el HTML completo.
7. Renombrar `htmlbox-spec-codemirror-editor.md` → `htmlbox-spec-codemirror-editor-IMPLEMENTED.md`.
8. Actualizar AGENTS.md: borrar entrada de monaco (o dejarla con nota "superseded by codemirror") y agregar codemirror.

## 10. Fuera de alcance

- No se agrega autocompletado de `HTMLBox.table(...)` ni linting.
- No se agrega soporte de temas (claro/oscuro) — se fija `one-dark` porque coincide con el estilo del portal.
- No se mide ni optimiza el tiempo de primera carga de CM6 (se asume aceptable para una herramienta interna).
- No se cambia el mecanismo de guardado (`saveCurrentBox`, upload-url, R2) — solo la fuente del HTML que se lee.
- No se cambia `reindentHtml` (se queda idéntico como fallback offline).
