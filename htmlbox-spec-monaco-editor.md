# HTMLBox — Spec: reemplazar el editor por Monaco Editor

**Esta spec reemplaza `htmlbox-spec-editor-split-view.md`.** El split-view (`editorView: 'all'|'js'|'css'`, botones Todo/JS/CSS, `findEditableBlocks`, `spliceBlock`) ya está implementado en `packages/portal/src/ui-partials/app-script.html.txt` y `main-panel.html.txt` — funciona, pero existe para compensar la limitación de un `<textarea>` plano: no puede resaltar HTML+JS+CSS embebidos a la vez, así que el usuario tiene que "entrar" a una vista parcial para ver su JS con algo de contexto. Monaco resuelve esto nativamente (reconoce `<script>`/`<style>` embebidos dentro de un documento HTML y los tokeniza con sus propios lenguajes, en el mismo buffer, sin cambiar de vista) — el mecanismo de split-view deja de tener motivo. Se puede borrar ese archivo; esta spec lo supera.

## 1. Qué cambia

Reemplazar en `packages/portal/src/ui-partials/main-panel.html.txt` (línea ~133):

```html
<!-- ANTES -->
<textarea x-model="editorHtml" spellcheck="false"
          placeholder="<!-- Escribe o pega tu HTML aquí -->"
          class="flex-1 w-full bg-slate-950 text-slate-200 font-mono p-4 text-xs lg:text-sm focus:outline-none resize-none code-editor"></textarea>
```

por un contenedor donde Monaco monta su propio DOM (Monaco no es un `<textarea>`, necesita un `<div>` vacío):

```html
<!-- DESPUÉS -->
<div x-ref="monacoContainer" x-init="initMonaco($refs.monacoContainer)" class="flex-1 w-full code-editor"></div>
```

Y quitar los 3 botones `Todo | JS | CSS` (líneas ~93-108 de `main-panel.html.txt`) y el label `blockCountsLabel` — ya no aplican. El resto de la barra superior (Formatear, Analizar con IA, contador de caracteres, Auto-IA al guardar) se mantiene.

## 2. Carga de Monaco (CDN, jsdelivr)

Monaco no es npm-instalable-y-listo para uso directo en browser sin bundler (usa AMD/require internamente, `web workers` por lenguaje). La vía más simple para un `<script>` suelto en `shell.html.txt` es el loader AMD que Monaco publica:

En `packages/portal/src/ui-partials/shell.html.txt`, agregar antes del script de Alpine (Monaco debe estar listo — o al menos su loader — antes de que `portalApp()` intente usarlo):

```html
<script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs/loader.js"></script>
```

Esto expone `window.require` (el AMD loader de Monaco, no confundir con Node `require` — Monaco lo namespacea internamente y no pisa nada porque el portal no usa CommonJS). El resto de Monaco (el editor en sí, el lenguaje HTML, los workers) se descarga de forma perezosa la primera vez que se instancia un editor, no al cargar la página.

**Costo real:** esto afecta solo el peso de carga del *portal* (la app de edición), nunca el HTML publicado de un box — los boxes se sirven aparte desde `runtime`/R2 como HTML estático, Monaco no viaja con ellos. El editor completo (core + lenguaje html/js/css + workers) son ~2-3 MB gzip la primera vez que se abre un box; el browser lo cachea vía CDN entre sesiones.

## 3. Puente Alpine ↔ Monaco

Monaco es imperativo: no tiene binding de dos vías nativo como `x-model`. Hay que sincronizar a mano en ambas direcciones.

En `packages/portal/src/ui-partials/app-script.html.txt`, agregar dentro de `portalApp()`:

