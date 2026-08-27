# HTMLBox — Spec: vista dividida HTML / JS / CSS en el editor del portal

Repo: `htmlbox` (`packages/portal`). Spec para que el equipo lo implemente al pie de la letra, para aplicar cuando decidan. Es **puramente visual/de edición** — no toca `packages/runtime`, ni R2, ni el modelo de versionado. El box se sigue guardando y sirviendo exactamente como hoy: un solo string de HTML por versión.

## 0. Qué es y qué NO es

Hoy la tab "Editor HTML" (`packages/portal/src/ui-partials/main-panel.html.txt`, línea ~100) es un único `<textarea x-model="editorHtml">` con todo el HTML mezclado — markup, `<script>` y `<style>` juntos. Este spec agrega un selector de vista dentro de esa misma tab (`Todo | HTML | JS | CSS`) que, al elegir JS o CSS, muestra en el textarea SOLO ese contenido para editar más cómodo — y al volver a "Todo" (o al guardar), reconstruye el HTML completo metiendo de vuelta lo editado en su posición original.

**NO es** un editor multi-archivo de verdad, NO guarda archivos separados, NO cambia `POST /api/boxes/:id/html` (sigue mandando un solo string de HTML como siempre). Es una conveniencia de edición sobre el mismo textarea de siempre.

## 1. Alcance de v1 — deliberadamente limitado

Para no meterse en reconciliación frágil de múltiples bloques, v1 solo activa las vistas JS/CSS cuando hay **exactamente un** bloque del tipo correspondiente:

- Vista **JS** disponible solo si el HTML tiene exactamente un `<script>` sin atributo `src` (un script externo tipo `<script src="https://cdn.tailwindcss.com">` nunca cuenta — esos se quedan siempre en la vista "HTML").
- Vista **CSS** disponible solo si el HTML tiene exactamente un `<style>`.
- Si hay 0 bloques de un tipo, esa vista no aparece (no hay nada que mostrar). Si hay 2+, esa vista tampoco aparece — se deja para v2 (ver sección 6) en vez de armar una reconciliación de múltiples bloques a medias.

Esto cubre el caso típico: la IA genera un solo `<script>` grande con toda la lógica, y como Tailwind vive en clases del markup (no en `<style>`), lo normal es que no haya `<style>` en absoluto — cuando sí lo hay (animaciones custom, `@keyframes`), casi siempre es uno solo.

## 2. Detección y extracción — posiciones exactas, sin reserializar

Usar regex con el flag `d` (`hasIndices`) para obtener las posiciones exactas de cada grupo capturado — así la reconstrucción reemplaza SOLO el contenido interno, sin tocar ni un carácter del resto del documento (nada de `DOMParser` + reserializar, que puede reordenar atributos o alterar espacios/entities).

```js
// Nuevo helper, ej. en un <script> aparte dentro de app-script.html.txt o
// junto a las demás funciones de portalApp().

// Devuelve { script: {innerStart, innerEnd, content} | null, style: {...} | null }
// null en cada caso si no hay EXACTAMENTE un bloque de ese tipo (0 o 2+).
function findEditableBlocks(html) {
  const re = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1>/gid
  const scripts = []
  const styles = []
  let m
  while ((m = re.exec(html))) {
    const tag = m[1].toLowerCase()
    const attrs = m[2]
    if (tag === 'script' && /\bsrc\s*=/i.test(attrs)) continue // script externo, no se toca
    const [innerStart, innerEnd] = m.indices[3]
    const block = { innerStart, innerEnd, content: m[3] }
    if (tag === 'script') scripts.push(block)
    else styles.push(block)
  }
  return {
    script: scripts.length === 1 ? scripts[0] : null,
    style: styles.length === 1 ? styles[0] : null,
  }
}

// Reemplaza SOLO el rango [innerStart, innerEnd) del html original por newContent.
// No toca nada fuera de ese rango — es la operación inversa de la extracción.
function spliceBlock(html, block, newContent) {
  return html.slice(0, block.innerStart) + newContent + html.slice(block.innerEnd)
}
```

