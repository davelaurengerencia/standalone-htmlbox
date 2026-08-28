# HTMLBox — Spec: panel de debug en vivo para los boxes (runtime)

Repo: `htmlbox` (`packages/runtime`, con un cambio chico en `packages/portal`). Este spec es para que el equipo lo implemente al pie de la letra — es la tercera pieza de esta serie, después de `htmlbox-spec-partials-htmlrewriter.md` (partials de plataforma para boxes) y `htmlbox-spec-migracion-apifetch.md` (robustez del portal/admin). Usa el mismo mecanismo de inyección (`HTMLRewriter` en `runtime/src/lib/htmlServer.js`) que ya está documentado en el primero.

**Qué resuelve**: hoy, si el HTML que genera la IA para un box tiene un bug, la única forma de verlo es que el tenant (que casi nunca es programador) abra DevTools del navegador — algo que la mayoría no sabe hacer. Este spec agrega un panel flotante tipo TanStack Query Devtools / Vercel toolbar: un botón en una esquina que despliega una consola con los `console.log/warn/error` del box y las excepciones no capturadas, sin salir de la página.

## 1. A quién se le muestra — la decisión de diseño más importante

El panel **nunca** se muestra a un visitante público ni a un `viewer`, sin importar si el box es público o privado. Solo se muestra cuando se cumplen las dos condiciones a la vez:

1. La URL trae `?hbx_debug=1`.
2. La sesión que llega (cookie `sid`) pertenece a alguien con rol `owner` o `editor` sobre ESE box específico (o es platform owner).

Las dos son necesarias — el query param solo evita que aparezca por accidente cuando el owner visita su propio box normalmente (por ejemplo, mostrándoselo a un cliente en una demo compartiendo pantalla); el chequeo de rol es la que de verdad protege: **el gate real es server-side**, nunca "el botón está oculto por CSS" — alguien sin sesión de owner/editor que le agregue `?hbx_debug=1` a mano a la URL no consigue nada, porque el runtime nunca inyecta el script del panel para esa request.

Importante: el panel corre 100% en el navegador y **nunca manda nada a ningún servidor** — a diferencia del `reportClientError()` que armamos para portal/control-plane (que sí reporta al control-plane), acá NO se reporta nada por red. Razón: el HTML de un box puede tener `console.log()` con datos reales del negocio del tenant (nombres de clientes, montos, lo que sea) — jamás debe salir de la sesión del navegador de quien lo está viendo.

## 2. Infraestructura que ya existe y se reusa

`runtime/src/lib/dataApi.js` ya tiene exactamente el chequeo de rol que hace falta — `controlPlaneHeaders()`, `readSession()` y `checkMembership()`. Hoy están definidos como funciones privadas dentro de `dataApi.js`; este spec pide extraerlas a un módulo compartido nuevo, `runtime/src/lib/auth.js`, para no duplicar la lógica:

```js
// runtime/src/lib/auth.js — extraído de dataApi.js, sin cambios de comportamiento.

export function controlPlaneHeaders(env, request) {
  const headers = new Headers()
  const cookie = request.headers.get('Cookie')
  if (cookie) headers.set('Cookie', cookie)
  if (env.HTMLBOX_INTERNAL_SECRET) {
    headers.set('X-HTMLBox-Internal-Secret', env.HTMLBOX_INTERNAL_SECRET)
  }
  return headers
}

// Lee la sesión desde cookie de control-plane. Devuelve { userId, tenantId, isPlatformOwner, role } o null.
export async function readSession(env, request) {
  const origin = env.HTMLBOX_CONTROL_PLANE_ORIGIN
  if (!origin) return null
  const headers = controlPlaneHeaders(env, request)
  const res = await fetch(`${origin}/api/internal/whoami`, { headers })
  if (!res.ok) return null
  return await res.json()
}

// Devuelve { ok, role: 'owner'|'editor'|'viewer'|null, error? }.
export async function checkMembership(env, request, boxId) {
  const sess = await readSession(env, request)
  if (!sess) return { ok: false, error: 'unauthenticated' }
  if (sess.isPlatformOwner) return { ok: true, role: 'owner', userId: sess.userId }

  const origin = env.HTMLBOX_CONTROL_PLANE_ORIGIN
  const headers = controlPlaneHeaders(env, request)
  const res = await fetch(`${origin}/api/internal/boxes/${encodeURIComponent(boxId)}/membership`, { headers })
  if (!res.ok) return { ok: false, error: 'forbidden' }
  const data = await res.json()
  if (!data.membership) return { ok: false, error: 'forbidden' }
  return { ok: true, role: data.membership.role, userId: sess.userId }
}
```