```js
_monacoEditor: null,   // instancia de monaco.editor una vez montado
_monacoReady: null,    // promesa que resuelve cuando window.monaco existe

// Llamado una sola vez desde x-init en el <div x-ref="monacoContainer">.
// Carga el módulo 'vs/editor/editor.main' vía el loader AMD (ya inyectado
// en shell.html.txt) y monta el editor sobre el div dado.
initMonaco(container) {
  if (!window.require) {
    console.error('Monaco loader no disponible (falló la carga desde CDN).')
    return
  }
  window.require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs' } })
  this._monacoReady = new Promise((resolve) => {
    window.require(['vs/editor/editor.main'], () => {
      this._monacoEditor = monaco.editor.create(container, {
        value: this.editorHtml || '',
        language: 'html',
        theme: 'vs-dark',
        automaticLayout: true,   // re-mide en cada resize del contenedor, sin listener manual
        minimap: { enabled: false },
        fontSize: 13,
        scrollBeyondLastLine: false,
        wordWrap: 'off',
      })
      // Monaco -> Alpine: cada tecleo actualiza editorHtml (mismo rol que
      // x-model). No usar arrow function para evitar problemas de "this"
      // con el proxy de Alpine — bind explícito.
      this._monacoEditor.onDidChangeModelContent(() => {
        this.editorHtml = this._monacoEditor.getValue()
      })
      resolve()
    })
  })
},

// Alpine -> Monaco: llamar en TODO lugar donde hoy se hace
// this.editorHtml = algo (_resetEditorState, formatHTML, aiApply, etc.)
// para que el buffer visible de Monaco quede sincronizado. Es un no-op
// seguro si Monaco todavía no montó (p.ej. la primera carga de box antes
// de que resuelva _monacoReady).
_syncMonacoValue(html) {
  if (this._monacoEditor && this._monacoEditor.getValue() !== html) {
    this._monacoEditor.setValue(html || '')
  }
},
```

Y modificar `_resetEditorState` (línea ~705) para llamar `_syncMonacoValue` después de asignar `editorHtml`:

```js
_resetEditorState(html) {
  this.editorHtml = html || ''
  this.editorView = 'all'          // se puede eliminar junto con el split-view; ver §4
  this._editorFullHtml = html || ''
  this._editorBlocks = null
  this._syncMonacoValue(this.editorHtml)
},
```

Mismo patrón al final de `formatHTML()` (línea ~783, después de `this._resetEditorState(out.join('\n'))` ya cubierto por el cambio anterior — no hace falta tocarlo dos veces) y en cualquier punto de `aiApply()`/similar que reasigne `editorHtml` directamente sin pasar por `_resetEditorState`.

**Por qué no `x-model` ni un getter/setter reactivo:** Monaco mantiene su propio modelo de texto internamente (con undo stack, sintaxis, decoraciones) — no es una vista tonta sobre una variable. Forzarlo a re-renderizar en cada cambio reactivo de Alpine (como haría un `x-text` o un watcher ingenuo) resetea el cursor y el historial de undo en cada tecleo. El patrón correcto es exactamente el de arriba: Monaco es la fuente de verdad mientras el usuario escribe (empuja a `editorHtml` vía evento), y Alpine es la fuente de verdad cuando el HTML cambia por fuera (carga de box, IA, formatear — empuja a Monaco vía `setValue` solo si el valor difiere, para no interrumpir al usuario si está escribiendo).

## 4. Qué pasa con el split-view existente

Con Monaco, HTML+`<script>`+`<style>` se ven y editan en el mismo buffer con resaltado correcto de cada lenguaje embebido — el caso de uso que motivó el split-view (ver el JS sin el ruido del HTML alrededor) se resuelve con el folding nativo de Monaco (los `▾`/`▸` a la izquierda de cada bloque, "Fold All"/`Ctrl+K Ctrl+0`) en vez de una vista aparte.

Eliminar (no reemplazar):
- Los 3 botones `Todo | JS | CSS` y el label de conteo de bloques en `main-panel.html.txt` (§1).
- Del estado de `portalApp()` en `app-script.html.txt`: `editorView`, `_editorBlocks`, `_editorFullHtml` y los métodos `setEditorView`, `_commitEditorView`, el getter `_fullHtml` (queda simplemente `editorHtml`, ya no hay vista parcial que reconciliar).
- `findEditableBlocks` y `spliceBlock` si no se usan en ningún otro lugar del archivo (confirmar con grep antes de borrar — ambas viven en el bloque de utilidades compartido con los tests de Node, línea ~104-107; si esos tests solo cubren estas funciones, los tests también se pueden retirar).
- Todos los lugares que hoy leen `this._fullHtml` para obtener "el HTML completo sin importar la vista" (`saveCurrentBox`, `previewSrcdoc`, `aiApply`, listados en la grounding de esta spec: líneas 750, 827, 895 de `app-script.html.txt`) pasan a leer directamente `this.editorHtml` — con Monaco no existe vista parcial, `editorHtml` siempre es el documento completo.

