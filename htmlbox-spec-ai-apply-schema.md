# HTMLBox — Spec: que "Aplicar" el análisis de IA haga algo de verdad

Repo: `htmlbox`. Spec para que el equipo lo implemente al pie de la letra. No es parte de las specs de "usuarios de las apps" (fases 1-3) — es un tema aparte: cierra un hueco real en la funcionalidad de análisis de schema por IA que ya existe (`packages/control-plane/src/routes/ai.js` + `lib/aiProvider.js`).

## 0. El hueco exacto

Hoy el flujo es: el tenant pega HTML con datos embebidos (ej. `const productos = [ {...}, {...} ]` dentro de un `<script>`), pide un análisis (`POST /api/ai/analyze-html`), Gemini devuelve una propuesta de schema (`tables[]`, con `columns` y 2-3 `sample_rows` de ejemplo) — todo esto ya funciona y ya está bien hecho. El problema es el paso siguiente: `POST /api/ai/analyses/:id/apply` (revisado en `routes/ai.js` líneas 158-179) **solo hace `UPDATE ... SET applied = 1`**. No crea ninguna tabla en la Turso del box, no mueve ni una fila de datos real, no toca el HTML. La propuesta de la IA queda como una sugerencia bonita que nadie ejecuta — el dato sigue embebido en el HTML exactamente como estaba.

Esta spec hace que "Aplicar" haga lo que su nombre promete: (1) cargar los datos REALES (no solo las 2-3 sample_rows) a la Turso del box, y (2) reescribir el HTML para que deje de tener el array embebido y lo pida por la Data API (`HTMLBox.table('slug').rows()`, que es literalmente el `sdk_example` que la IA ya devuelve hoy sin que nadie lo use).

## 1. Por qué "aplicar" no es trivial — y la solución

Dos problemas reales, en orden:

**Problema A — la IA nunca vio TODAS las filas.** `analyzeHtml()` le pide a Gemini 2-3 `sample_rows` de ejemplo, no el dataset completo (tiene sentido para no gastar tokens proponiendo schema). Pero para "aplicar" de verdad hacen falta las filas reales — todas. La propuesta de la IA (guardada en `proposal_json`, D1) no alcanza como fuente de los datos a cargar.

**Problema B — reescribir JS ajeno sin romperlo es delicado.** El HTML del tenant puede tener el array usado de mil formas distintas más abajo en el mismo script. Reescribirlo a ciegas es peligroso. La solución de esta spec es deliberadamente **conservadora**: en vez de intentar entender toda la lógica del script, se apoya en un patrón de JS que ya es válido hoy y no requiere entender nada más que "¿dónde empieza y termina este array literal exacto?" — top-level `await` dentro de un `<script type="module">`.

```html
<!-- ANTES -->
<script>
  const productos = [ {"nombre":"Mesa","precio":100}, {"nombre":"Silla","precio":40} ]
  renderTabla(productos)
</script>

<!-- DESPUÉS -->
<script type="module">
  const productos = await HTMLBox.table('productos').rows({ limit: 1000 })
  renderTabla(productos)
</script>
```

Como `type="module"` soporta `await` a nivel superior del script, el resto del código que sigue **abajo, en el mismo bloque**, se sigue ejecutando en el mismo orden que antes — solo que ahora espera a que la Data API responda antes de seguir. `renderTabla(productos)` sigue funcionando exactamente igual, sin que el sistema tenga que entender qué hace `renderTabla`. Es el único cambio de JS que se hace — no se toca nada más del script.

Esto **exige** que el box tenga exactamente un `<script>` inline (sin `src`) — mismo límite que ya se estableció en `htmlbox-spec-editor-split-view.md` §1 ("v1 solo activa las vistas JS/CSS cuando hay exactamente un bloque del tipo correspondiente"). Si hay 0 o 2+ scripts, "Aplicar" no está disponible — mismo criterio de esa spec, no se reinventa.

## 2. Paso 1 (nuevo, determinístico, sin IA): extractor de arrays candidatos

Antes de involucrar a Gemini para nada de esto, un extractor puramente mecánico (regex + `JSON.parse`, **nunca `eval()`** sobre código del tenant) busca, dentro del único `<script>` del HTML, declaraciones `const NOMBRE = [ ... ]` / `let NOMBRE = [ ... ]` cuyo array sea JSON válido (con `JSON.parse` directo — si el tenant/la IA que armó el HTML original usó comillas simples o trailing commas, ese candidato simplemente no matchea y se descarta, no se intenta "reparar" JS a medias).

