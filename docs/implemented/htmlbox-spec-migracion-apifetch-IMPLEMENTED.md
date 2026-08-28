# HTMLBox — Spec: migrar los `fetch()` existentes a `apiFetch()`

Repo: `htmlbox` (`packages/portal`, `packages/control-plane`). Este spec es continuación directa del trabajo de robustez de Alpine ya implementado (`apiFetch()`, `debugLog()`, captura global de errores, `/api/client-error` — ver `src/ui-partials/app-script.html.txt` en ambos paquetes, líneas 1-95 del `<script>`).

**Por qué existe este doc**: cuando se agregó `apiFetch()` se dejó explícitamente sin tocar el código existente — son ~27 sitios de llamada repartidos en `portalApp()`, `dataTab()` (portal) y `adminApp()` (control-plane), cada uno con su propio manejo de errores ad-hoc, y migrarlos a ciegas sin poder correr un servidor de prueba en vivo era más riesgo que beneficio en ese momento. Este spec es la guía exacta para hacerlo bien, en tandas verificables.

## 0. Qué es `apiFetch()` (recordatorio)

Ya vive en el bloque "Core" al inicio del `<script>` de `app-script.html.txt` en ambos paquetes:

```js
async function apiFetch(path, opts = {}) {
  const { body, headers, ...rest } = opts
  const init = {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    ...rest,
  }
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)

  let res
  try {
    res = await fetch(path, init)
  } catch (err) {
    const netErr = new Error('Sin conexión con el servidor.')
    netErr.cause = err
    throw netErr
  }

  const rayId = res.headers.get('cf-ray') || null
  let data = null
  try { data = await res.json() } catch { /* respuesta no era JSON */ }

  if (!res.ok) {
    const err = new Error((data && (data.error || data.message)) || `Error ${res.status}`)
    err.status = res.status
    err.code = data && data.error
    err.rayId = rayId
    throw err
  }

  return data
}
```

Puntos clave para migrar correctamente:

- **Devuelve el JSON ya parseado**, no un `Response`. Todo `const data = await res.json()` que exista después de la llamada actual **se elimina** — `apiFetch()` ya te da `data` directo.
- **Lanza excepción en cualquier status no-2xx** (con `.message`, `.status`, `.code`, `.rayId`). Todo `if (!res.ok) throw new Error(...)` manual que exista **se elimina** — ya no hace falta, `apiFetch()` ya lanzó.
- Siempre manda `credentials: 'include'` y `Content-Type: application/json` por default — no hace falta repetirlos en cada llamada.
- `path` puede ser relativo (`/api/boxes`) o absoluto (`${RUNTIME}/api/data/...`) — a `fetch()` nativo le da igual, así que sirve para los dos casos que hay en el código (control-plane siempre relativo, portal mezcla relativo y absoluto vía la variable `RUNTIME`).

## 1. Patrón de migración — ejemplos reales, antes/después

### 1.1 Caso simple sin body (control-plane, `loadMe`)

Antes (`packages/control-plane/src/ui-partials/app-script.html.txt`):

```js
async loadMe() {
  const res = await fetch('/api/auth/me', { credentials: 'include' })
  const data = await res.json()
  this.user = data.user
  if (this.user) await this.loadTenants()
},
```

Después:

```js
async loadMe() {
  try {
    const data = await apiFetch('/api/auth/me')
    this.user = data.user
    if (this.user) await this.loadTenants()
  } catch (err) {
    debugLog('loadMe:', err)
  }
},
```

Nota: el original ni siquiera tenía `try/catch` — si `/api/auth/me` fallaba (red caída, 500), la excepción quedaba sin manejar y el catcher global (`window.addEventListener('unhandledrejection', ...)`) la agarraba igual, pero sin contexto útil. Envolver explícitamente con `try/catch` + `debugLog()` es parte del valor de esta migración, no solo el cambio de `fetch` a `apiFetch`.

### 1.2 Caso con body + mensaje de error al usuario (`requestMagicLink`, portal y control-plane)

Antes (portal, usa el helper local `this.api()`):

```js
async requestMagicLink() {
  this.busy = true
  this.lastMessage = ''
  this.previewLink = null
  this.showDevPreview = false
  try {
    const res = await this.api('/api/auth/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: this.email }),
    })
    const data = await res.json()
    this.lastMessage = data.message || 'Listo. Revisá tu email.'
    if (data._dev_preview) {
      this.previewLink = data._dev_preview
      this.showDevPreview = true
      this.showToast('Link generado. Tocá Entrar para autenticarte.')
    }
  } catch (err) {
    this.lastMessage = 'Error: ' + err.message
  } finally {
    this.busy = false
  }
},
```

Después:

```js
async requestMagicLink() {
  this.busy = true
  this.lastMessage = ''
  this.previewLink = null
  this.showDevPreview = false
  try {
    const data = await apiFetch('/api/auth/request', {
      method: 'POST',
      body: { email: this.email },
    })
    this.lastMessage = data.message || 'Listo. Revisá tu email.'
    if (data._dev_preview) {
      this.previewLink = data._dev_preview
      this.showDevPreview = true
      this.showToast('Link generado. Tocá Entrar para autenticarte.')
    }
  } catch (err) {
    this.lastMessage = 'Error: ' + err.message
  } finally {
    this.busy = false
  }
},
```