Esta simplificación es la ganancia principal de migrar: se borra el mecanismo entero de "reconstruir el HTML completo a partir de un fragmento" (`_commitEditorView`/`spliceBlock`), que era la parte más frágil y con más superficie de bugs del split-view (offsets de string, un único `<script>`/`<style>` como precondición, etc.).

## 5. `formatHTML()`

El re-indentador casero actual (línea ~759, "no es un beautifier completo") se puede reemplazar por el formateador nativo de Monaco, que sí entiende HTML/JS/CSS embebido de verdad:

```js
async formatHTML() {
  if (this._monacoEditor) {
    await this._monacoReady
    await this._monacoEditor.getAction('editor.action.formatDocument').run()
    this.editorHtml = this._monacoEditor.getValue()
    return
  }
  // fallback si Monaco no cargó (CDN caído) — mantener el re-indentador
  // actual como red de seguridad, no borrarlo.
  ...
},
```

El formateador de Monaco para HTML usa `vscode-html-languageservice` internamente (viene con `vs/language/html` del propio bundle, sin dependencia nueva) y sí sabe indentar JS/CSS embebido correctamente — hoy el re-indentador casero no lo hace.

## 6. Fuera de alcance

- No se agrega autocompletado de una API custom de HTMLBox (`HTMLBox.table(...)`, etc.) ni linting — es una mejora de UX de edición pura (resaltado, folding, formato), no un editor "inteligente" sobre el SDK.
- No se cambia el mecanismo de guardado (`saveCurrentBox`, upload-url, R2) — solo la fuente del HTML que se lee (`editorHtml` en vez de `_fullHtml`).
- No se agrega selector de tema (claro/oscuro) — se fija `vs-dark` porque coincide con el estilo actual del portal (`bg-slate-950`).
- No se resuelve un fallback funcional completo si el CDN de jsdelivr está caído — el `<div>` quedaría vacío. Si esto importa, evaluarlo aparte (mirror en unpkg como `<script>` de respaldo, o self-host del bundle de Monaco en el propio Worker del portal) — no forma parte de esta spec.
- No se mide ni optimiza el tiempo de primera carga de Monaco (se asume aceptable para una herramienta interna de edición, no una app pública de alto tráfico).

## 7. Checklist de implementación

1. Agregar el `<script>` del loader de Monaco (jsdelivr) en `shell.html.txt`, antes del script de Alpine.
2. Reemplazar el `<textarea x-model="editorHtml">` por `<div x-ref="monacoContainer" x-init="initMonaco(...)">` en `main-panel.html.txt`; quitar los botones Todo/JS/CSS y el label de conteo de bloques.
3. Implementar `initMonaco`, `_syncMonacoValue`, `_monacoEditor`, `_monacoReady` en `app-script.html.txt`.
4. Actualizar `_resetEditorState` para llamar `_syncMonacoValue`.
5. Eliminar `editorView`, `_editorBlocks`, `_editorFullHtml`, `setEditorView`, `_commitEditorView`, el getter `_fullHtml`; reemplazar sus usos por `editorHtml` directo en `saveCurrentBox`, `previewSrcdoc`, `aiApply` y cualquier otro lector.
6. Confirmar si `findEditableBlocks`/`spliceBlock` (y sus tests de Node, si existen) quedan sin otro caller y retirarlos.
7. Reescribir `formatHTML()` para usar `editor.action.formatDocument` de Monaco, con el re-indentador actual como fallback si Monaco no cargó.
8. Probar manualmente: cargar un box existente (HTML+JS+CSS embebidos) y confirmar resaltado correcto sin cambiar de vista; escribir y confirmar que `editorHtml` se actualiza (ver el contador de caracteres de la barra superior moverse); Analizar con IA y Aplicar (debe seguir mandando el HTML completo); Formatear; crear un box nuevo y confirmar que el editor arranca vacío/con el seed correcto; recargar con el CDN bloqueado (DevTools throttling/offline) y confirmar que no rompe el resto del portal, solo el editor.
9. Borrar `htmlbox-spec-editor-split-view.md` (superada por esta spec).