```js
// packages/control-plane/src/lib/dataExtractor.js (nuevo archivo)
//
// Determinístico, sin IA, sin eval(). Encuentra candidatos de arrays de
// datos embebidos en el único <script> inline del HTML de un box.

// Devuelve el contenido del único <script> sin `src`, o null si hay 0 o 2+.
export function findSingleInlineScript(html) {
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
  const matches = []
  let m
  while ((m = re.exec(html))) {
    if (/\bsrc\s*=/i.test(m[1])) continue // externo, no cuenta
    matches.push({ attrs: m[1], content: m[2], start: m.index, end: re.lastIndex, fullMatch: m[0] })
  }
  return matches.length === 1 ? matches[0] : null
}

// Devuelve [{ varName, declStart, declEnd, arrayText, rows, rowCount }]
// declStart/declEnd son posiciones ABSOLUTAS dentro del HTML completo (no
// del script) — para poder hacer splice directo sobre el html original,
// mismo patrón que spliceBlock() de htmlbox-spec-editor-split-view.md.
export function extractArrayCandidates(html) {
  const script = findSingleInlineScript(html)
  if (!script) return []

  const re = /\b(?:const|let)\s+([a-zA-Z_$][\w$]*)\s*=\s*(\[[\s\S]*?\])\s*;?/gd
  const candidates = []
  let m
  while ((m = re.exec(script.content))) {
    const arrayText = m[2]
    let rows
    try {
      rows = JSON.parse(arrayText)
    } catch {
      continue // no es JSON válido (comillas simples, trailing comma, código, etc.) — se descarta
    }
    if (!Array.isArray(rows) || rows.length === 0) continue
    if (!rows.every(r => r && typeof r === 'object' && !Array.isArray(r))) continue // solo array de objetos

    const [declStartInScript, declEndInScript] = m.indices[0]
    candidates.push({
      varName: m[1],
      declStart: script.start + '<script'.length + script.attrs.length + 1 + declStartInScript, // ver nota abajo
      declEnd: script.start + '<script'.length + script.attrs.length + 1 + declEndInScript,
      arrayText,
      rows,
      rowCount: rows.length,
    })
  }
  return candidates
}
```

Nota sobre el cálculo de `declStart`/`declEnd`: el offset exacto de `<script ...>` hasta el inicio del `content` (`m[2]` del regex de `findSingleInlineScript`) es más simple de calcular guardando directamente el índice de inicio de `content` en vez de reconstruirlo a mano como en el pseudo-código de arriba (que es propenso a error de off-by-one) — usar el flag `d` también en `findSingleInlineScript` y devolver `script.contentStart` real (`m.indices[2][0]`), y calcular `declStart = script.contentStart + declStartInScript`. Ajustar antes de implementar — la spec de `editor-split-view.md` §2 ya resolvió exactamente este mismo problema de posiciones exactas, seguir ese patrón (`match.indices[N]`) en vez del cálculo manual de arriba.

## 3. Paso 2: la IA mapea cada tabla propuesta a un candidato (no lee HTML crudo para esto)

Se extiende `aiProvider.js` para que, en vez de que Gemini "adivine" la estructura leyendo HTML crudo (como hace hoy), reciba la lista de candidatos YA EXTRAÍDOS (determinísticamente, paso 2) y solo tenga que **mapear** cada tabla propuesta a un `varName` de esa lista — una tarea mucho más acotada y confiable que "encontrar y entender JS libre".

```js
// Cambios en aiProvider.js:

// 1. buildPrompt ahora recibe también los candidatos, se los agrega al prompt:
function buildPrompt(html, candidates) {
  const candidatesSummary = candidates.map(c =>
    `- varName: "${c.varName}", rowCount: ${c.rowCount}, primera fila: ${JSON.stringify(c.rows[0])}`
  ).join('\n')
  return `${SYSTEM_PROMPT}\n\n${USER_PROMPT_TMPL(escapeBackticks(html))}\n\nCandidatos de datos ya detectados en el HTML (deterministicamente, por regex):\n${candidatesSummary}\n\nPara cada tabla que propongas, el campo "source_var" DEBE ser exactamente uno de esos varName, o null si la tabla no corresponde a ningún candidato (ej. si proponés una tabla para datos que en realidad NO están en un array literal, sino que vienen de un fetch()).`

// 2. SYSTEM_PROMPT: agregar "source_var": "string|null" al shape del JSON de salida,
//    con la regla: "source_var DEBE ser uno de los varName de la lista de candidatos
//    dada, o null. NUNCA inventes un varName que no esté en la lista."

// 3. validateProposal: validar que source_var, si no es null, existe en candidates
//    (pasar candidates como segundo argumento) — si no matchea ninguno, forzar a null
//    (defensivo: no confiar ciegamente en que la IA respetó la instrucción).
export function validateProposal(tables, candidates = []) {
  const validVarNames = new Set(candidates.map(c => c.varName))
  return (Array.isArray(tables) ? tables : []).filter(/* igual que antes */).map((t) => ({
    // ...campos existentes igual que antes...
    source_var: validVarNames.has(t.source_var) ? t.source_var : null,
  }))
}
```