Cambios: `this.api(path, {headers, body: JSON.stringify(...)})` → `apiFetch(path, {body: {...}})` (ya no hace falta `JSON.stringify` ni el header `Content-Type` — `apiFetch` los pone). El `try/catch` que ya existía se mantiene igual, solo cambia qué se llama adentro.

### 1.3 Caso con `if (!res.ok) throw new Error(...)` manual (`createBox` / `createTenant`)

Antes (portal, `createBox`):

```js
async createBox() {
  ...
  this.creating = true
  try {
    const res = await this.api('/api/boxes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: this.newBox.name,
        template: this.newBox.template,
        visibility: this.newBox.visibility,
        workspace_id: this.currentWorkspaceId,
      }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'falló')
    await this.loadBoxes()
    ...
    this.showToast(`Box "${data.box.name}" creado (v${data.box.htmlbox_version}).`)
  } catch (err) {
    this.showToast('Error: ' + err.message)
  } finally {
    this.creating = false
  }
},
```

Después:

```js
async createBox() {
  ...
  this.creating = true
  try {
    const data = await apiFetch('/api/boxes', {
      method: 'POST',
      body: {
        name: this.newBox.name,
        template: this.newBox.template,
        visibility: this.newBox.visibility,
        workspace_id: this.currentWorkspaceId,
      },
    })
    await this.loadBoxes()
    ...
    this.showToast(`Box "${data.box.name}" creado (v${data.box.htmlbox_version}).`)
  } catch (err) {
    this.showToast('Error: ' + err.message)
  } finally {
    this.creating = false
  }
},
```

El `if (!res.ok) throw new Error(data.error || 'falló')` se borra entero — `apiFetch()` ya lanzó esa excepción con `data.error` como mensaje antes de que el código llegue a esa línea.

Control-plane `createTenant()` tiene el mismo patrón pero con `if/else` en vez de `throw` — aplica igual:

```js
// ANTES
async createTenant() {
  const res = await fetch('/api/tenants', { ...body... })
  const data = await res.json()
  if (data.tenant) {
    this.newTenant = { slug: '', name: '' }
    await this.loadTenants()
    this.showToast('Tenant creado.')
  } else {
    this.showToast('Error: ' + (data.error || 'desconocido'))
  }
},

// DESPUÉS
async createTenant() {
  try {
    await apiFetch('/api/tenants', { method: 'POST', body: this.newTenant })
    this.newTenant = { slug: '', name: '' }
    await this.loadTenants()
    this.showToast('Tenant creado.')
  } catch (err) {
    this.showToast('Error: ' + (err.code || err.message))
  }
},
```

Este caso además arregla un bug latente: el original nunca chequeaba `res.ok`, solo `if (data.tenant)` — si el server devolvía un 500 con body no-JSON, `res.json()` tiraba y el error quedaba sin capturar por nada (no había `try/catch` alrededor). Con `apiFetch()` ese caso ya está cubierto por diseño.

## 2. EXCEPCIÓN — no migrar la subida a R2 (presigned URL)

`saveCurrentBox()` en portal tiene un `fetch()` que **no** va a `apiFetch()`:

```js
const putRes = await fetch(urlData.uploadUrl, {
  method: 'PUT',
  headers: { 'Content-Type': 'text/html' },
  body: this.editorHtml,
})
if (!putRes.ok) throw new Error(`PUT R2 falló: ${putRes.status}`)
```

Esto es un `PUT` directo a una URL firmada de R2 (no un endpoint `/api/*` del control-plane): el body es el HTML crudo (no JSON), el `Content-Type` es `text/html` (no `application/json`), y la respuesta de R2 no es JSON — es un 200 vacío o un XML de error de S3. `apiFetch()` está diseñado para la API JSON propia, forzarlo acá rompería la subida (intentaría mandar `Content-Type: application/json` y hacer `res.json()` sobre una respuesta que no lo es). **Dejar este `fetch()` tal cual está.**

Las otras dos llamadas dentro del mismo método (`upload-url` y `html`, antes y después del PUT) sí son endpoints propios del control-plane y sí se migran con el patrón normal.

## 3. Qué hacer con el helper local `api()` de portal

`portalApp()` tiene su propio helper redundante:

```js
async api(path, init = {}) {
  return await fetch(path, { credentials: 'include', ...init })
},
```

Una vez migrados los 11 sitios que lo llaman (ver inventario abajo), **este método se borra entero** de `portalApp()`. Ya no lo usa nadie y `apiFetch()` (global, fuera de `portalApp()`) es su reemplazo directo.

## 4. Inventario completo — todos los sitios a migrar

### `packages/portal/src/ui-partials/app-script.html.txt` — `portalApp()`

Vía `this.api()` (11 sitios — buscar `this.api(` en el archivo):