Después de extraerlo, `dataApi.js` importa estas tres funciones desde `./auth.js` en vez de tenerlas duplicadas — actualizar los imports ahí, sin tocar el resto de su lógica.

Con eso, la función de gating para el panel es chica:

```js
// runtime/src/lib/debugPanel.js

import { checkMembership } from './auth.js'

const EDITOR_ROLES = new Set(['owner', 'editor'])

// Devuelve true solo si la URL pide el panel Y la sesión tiene rol owner/editor
// sobre ESE box. Nunca confiar en el query param solo — siempre revalidar rol.
export async function shouldShowDebugPanel(env, request, url, boxId) {
  if (url.searchParams.get('hbx_debug') !== '1') return false
  const membership = await checkMembership(env, request, boxId)
  return membership.ok && EDITOR_ROLES.has(membership.role)
}
```

## 3. Inyección en `htmlServer.js`

Esto se integra en el mismo `HTMLRewriter` que ya usa `serveBoxHtml()` (ver `htmlbox-spec-partials-htmlrewriter.md` sección 4 — si esa migración a `HTMLRewriter` todavía no está hecha, este spec la asume como prerequisito, o se puede aplicar el mismo patrón directo sobre el `injectSdk()` actual si todavía es regex-based).

```js
// htmlServer.js

import { shouldShowDebugPanel } from './debugPanel.js'

class DebugPanelInjector {
  constructor(boxId, tenantSlug, boxSlug) {
    this.boxId = boxId
    this.tenantSlug = tenantSlug
    this.boxSlug = boxSlug
  }
  element(el) {
    const ctx = JSON.stringify({ boxId: this.boxId, tenantSlug: this.tenantSlug, boxSlug: this.boxSlug })
    // Contexto como variable global (mismo patrón que el spec de partials —
    // nunca interpolar texto dentro del script externo, mantenerlo estático
    // y cacheable).
    const tag = `<script>window.__HBX_DEBUG_CTX__=${ctx};</script><script src="/_devtools/debug-panel.js"></script>`
    el.append(tag, { html: true })
  }
}

export async function serveBoxHtml({ boxId, version, html, visibility, env, request, url, tenantSlug, boxSlug }) {
  if (!html || !version) {
    return new Response('Box sin versión publicada todavía.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  const showDebug = await shouldShowDebugPanel(env, request, url, boxId)

  const baseResponse = new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  let rewriter = new HTMLRewriter()
    .on('body', new SdkAndAlpineInjector(boxId, visibility))
  if (showDebug) {
    rewriter = rewriter.on('body', new DebugPanelInjector(boxId, tenantSlug, boxSlug))
  }

  const headers = new Headers(securityHeaders(visibility))
  headers.set('Content-Type', 'text/html; charset=utf-8')
  headers.set('X-HTMLBox-Version', String(version))
  const rewritten = rewriter.transform(baseResponse)
  return new Response(rewritten.body, { status: 200, headers })
}
```

Notas para quien implemente:

- `shouldShowDebugPanel()` hace un fetch al control-plane (`checkMembership`) — agrega latencia solo cuando `?hbx_debug=1` está presente (la gran mayoría de requests normales de boxes no lo tienen, así que no afecta el path caliente).
- `serveBoxHtml()` ahora necesita `url`, `tenantSlug`, `boxSlug` además de lo que ya recibía (`env`, `request` ya se agregaron en el spec de partials) — actualizar los 2 call-sites en `worker.js` para pasarlos (ya se resuelven ahí mismo vía `resolveByShareId`/`resolveByTenantAndSlug`, que devuelven `tenantSlug`/`boxSlug` en su resultado).
- Se registran DOS handlers `.on('body', ...)` — HTMLRewriter permite múltiples handlers sobre el mismo selector, corren en el orden en que se registran.

## 4. Nueva ruta — servir el script del panel

En `runtime/src/worker.js`, mismo patrón que `/_sdk/htmlbox.js`:

```js
import DEBUG_PANEL_SOURCE from './devtools/debug-panel.js.txt' // bundled as Text por wrangler rules

// ...dentro de fetch(request, env, ctx):
if (path === '/_devtools/debug-panel.js') {
  return new Response(DEBUG_PANEL_SOURCE, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  })
}
```