`match.indices[3]` requiere que el navegador soporte el flag `d` en RegExp (soportado en todos los navegadores modernos desde 2022 — Chrome 90+, Firefox 88+, Safari 15+; dado que el portal ya usa sintaxis moderna sin transpilar, esto es coherente con lo que ya asumen).

## 3. Estado nuevo en `portalApp()`

```js
// Agregar junto al resto del estado del editor:
editorView: 'all',        // 'all' | 'html' | 'js' | 'css'
_editorBlocks: null,      // cache de findEditableBlocks(editorHtml), se recalcula al entrar a editor
_editorFullHtml: null,    // snapshot de editorHtml con vista 'all', para reconstruir contra ESE snapshot
```

Por qué un snapshot aparte (`_editorFullHtml`) y no reconstruir siempre contra `editorHtml` directo: mientras el usuario está en vista JS, `editorHtml` (el `x-model` del textarea) contiene el contenido *parcial* (solo el JS), no el HTML completo — necesitamos guardar aparte cuál era el HTML completo antes de entrar a esa vista, para poder hacer `spliceBlock()` contra el documento entero al salir.

## 4. Métodos nuevos

```js
// Se llama al hacer click en cada botón de vista del selector.
setEditorView(view) {
  if (view === this.editorView) return

  // Si estábamos en JS o CSS, primero reconstruimos el HTML completo con lo
  // editado antes de cambiar de vista (o se pierde el cambio).
  this._commitEditorView()

  if (view === 'all') {
    this.editorView = 'all'
    this.editorHtml = this._editorFullHtml
    return
  }

  // Recalculamos los bloques SOBRE el HTML completo actualizado.
  const blocks = findEditableBlocks(this._editorFullHtml)
  const block = view === 'js' ? blocks.script : blocks.style
  if (!block) {
    this.showToast(view === 'js' ? 'No hay un único <script> para editar por separado.' : 'No hay un único <style> para editar por separado.')
    return
  }
  this._editorBlocks = blocks
  this.editorView = view
  this.editorHtml = block.content
},

// Mete de vuelta lo editado en el HTML completo. Se llama antes de cambiar
// de vista Y antes de guardar (ver saveCurrentBox() más abajo).
_commitEditorView() {
  if (this.editorView === 'all') {
    this._editorFullHtml = this.editorHtml
    return
  }
  const block = this.editorView === 'js' ? this._editorBlocks?.script : this._editorBlocks?.style
  if (!block) return // no debería pasar, pero nunca reventar por esto
  this._editorFullHtml = spliceBlock(this._editorFullHtml, block, this.editorHtml)
},
```

**Al entrar a la tab Editor** (o al cargar un box), inicializar `_editorFullHtml = this.editorHtml` y `editorView = 'all'` — buscar dónde ya se setea `editorHtml` hoy (`loadActiveHtml()`, `createBox()`, `handleNewBoxFile()`, `seedFor()`) y agregar esas dos líneas en cada uno de esos puntos.

## 5. Cambio en `saveCurrentBox()` — commitear antes de guardar

`saveCurrentBox()` (en `app-script.html.txt`) hoy lee `this.editorHtml` directo. Si el usuario está parado en la vista JS y aprieta "Guardar" sin volver a "Todo" primero, hay que asegurarse de que se guarde el documento completo reconstruido, no solo el fragmento de JS que está viendo. Agregar al principio del método, antes de todo lo demás:

```js
async saveCurrentBox() {
  if (!this.currentBox) return
  this._commitEditorView()
  const fullHtml = this.editorView === 'all' ? this.editorHtml : this._editorFullHtml
  if (!fullHtml.trim()) {
    this.showToast('El HTML está vacío.')
    return
  }
  this.saving = true
  try {
    const size = new Blob([fullHtml]).size
    // ...el resto del método sigue igual, pero usando `fullHtml` en vez de
    // `this.editorHtml` en el body del PUT a R2 y en cualquier otro lugar
    // donde hoy se lee `this.editorHtml` directo dentro de este método.
```

Importante: `editorHtml.length` que se muestra en el header del editor (línea ~92 de `main-panel.html.txt`, "X caracteres") va a mostrar el largo del fragmento actual cuando la vista no es "Todo" — eso es intencional (le sirve al usuario para saber qué tan largo es lo que está mirando), no es un bug.