Una tabla propuesta con `source_var: null` (la IA decidió que no corresponde a ningún array embebido — por ejemplo, propuso una tabla para datos que vienen de un `fetch()` externo, no de un literal) **no tiene botón de "Aplicar" real** — sigue siendo solo una sugerencia de schema, como hoy. Solo las tablas con `source_var` no nulo son las que esta spec resuelve.

## 4. Paso 3: `applyAnalysis` hace el trabajo real

Reescribir `applyAnalysis` en `routes/ai.js`. Necesita, además de lo que ya tiene: (a) el HTML actual del box (para volver a correr el extractor y confirmar que el candidato sigue ahí — si el tenant editó el box desde que se hizo el análisis, el candidato puede haber cambiado o desaparecido), (b) escribir en la Turso del box (reusa `connectToBox`/`ensureBoxSchema` de `tursoClient.js` y `physicalTableSqlFor` de `boxSchema.js` — control-plane ya tiene acceso directo a la Turso de cualquier box, no hace falta pasar por runtime para esto), (c) guardar una nueva versión del HTML en R2 (reusa `recordVersion`/`purgeIfOverLimit` de `versioning.js`, ya usados en `uploads.js#postPushHtml` — mismo patrón, pero escrito directo a R2 en vez del baile de presigned-URL, porque acá quien escribe es el propio Worker, no el browser).