- `loadMe()` — `GET /api/auth/me`
- `requestMagicLink()` — `POST /api/auth/request`
- `logout()` — `POST /api/auth/logout`
- `enterViaPreview()` — `POST /api/auth/consume`
- `loadTenants()` — `GET /api/me/tenants`
- `onTenantChange()` — `GET /api/tenants/:id/workspaces`
- `loadBoxes()` — `GET /api/boxes?workspace=...`
- `loadActiveHtml()` — `GET /api/boxes/:id/active-html`
- `saveCurrentBox()` — `POST /api/boxes/:id/upload-url` **y** `POST /api/boxes/:id/html` (dos de los tres fetch de este método — el tercero es la excepción del punto 2)
- `createBox()` — `POST /api/boxes`

`fetch()` directos a `${CONTROL_PLANE}` (5 sitios — hoy `CONTROL_PLANE` es `''`, o sea ya son rutas relativas; migrar igual para que pasen por el mismo manejo de errores):

- `aiAnalyze()` — `POST ${CONTROL_PLANE}/api/ai/analyze-html`
- `aiApply()` — `POST ${CONTROL_PLANE}/api/ai/analyses/:id/apply` **y** `POST ${RUNTIME}/api/data/:boxId/tables/bulk-create` (dos fetch en este método, orígenes distintos — migrar los dos)
- `toggleAutoAnalyze()` — `PATCH ${CONTROL_PLANE}/api/boxes/:id`
- `aiLoadHistory()` — `GET ${CONTROL_PLANE}/api/ai/analyses?boxId=...`

### `packages/portal/src/ui-partials/app-script.html.txt` — `dataTab()`

`fetch()` directos a `${RUNTIME}` (5 sitios):

- `loadTables()` — `GET ${RUNTIME}/api/data/:boxId/tables`
- `createTable()` — `POST ${RUNTIME}/api/data/:boxId/tables/:slug/upsert`
- `uploadFile()` — `POST ${RUNTIME}/api/data/:boxId/tables/:slug/upload?strategy=...` (dos fetch dentro del mismo método, por dos estrategias distintas — migrar los dos)
- `previewTable()` — `GET ${RUNTIME}/api/data/:boxId/tables/:slug/rows?limit=10`

### `packages/control-plane/src/ui-partials/app-script.html.txt` — `adminApp()`

Todos directos a rutas relativas (6 sitios):

- `loadMe()` — `GET /api/auth/me`
- `requestMagicLink()` — `POST /api/auth/request`
- `logout()` — `POST /api/auth/logout`
- `loadTenants()` — `GET /api/me/tenants`
- `createTenant()` — `POST /api/tenants`
- `selectTenant()` — `GET /api/tenants/:id/workspaces`

## 5. Orden recomendado (en tandas, probando cada una)

No migrar todo de una — hacerlo en el orden de abajo, y después de cada tanda correr `npm run dev` (o `scripts/dev.sh`) y probar a mano el flujo correspondiente en el navegador antes de seguir con la próxima:

1. **control-plane `adminApp()` completo** (6 sitios) — es el archivo más chico y el flujo más fácil de probar de punta a punta (login → crear tenant → ver workspaces). Buen lugar para validar que el patrón funciona antes de tocar portal.
2. **portal — flujo de auth** (`loadMe`, `requestMagicLink`, `logout`, `enterViaPreview`) — probar login completo con magic link antes de seguir.
3. **portal — boxes** (`loadTenants`, `onTenantChange`, `loadBoxes`, `loadActiveHtml`, `createBox`, `saveCurrentBox` — recordando la excepción del punto 2) — probar crear un box, editarlo, guardarlo.
4. **portal — borrar el helper `api()`** una vez que ningún método lo llame más (grep `this.api(` debe devolver 0 resultados).
5. **portal — AI** (`aiAnalyze`, `aiApply`, `toggleAutoAnalyze`, `aiLoadHistory`) — probar el flujo de análisis con IA.
6. **portal — `dataTab()`** (`loadTables`, `createTable`, `uploadFile`, `previewTable`) — probar la tab de Datos: crear tabla, subir CSV, previsualizar filas.

## 6. Checklist de aceptación

- `grep -n "this\.api(" packages/portal/src/ui-partials/app-script.html.txt` devuelve 0 resultados (el helper viejo ya no existe ni se usa).
- `grep -n "await fetch(" packages/portal/src/ui-partials/app-script.html.txt` devuelve **exactamente 1** resultado: el `PUT` a `urlData.uploadUrl` dentro de `saveCurrentBox()` (la excepción del punto 2). Cualquier otro `fetch(` directo que aparezca es un sitio que quedó sin migrar.
- `grep -n "await fetch(" packages/control-plane/src/ui-partials/app-script.html.txt` devuelve 0 resultados fuera del bloque "Core" (líneas 1-95 del script, que son `apiFetch()` y `reportClientError()` — esos sí usan `fetch()` nativo a propósito, son la base).
- Cada método migrado probado a mano en el navegador (no solo que compile — que el flujo real funcione: toasts de error con mensajes con sentido, no genéricos tipo `[object Object]`).
- `node --check` sobre el JS extraído del `<script>` de ambos `app-script.html.txt` sigue pasando limpio después de cada tanda.