Y agregar el glob a `runtime/wrangler.jsonc` → `rules` (ya existe la regla `Text` para `src/sdk/*.txt`, extenderla):

```json
"rules": [
  { "type": "Text", "globs": ["src/sdk/*.txt", "src/devtools/*.txt"], "fallthrough": true }
],
```

## 5. El script del panel — `runtime/src/devtools/debug-panel.js.txt`

Vanilla JS, sin dependencias, con Shadow DOM para que el CSS del box (que puede traer un reset global, Tailwind con clases agresivas, lo que sea) nunca le pise el estilo al panel, y viceversa — el panel nunca debe alterar visualmente el box.

```js
;(function () {
  const ctx = window.__HBX_DEBUG_CTX__ || {}
  const MAX_ENTRIES = 200
  const entries = []

  const host = document.createElement('div')
  host.id = 'hbx-debug-root'
  host.style.cssText = 'position:fixed;bottom:0;right:0;z-index:2147483647;'
  document.body.appendChild(host)
  const root = host.attachShadow({ mode: 'open' })

  root.innerHTML = `
    <style>
      .btn { position:fixed; bottom:16px; right:16px; width:44px; height:44px;
        border-radius:9999px; background:#1e293b; color:#fff; border:2px solid #475569;
        font:600 13px system-ui; cursor:pointer; box-shadow:0 4px 12px rgba(0,0,0,.3); }
      .panel { display:none; position:fixed; bottom:70px; right:16px; width:420px; max-height:50vh;
        background:#0f172a; color:#e2e8f0; border:1px solid #334155; border-radius:12px;
        font:12px/1.4 ui-monospace,monospace; overflow:hidden; flex-direction:column;
        box-shadow:0 8px 24px rgba(0,0,0,.4); }
      .panel.open { display:flex; }
      .head { display:flex; justify-content:space-between; align-items:center; padding:8px 12px;
        background:#1e293b; border-bottom:1px solid #334155; font-family:system-ui; }
      .log { flex:1; overflow-y:auto; padding:6px; }
      .entry { padding:4px 6px; border-bottom:1px solid #1e293b; white-space:pre-wrap; word-break:break-word; }
      .entry.error { color:#fca5a5; } .entry.warn { color:#fcd34d; } .entry.info { color:#93c5fd; }
      button.small { background:none; border:none; color:#94a3b8; cursor:pointer; font:12px system-ui; }
    </style>
    <button class="btn" title="HTMLBox Debug">🐞</button>
    <div class="panel">
      <div class="head">
        <span>Debug — ${ctx.boxSlug || ctx.boxId || 'box'}</span>
        <div><button class="small" id="hbx-clear">limpiar</button> <button class="small" id="hbx-close">✕</button></div>
      </div>
      <div class="log"></div>
    </div>
  `

  const btn = root.querySelector('.btn')
  const panel = root.querySelector('.panel')
  const logEl = root.querySelector('.log')
  btn.addEventListener('click', () => panel.classList.toggle('open'))
  root.querySelector('#hbx-close').addEventListener('click', () => panel.classList.remove('open'))
  root.querySelector('#hbx-clear').addEventListener('click', () => { entries.length = 0; render() })

  function render() {
    logEl.innerHTML = entries
      .map((e) => `<div class="entry ${e.level}">[${e.time}] ${escapeHtml(e.text)}</div>`)
      .join('')
    logEl.scrollTop = logEl.scrollHeight
  }

  function escapeHtml(s) {
    return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  }

  function push(level, args) {
    const text = args.map((a) => {
      if (a instanceof Error) return a.stack || a.message
      if (typeof a === 'object') { try { return JSON.stringify(a) } catch { return String(a) } }
      return String(a)
    }).join(' ')
    entries.push({ level, text, time: new Date().toLocaleTimeString() })
    if (entries.length > MAX_ENTRIES) entries.shift()
    render()
  }

  // Envuelve console.* — SIEMPRE llama al original primero (nunca romper el
  // comportamiento normal del box ni ocultarle nada a quien sí tenga DevTools
  // abierto).
  ;['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
    const original = console[level]
    console[level] = function (...args) {
      original.apply(console, args)
      push(level === 'log' ? 'info' : level, args)
    }
  })

  window.addEventListener('error', (e) => {
    push('error', [e.error || e.message])
  })
  window.addEventListener('unhandledrejection', (e) => {
    push('error', ['Promise rechazada: ', e.reason])
  })

  // API mínima por si el propio HTML del box quiere abrir el panel a propósito
  // (ej. un botón "Reportar bug" que el usuario final de la app le agregue).
  window.HBX_DEBUG = { open: () => panel.classList.add('open'), entries }
})()
```

## 6. Cambio en portal — el botón que agrega `?hbx_debug=1`

En `packages/portal/src/ui-partials/main-panel.html.txt`, el botón "Probar Enlace" (o el que abra el box en una pestaña nueva) debe agregar el query param cuando el que mira el box es el owner/editor actual — ya está en esa sesión, así que no hace falta pedirle nada, solo construir la URL distinto. Buscar en `portalApp()` dónde se arma la URL de "abrir box" (algo tipo `window.open(shareUrl)` o similar) y agregarle `?hbx_debug=1` (o `&hbx_debug=1` si ya trae query string). Esto es opt-in por diseño — el owner ve el panel cuando entra DESDE el portal a probar su box; si comparte el link público normal con un cliente, ese link no lo trae y el cliente nunca ve el panel (aunque técnicamente sea owner del box, si abre el link "pelado" sin el query param, no lo ve — coherente con no sorprenderlo en una demo compartida).

## 7. Seguridad — resumen de las reglas que no se negocian

- El gate es 100% server-side (`checkMembership()` en cada request que trae `?hbx_debug=1`) — nunca ocultar el botón solo con CSS/JS del lado cliente.
- El panel nunca manda nada por red — todo vive en memoria del propio navegador, se pierde al recargar la página (aceptable para v1, ver sección 8).
- El CSP actual de `securityHeaders()` en `htmlServer.js` (`script-src 'self' 'unsafe-inline' 'unsafe-eval' ...`) ya permite este script sin cambios — es same-origin, no hace falta whitelistear nada nuevo.
- El wrap de `console.*` siempre llama al método original primero — el panel es aditivo, nunca reemplaza ni oculta el comportamiento normal de la consola del navegador.

## 8. Qué queda fuera de v1 (anotado, no bloqueante)

- **Log de requests de red** (fetch/XHR) — útil pero es una segunda fase; v1 es solo console + errores.
- **Persistencia entre reloads** (ej. `sessionStorage`) — hoy se pierde el historial al recargar la página del box.
- **Link para compartir una sesión de debug** con un compañero de equipo — implicaría si mandar datos a algún lado, lo cual choca con la regla de "nunca sale del navegador" del punto 1; si se pide en el futuro, hay que revisar esa regla explícitamente con el dueño del producto antes de construirlo.
- **Cookie de opt-out permanente** para que un owner que nunca lo use no tenga ni la latencia del `checkMembership()` extra — hoy siempre se revalida en cada request con `?hbx_debug=1`, que es la mayoría casi nunca.

## 9. Checklist de implementación

1. `runtime`: extraer `controlPlaneHeaders()`/`readSession()`/`checkMembership()` de `dataApi.js` a `lib/auth.js`, actualizar `dataApi.js` para importarlas de ahí (sin cambiar su comportamiento).
2. `runtime`: nuevo `lib/debugPanel.js` (`shouldShowDebugPanel()`).
3. `runtime`: nuevo `devtools/debug-panel.js.txt` con el script de arriba.
4. `runtime`: regla `Text` en `wrangler.jsonc` para `src/devtools/*.txt`.
5. `runtime`: nueva ruta `GET /_devtools/debug-panel.js` en `worker.js`.
6. `runtime`: actualizar `htmlServer.js` (`serveBoxHtml()` con el segundo handler condicional) y los 2 call-sites en `worker.js` para pasar `url`, `tenantSlug`, `boxSlug`.
7. `portal`: agregar `?hbx_debug=1` a la URL que arma el botón de "probar/abrir box" cuando el usuario actual es owner/editor.
8. Probar en local: crear un box de prueba, entrar como owner desde el portal, confirmar que el botón 🐞 aparece y muestra `console.log`/errores del box. Después, abrir el mismo box en una pestaña de incógnito (sin sesión) con `?hbx_debug=1` a mano en la URL, y confirmar que el panel **no** aparece — esa es la prueba de que el gate server-side funciona de verdad.