```js
// routes/ai.js — reemplaza la función applyAnalysis actual.

import { connectToBox } from '../lib/tursoClient.js'
import { physicalTableSqlFor } from '@htmlbox/shared'
import { recordVersion, purgeIfOverLimit } from '@htmlbox/shared' // ya se usan en uploads.js
import { extractArrayCandidates } from '../lib/dataExtractor.js'
import { boxVersionKey } from '@htmlbox/shared'

async function applyAnalysis(request, env, analysisIdStr) {
  const { user, error } = await requireUser(request, env)
  if (error) return error

  const analysisRow = await env.DB.prepare(
    `SELECT id, box_id, proposal_json, applied FROM htmlbox_ai_analyses WHERE id = ?1`,
  ).bind(analysisIdStr).first()
  if (!analysisRow) return json({ error: 'not_found' }, 404)
  if (analysisRow.applied) return json({ error: 'already_applied' }, 409)

  const box = await resolveBox(env, user, analysisRow.box_id) // ya existe, trae tenant_id/workspace_id
  if (!box) return json({ error: 'not_found' }, 404)
  try { requireRole(box, 'owner', 'editor') } catch (err) { return json({ error: 'forbidden', detail: err?.message }, 403) }

  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const currentHtml = typeof body?.html === 'string' ? body.html : ''
  if (!currentHtml) return json({ error: 'missing_current_html' }, 400) // el portal manda el HTML actual del editor

  const proposal = JSON.parse(analysisRow.proposal_json)
  const tables = (proposal.tables || []).filter(t => t.source_var)
  if (tables.length === 0) return json({ error: 'nothing_to_apply', detail: 'ninguna tabla propuesta tiene source_var' }, 400)

  // Re-correr el extractor SOBRE EL HTML ACTUAL — no confiar en lo que había
  // cuando se hizo el análisis, puede haber cambiado.
  const freshCandidates = extractArrayCandidates(currentHtml)
  const byVarName = new Map(freshCandidates.map(c => [c.varName, c]))

  const boxRow = await env.DB.prepare(
    `SELECT b.turso_db_url, b.turso_db_token, t.slug AS tenant_slug FROM htmlbox_boxes b JOIN htmlbox_tenants t ON t.id = b.tenant_id WHERE b.id = ?1`
  ).bind(box.id).first()
  if (!boxRow?.turso_db_url) return json({ error: 'box_db_not_ready' }, 409)
  const client = await connectToBox(env, boxRow.turso_db_url, boxRow.turso_db_token)

  const applied = []
  const skipped = []
  let html = currentHtml
  // Ordenar por posición DESCENDENTE antes de hacer los splice — reemplazar
  // de atrás para adelante evita que los offsets de los reemplazos previos
  // invaliden los índices de los siguientes (mismo problema que cualquier
  // edición de texto por posiciones — resolver con orden, no recalculando).
  const toApply = tables
    .map(t => ({ table: t, candidate: byVarName.get(t.source_var) }))
    .filter(x => x.candidate)
    .sort((a, b) => b.candidate.declStart - a.candidate.declStart)

  for (const t of tables) {
    if (!byVarName.has(t.source_var)) skipped.push({ slug: t.slug, reason: 'candidate_no_longer_present' })
  }

  for (const { table, candidate } of toApply) {
    // 1) crear la tabla física + índice (mismo SQL que usan las tablas normales del box)
    await client.execute(physicalTableSqlFor(table.slug))
    // 2) meta en htmlbox_tables — igual formato que ensureTable() de dataApi.js
    await client.execute({
      sql: `INSERT INTO htmlbox_tables (slug, name, columns_json, mode) VALUES (?1, ?2, ?3, 'manual')
            ON CONFLICT(slug) DO UPDATE SET columns_json = excluded.columns_json, updated_at = datetime('now')`,
      args: [table.slug, table.name, JSON.stringify(table.columns)],
    })
    // 3) TODAS las filas reales del candidato (no las 2-3 sample_rows de la IA)
    for (const row of candidate.rows) {
      await client.execute({
        sql: `INSERT INTO htmlbox_${table.slug} (data_json) VALUES (?1)`,
        args: [JSON.stringify(row)],
      })
    }
    // 4) reemplazar la declaración en el HTML por la llamada a la Data API
    const replacement = `const ${candidate.varName} = await HTMLBox.table('${table.slug}').rows({ limit: 1000 })`
    html = html.slice(0, candidate.declStart) + replacement + html.slice(candidate.declEnd)
    applied.push({ slug: table.slug, varName: candidate.varName, rowsInserted: candidate.rows.length })
  }

  if (applied.length === 0) {
    return json({ error: 'nothing_applied', skipped }, 409)
  }

  // Convertir <script> → <script type="module"> (necesario para el await de
  // arriba) — solo si no lo era ya. Se hace DESPUÉS de los reemplazos de
  // arriba para no invalidar sus offsets (el <script> tag está antes de
  // cualquier declStart, así que cambiar sus atributos no mueve nada de lo
  // ya reemplazado, pero por prolijidad se hace al final igual).
  const script = findSingleInlineScript(html) // sobre el html YA modificado
  if (script && !/\btype\s*=\s*["']module["']/i.test(script.attrs)) {
    const newOpenTag = script.fullMatch.slice(0, '<script'.length + script.attrs.length) + ' type="module">'
    // reconstrucción simple: reemplazar solo el tag de apertura, no todo el bloque.
    html = html.slice(0, script.start) + `<script${script.attrs} type="module">` + html.slice(script.start + '<script'.length + script.attrs.length + 1, undefined)
    // (ajustar índices exactos al implementar — mismo cuidado de posiciones que arriba)
  }

  // Guardar como nueva versión — mismo patrón que postPushHtml (uploads.js),
  // pero escribiendo directo a R2 (acá el que escribe es el Worker, no el
  // browser, así que no hace falta el baile de presigned-URL).
  const nextVersion = (await env.DB.prepare(`SELECT htmlbox_version FROM htmlbox_boxes WHERE id = ?1`).bind(box.id).first()).htmlbox_version + 1
  const r2Key = boxVersionKey(boxRow.tenant_slug, box.id, nextVersion)
  await env.BUCKET.put(r2Key, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } })
  await recordVersion({
    db: env.DB, boxId: box.id, version: nextVersion,
    source: 'agent', agentName: 'ai-schema-apply', summary: `Aplicado análisis IA: ${applied.map(a => a.slug).join(', ')}`, userId: user.id,
  })
  await env.DB.prepare(`UPDATE htmlbox_boxes SET htmlbox_version = ?1, updated_at = datetime('now') WHERE id = ?2`).bind(nextVersion, box.id).run()
  await purgeIfOverLimit({ db: env.DB, bucket: env.BUCKET, tenantSlug: boxRow.tenant_slug, boxId: box.id })

  await env.DB.prepare(`UPDATE htmlbox_ai_analyses SET applied = 1 WHERE id = ?1`).bind(analysisIdStr).run()

  return json({ ok: true, id: analysisIdStr, applied: 1, tables: applied, skipped, newVersion: nextVersion })
}
```