## 6. UI — selector de vista

En `main-panel.html.txt`, dentro del header de la tab Editor (junto al botón "Formatear"), agregar:

```html
<div class="flex items-center gap-1 bg-slate-950 border border-slate-800 rounded-lg p-0.5" x-show="_editorBlocks !== undefined">
  <button @click="setEditorView('all')" :class="editorView === 'all' ? 'bg-slate-700 text-white' : 'text-slate-500 hover:text-slate-300'"
          class="px-2 py-1 rounded text-[11px] font-medium transition">Todo</button>
  <button @click="setEditorView('js')" x-show="findEditableBlocks(_editorFullHtml).script"
          :class="editorView === 'js' ? 'bg-slate-700 text-white' : 'text-slate-500 hover:text-slate-300'"
          class="px-2 py-1 rounded text-[11px] font-medium transition">JS</button>
  <button @click="setEditorView('css')" x-show="findEditableBlocks(_editorFullHtml).style"
          :class="editorView === 'css' ? 'bg-slate-700 text-white' : 'text-slate-500 hover:text-slate-300'"
          class="px-2 py-1 rounded text-[11px] font-medium transition">CSS</button>
</div>
```

Nota de performance menor: los `x-show` de arriba llaman a `findEditableBlocks()` en cada render de Alpine — sobre un HTML de hasta 2MB (`MAX_HTML_BYTES` en `@htmlbox/shared`) puede notarse. Si al probarlo se siente lento, cachear el resultado en una propiedad computed (`get availableViews() { ... }` con un getter de Alpine, o recalcular solo dentro de `setEditorView`/al cargar el box en vez de en cada `x-show`) — dejarlo así en la primera pasada y optimizar si hace falta, no antes.

## 7. Qué queda fuera de v1 (anotado, no bloqueante)

- **Múltiples `<script>`/`<style>`** — hoy simplemente no ofrece la vista dividida. Si se quiere soportar, la forma segura es concatenar los bloques con un separador único e inconfundible (ej. `\n/* ===== HTMLBOX_BLOCK_2 ===== */\n`) y, al reconstruir, **validar que el split por ese separador produzca la MISMA CANTIDAD de segmentos que bloques originales** — si no coincide (el usuario borró o duplicó el separador sin querer), rechazar el guardado con un error explícito en vez de reconstruir mal el HTML.
- **Syntax highlighting real** (colores para JS/CSS dentro del textarea) — v1 sigue siendo un `<textarea>` plano con fuente monoespaciada, igual que hoy. Meter un editor de código de verdad (CodeMirror vía CDN, por ejemplo) es un cambio bastante más grande y no es parte de este spec — si lo quieren después, es una conversación aparte.
- **Vista dividida simultánea** (3 paneles a la vez en vez de un selector que cambia de contenido) — v1 es un solo textarea que cambia qué muestra; no hay problema de sincronización entre paneles porque solo existe uno visible a la vez.

## 8. Checklist de implementación

1. Agregar `findEditableBlocks()` y `spliceBlock()` como funciones sueltas en `app-script.html.txt` (antes de `function portalApp()`, junto a los demás helpers globales).
2. Agregar el estado nuevo (`editorView`, `_editorBlocks`, `_editorFullHtml`) a `portalApp()`.
3. Agregar `setEditorView()` y `_commitEditorView()`.
4. Inicializar `_editorFullHtml = editorHtml` + `editorView = 'all'` en los 4 puntos donde hoy se asigna `editorHtml` (`loadActiveHtml`, `createBox`, `handleNewBoxFile`, `seedFor`).
5. Actualizar `saveCurrentBox()` para commitear la vista antes de armar el `Blob`/PUT.
6. Agregar el selector de vista en `main-panel.html.txt`.
7. Probar con un box real: pegar HTML con un `<script>` y un `<style>`, cambiar entre las 3 vistas, editar en cada una, volver a "Todo" y confirmar que el HTML final es correcto (comparar visualmente o con un diff contra lo esperado). Probar también el caso de 2+ `<script>` — confirmar que la vista JS simplemente no aparece, sin romper nada.