**Punto de seguridad, para que quede explícito:** en ningún paso de este flujo se ejecuta código del tenant (`eval`, `new Function`, `vm`, nada). El único parser que toca el JS del tenant es `JSON.parse()` sobre el texto exacto de un array literal — si ese texto no es JSON válido, el candidato simplemente no existe para el sistema. Es la misma garantía de seguridad que ya tiene el resto de HTMLBox (nunca correr código de un tenant del lado del servidor).

## 5. Cambios en el portal

En el modal de análisis IA (`modal-ai-schema.html.txt`, ya existente): las tablas con `source_var` no nulo muestran un badge distinto ("se puede aplicar automáticamente — N filas detectadas") vs las que no ("solo propuesta de schema — no hay datos que migrar"). El botón "Aplicar" pasa a mandar también el HTML actual del editor (`this.editorHtml`) en el body del POST, y tras un `applied: true` exitoso, el portal debe recargar el HTML del box desde la nueva versión (`newVersion` en la respuesta) — el `editorHtml` local queda desactualizado apenas se aplica, porque el HTML cambió del lado del servidor.

## 6. Qué queda fuera de esta spec (no bloqueante)

- **Boxes con 2+ `<script>` inline** — "Aplicar" no está disponible, mismo límite que `editor-split-view.md`. Si se resuelve ese límite ahí, se hereda acá automáticamente (el extractor ya depende de `findSingleInlineScript`).
- **Arrays que no son JSON-válido** (comillas simples, trailing commas, valores calculados como `new Date()` dentro del literal) — no se detectan como candidatos. Podría ampliarse con un parser JSON5 en vez de `JSON.parse` estricto, pero eso agrega una dependencia nueva — evaluar solo si en la práctica muchos análisis reales quedan sin candidatos por esto.
- **Actualizar los datos después de aplicados** — una vez aplicado, los datos viven en la Turso del box y se editan por la tab "Datos" normal (ya existente) — no hay un "volver a sincronizar desde el HTML" porque, justamente, el HTML ya no tiene los datos embebidos después de aplicar.
- **Fetch externos en vez de arrays literales** (`fetch('https://mi-api.com/productos')`) — quedan totalmente fuera, la IA los marca como `source_var: null` y no hay nada que migrar (esos datos nunca estuvieron "en el HTML" para empezar).
- **Deshacer un "Aplicar"** — como crea una versión nueva normal, el rollback ya existente (`POST /api/boxes/:id/rollback/:version`) sirve para volver atrás si algo salió mal — no hace falta un "deshacer" especial.

## 7. Checklist de implementación

1. Crear `packages/control-plane/src/lib/dataExtractor.js` con `findSingleInlineScript()`/`extractArrayCandidates()` (§2), con posiciones exactas vía `match.indices` (mismo cuidado que `editor-split-view.md` §2).
2. Extender `aiProvider.js`: `buildPrompt()` recibe `candidates`, `SYSTEM_PROMPT` agrega `source_var` al shape esperado, `validateProposal()` valida `source_var` contra la lista real de candidatos (§3).
3. Extender `analyzeHtmlRoute()` (`routes/ai.js`) para correr `extractArrayCandidates()` sobre el HTML ANTES de llamar a `analyzeHtml()`, y pasarle los candidatos.
4. Reescribir `applyAnalysis()` (§4) — crear tablas + insertar todas las filas + reescribir el HTML + guardar nueva versión.
5. Actualizar `modal-ai-schema.html.txt` + su lógica en `app-script.html.txt` del portal para mandar el HTML actual al aplicar y recargar tras éxito (§5).
6. Probar el caso feliz: HTML con un `<script>` y un array `const productos = [...]` con 50 filas — analizar, aplicar, confirmar: (a) la tabla existe en la Turso del box vía `GET /api/data/{boxId}/tables/productos/rows` con las 50 filas completas, no solo las de muestra, (b) el HTML de la nueva versión tiene `<script type="module">` y la línea reemplazada por el `await`, (c) el resto del script (todo lo que usaba `productos` más abajo) sigue funcionando igual al cargar el box en el navegador.
7. Probar el caso de HTML editado entre análisis y apply: analizar, editar el box (cambiar el nombre de la variable o borrar el array), intentar aplicar — confirmar que esa tabla queda en `skipped` con `reason: 'candidate_no_longer_present'` y no rompe nada.
8. Probar 2 scripts inline: confirmar que ni el análisis ni el apply proponen `source_var` (el extractor no corre — `findSingleInlineScript` devuelve null).
9. Probar un array con comillas simples o trailing comma: confirmar que no aparece como candidato (no truena, simplemente no se detecta).
