# HTMLBox — Spec: Partials server-side con HTMLRewriter + Alpine.js

Repo: `htmlbox` (packages `control-plane` / `portal` / `runtime`). Este spec es para que el equipo lo implemente al pie de la letra — igual que `htmlbox-spec-fixes-y-svelte.md` (Parte A de ese doc ya está en producción; este es un módulo nuevo, independiente, no toca Svelte/Alpine del portal).

**Contexto**: hoy `runtime/src/lib/htmlServer.js` inyecta el SDK con un regex sobre el string completo del HTML (`injectSdk()`), y cada box es un blob de HTML autocontenido guardado en R2. No hay forma de que la plataforma inyecte contenido común (nav de tenant, banner de upsell, widget de una app instalada) sin que cada box lo tenga hardcodeado. Este spec agrega **partials**: fragmentos HTML propiedad de la plataforma que el runtime inyecta en tiempo de respuesta (no en tiempo de guardado), usando `HTMLRewriter` — el parser/transformer nativo de Cloudflare Workers, streaming, sin bufferizar el documento completo.

---

## 1. Qué es un partial

Un partial es un fragmento HTML versionado, propiedad de la plataforma (no del tenant, no del box), que un box puede referenciar con un elemento marcador. El runtime lo resuelve y lo inserta al servir el box — el HTML guardado en R2 nunca se modifica.

Casos de uso: nav/footer de marca consistente entre boxes, banner de "actualiza tu plan", widget de una app instalada (ver conversación previa sobre apps instalables/canary), inyección de analytics/telemetría propia sin tocar el HTML del usuario.

### Marcador en el HTML del box

```html
<htmlbox-partial name="tenant-nav"></htmlbox-partial>
```

Se usa un custom element (`<htmlbox-partial>`), no un `<div data-partial>`, por dos razones: (1) `HTMLRewriter` matchea por selector CSS trivialmente contra un tag propio sin colisionar con markup real del usuario; (2) si el partial no se resuelve (plataforma caída, nombre mal escrito), el navegador simplemente no renderiza nada visible para ese tag desconocido — degrada limpio en vez de mostrar un `<div>` vacío con estilos raros.

Atributos soportados:

| Atributo | Obligatorio | Descripción |
|---|---|---|
| `name` | sí | slug del partial, ej. `tenant-nav` |
| `fallback` | no | si el partial falla, deja este texto/HTML inline en vez de vaciar el elemento |

---

## 2. Almacenamiento y versionado

Reusa el patrón de `packages/shared/src/namespacedKey.js` pero a nivel plataforma (no tenant). Agregar a `namespacedKey.js`:

```js
// Key de una versión de partial de plataforma:
//   platform/partials/{slug}/versions/v{N}.html
export function platformPartialKey(slug, version) {
  assertSegment('slug', slug)
  const n = Number(version)
  if (!Number.isInteger(n) || n < 1) throw new Error(`platformPartialKey: version inválida ${version}`)
  return `platform/partials/${slug}/versions/v${n}.html`
}
```

Nueva tabla D1 (control-plane), migración `0005_partials.sql`:

```sql
CREATE TABLE htmlbox_partials (
  id            TEXT PRIMARY KEY,      -- part_xxx
  slug          TEXT NOT NULL UNIQUE,  -- 'tenant-nav'
  name          TEXT NOT NULL,
  description   TEXT,
  current_version INTEGER NOT NULL DEFAULT 0,  -- 0 = sin publicar
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE htmlbox_partial_versions (
  id            TEXT PRIMARY KEY,      -- pv_xxx
  partial_id    TEXT NOT NULL REFERENCES htmlbox_partials(id),
  version       INTEGER NOT NULL,
  r2_key        TEXT NOT NULL,
  summary       TEXT,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(partial_id, version)
);
```

Por qué D1 y no solo R2+KV como los boxes de usuario: los partials los publica el platform owner, cambian con menos frecuencia, y queremos historial/rollback auditable igual que `htmlbox_versions`, sin reinventar el patrón. `current_version` es el puntero que el runtime resuelve — igual rol que `htmlbox_boxes.htmlbox_version` hoy.

Solo `is_platform_owner` puede escribir. Nuevas rutas en `control-plane/src/routes/partials.js` (mismo esqueleto que `boxes.js`, con `assertPlatformOwner()` en vez de `assertWorkspaceScope()`):

- `POST /api/admin/partials` — crear
- `POST /api/admin/partials/:id/upload-url` — firmar upload a R2 (mismo mecanismo que `boxes.js` usa hoy para HTML de boxes)
- `POST /api/admin/partials/:id/html` — confirmar nueva versión, sube `current_version`, purga versiones viejas (reusar `purgeIfOverLimit` de `@htmlbox/shared` con un límite propio, ej. `MAX_PARTIAL_VERSIONS = 10`)
- `GET  /api/internal/partials/:slug` — el runtime la llama para resolver `slug → {r2Key, version}` (protegida con el mismo header `X-HTMLBox-Internal-Secret` que ya existe para `/api/internal/boxes/*`)

---

## 3. Resolución y caché en runtime

Nuevo `runtime/src/lib/partials.js`:

```js
// src/lib/partials.js — resuelve y cachea partials de plataforma.

const KV_TTL_SEC = 300          // igual TTL que box resolver.js
const EDGE_CACHE_TTL_SEC = 60   // Cache API — partials son iguales para TODOS los tenants

function kvKey(slug) {
  return `partial:${slug}`
}

async function fetchPartialMeta(env, slug, request) {
  const origin = env.HTMLBOX_CONTROL_PLANE_ORIGIN
  const headers = new Headers({ 'X-HTMLBox-Internal-Secret': env.HTMLBOX_INTERNAL_SECRET || '' })
  const res = await fetch(`${origin}/api/internal/partials/${encodeURIComponent(slug)}`, { headers })
  if (!res.ok) return null
  const data = await res.json()
  return data.partial || null  // { r2Key, version }
}

// Devuelve el HTML del partial (string) o null si no existe / falla.
export async function resolvePartial(env, slug, request) {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(slug)) return null

  // 1) Cache API del edge — un solo fetch de R2 sirve a todos los colos que
  //    ya lo pidieron, sin ida y vuelta a KV/D1.
  const cacheKeyUrl = new URL(request.url)
  cacheKeyUrl.pathname = `/_internal/partial-cache/${slug}`
  const cacheKey = new Request(cacheKeyUrl.toString())
  const cached = await caches.default.match(cacheKey)
  if (cached) return await cached.text()

  // 2) KV — resuelve slug → {r2Key, version} sin pegarle a D1 en cada hit.
  let meta = null
  if (env.CACHE) {
    const kvHit = await env.CACHE.get(kvKey(slug))
    if (kvHit) { try { meta = JSON.parse(kvHit) } catch { /* ignore */ } }
  }
  if (!meta) {
    meta = await fetchPartialMeta(env, slug, request)
    if (!meta) return null
    if (env.CACHE) await env.CACHE.put(kvKey(slug), JSON.stringify(meta), { expirationTtl: KV_TTL_SEC })
  }

  // 3) R2 — el contenido real.
  const obj = await env.BUCKET.get(meta.r2Key)
  if (!obj) return null
  const html = await obj.text()

  const resp = new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': `public, max-age=${EDGE_CACHE_TTL_SEC}` },
  })
  await caches.default.put(cacheKey, resp.clone())
  return html
}
```

Invalidación: cuando se publica una versión nueva (`POST /api/admin/partials/:id/html`), el control-plane debe purgar la KV del runtime igual que ya hace `invalidateBoxCache()` para boxes (buscar ese helper existente en `boxes.js`/`resolver.js` — mismo patrón, nuevo `invalidatePartialCache(env, slug)` que llama a un endpoint interno del runtime o simplemente deja que el TTL de 300s expire; dado que los partials cambian poco, TTL-only es aceptable para v1, invalidación activa queda como mejora futura).

---

## 4. HTMLRewriter — reemplazo del regex actual

Esto reemplaza `injectSdk()` en `runtime/src/lib/htmlServer.js`. Hoy:

```js
// ANTES — regex sobre el string completo, ya materializado con obj.text()
export function injectSdk(html, boxId, visibility) {
  const tag = `<script src="${SDK_URL}?boxId=${encodeURIComponent(boxId)}&v=${visibility === 'public' ? 'public' : 'private'}"></script>`
  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>/i, `${tag}</body>`)
  }
  return html + '\n' + tag
}
```

Después — un solo `HTMLRewriter` maneja SDK + Alpine + partials, y puede operar directo sobre el stream de R2 sin pasar por `.text()`:

```js
// runtime/src/lib/htmlServer.js — versión con HTMLRewriter

import { resolvePartial } from './partials.js'

class SdkAndAlpineInjector {
  constructor(boxId, visibility) {
    this.boxId = boxId
    this.visibility = visibility
  }
  element(el) {
    // Alpine core primero (defer), luego app.js (registra Alpine.data(...)
    // ANTES de que Alpine se auto-inicie), luego el SDK del box.
    const alpineTag = `<script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3/dist/cdn.min.js"></script>`
    const appJsTag = `<script src="/_sdk/app.js"></script>`
    const sdkTag = `<script src="${SDK_URL}?boxId=${encodeURIComponent(this.boxId)}&v=${this.visibility === 'public' ? 'public' : 'private'}"></script>`
    el.append(appJsTag + sdkTag + alpineTag, { html: true })
  }
}

class PartialInjector {
  constructor(env, request) {
    this.env = env
    this.request = request
  }
  async element(el) {
    const slug = el.getAttribute('name')
    const fallback = el.getAttribute('fallback') || ''
    if (!slug) { el.remove(); return }
    try {
      const html = await resolvePartial(this.env, slug, this.request)
      if (html) {
        el.replace(html, { html: true })
      } else if (fallback) {
        el.replace(fallback, { html: true })
      } else {
        el.remove()
      }
    } catch (err) {
      // Un partial roto NUNCA debe tumbar el box completo.
      console.error(`partial "${slug}" falló:`, err)
      el.replace(fallback, { html: true })
    }
  }
}

export async function serveBoxHtml({ boxId, version, html, visibility, env, request }) {
  if (!html || !version) {
    return new Response('Box sin versión publicada todavía.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  const baseResponse = new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })

  const rewritten = new HTMLRewriter()
    .on('body', new SdkAndAlpineInjector(boxId, visibility))
    .on('htmlbox-partial', new PartialInjector(env, request))
    .transform(baseResponse)

  const headers = new Headers(securityHeaders(visibility))
  headers.set('Content-Type', 'text/html; charset=utf-8')
  headers.set('X-HTMLBox-Version', String(version))
  return new Response(rewritten.body, { status: 200, headers })
}
```

Notas importantes para quien implemente:

- `HTMLRewriter` está disponible nativamente en Workers (y en Miniflare/`wrangler dev --local`, no requiere `--remote` para probarlo).
- El handler `element()` de `PartialInjector` es `async` — HTMLRewriter espera la Promise antes de continuar el stream para ese elemento. Esto es soportado nativamente, no hace falta bufferizar manualmente.
- **Cambio de firma**: `serveBoxHtml()` ahora necesita `env` y `request` (para resolver partials). Actualizar los 2 call-sites en `runtime/src/worker.js` (el de `/s/{shareId}` y el de box privado) para pasarlos.
- Se quita `injectSdk()` como función standalone (o se deja pero sin usar — preferible borrarla para no dejar dos caminos).
- `el.replace(html, {html:true})` reemplaza el elemento completo `<htmlbox-partial>...</htmlbox-partial>` por el HTML del partial. Si el partial trae su propio `<script>`, ese script se ejecuta normal (mismo origin, mismo CSP).

---

## 5. `app.js` — puente Alpine.js compartido

Nuevo archivo `runtime/src/sdk/app.js.txt` (bundleado como texto igual que `htmlbox-sdk.txt` hoy, vía la regla `rules` de `wrangler.jsonc`), servido en `GET /_sdk/app.js`. Su rol: registrar los componentes Alpine que los partials usan, **antes** de que Alpine se autoinicie.

```js
// app.js — registra Alpine.data() para los partials de plataforma.
// Se carga ANTES que el script de Alpine (ver orden en SdkAndAlpineInjector)
// y usa el evento alpine:init, que Alpine dispara justo antes de escanear
// el DOM — así los x-data="hbxNav()" de los partials ya existen cuando
// Alpine los necesita, sin importar el orden real de ejecución del <script>.

document.addEventListener('alpine:init', () => {
  Alpine.data('hbxNav', () => ({
    open: false,
    ctx: window.__HBX_PARTIAL_CTX__ || {},
    toggle() { this.open = !this.open },
  }))

  Alpine.data('hbxUpsellBanner', () => ({
    dismissed: false,
    ctx: window.__HBX_PARTIAL_CTX__ || {},
    dismiss() { this.dismissed = true },
  }))

  // Nuevos partials con Alpine agregan su Alpine.data(...) acá.
})
```

Contexto dinámico (tenant, box, usuario) hacia los partials: el runtime, además del `PartialInjector`, agrega un handler `on('head', ...)` que inyecta:

```html
<script>window.__HBX_PARTIAL_CTX__ = {"tenantSlug":"acme","boxId":"box_xxx","visibility":"private"};</script>
```

Esto va **antes** de `app.js` en el `<head>`, para que `window.__HBX_PARTIAL_CTX__` ya exista cuando los `Alpine.data()` factories corren. Razón de pasar contexto así (variable global) y no interpolando texto dentro del HTML del partial: interpolar strings dentro de HTMLRewriter (`onText`) es mucho más frágil (hay que parsear placeholders dentro de texto que puede llegar partido en chunks) — una variable JS es robusta y ya es el patrón que usa el SDK actual (`?boxId=...` como query param, misma idea).

Ejemplo de partial que consume esto (lo que el platform owner sube como HTML del partial `tenant-nav`):

```html
<nav x-data="hbxNav()" class="flex items-center justify-between p-3 bg-slate-900 text-white">
  <span x-text="ctx.tenantSlug"></span>
  <button @click="toggle()">Menú</button>
</nav>
```

---

## 6. Orden de carga — por qué importa

`SdkAndAlpineInjector` inyecta, en este orden, dentro de `<body>` (al final, vía `el.append` sobre el handler de `body`, que corre cuando HTMLRewriter cierra el tag):

1. `app.js` — registra `Alpine.data(...)` factories, escucha `alpine:init` (no ejecuta nada todavía).
2. `htmlbox-sdk.js` — SDK de datos del box (sin relación con Alpine).
3. Alpine core (`defer`) — al cargar, dispara `alpine:init`, luego escanea el DOM y monta cada `x-data`.

Si Alpine core se cargara *antes* que `app.js`, el evento `alpine:init` se dispararía sin que `Alpine.data('hbxNav', ...)` exista todavía, y cualquier partial con `x-data="hbxNav()"` fallaría con "hbxNav is not a function". El orden de arriba es el correcto y debe respetarse tal cual al implementar — es la parte más fácil de romper por accidente en un refactor futuro.

---

## 7. Seguridad

- Los partials **no** son contenido de usuario/tenant — solo el platform owner los publica (rutas `/api/admin/partials/*` protegidas con el mismo check `is_platform_owner` que ya usan otras rutas admin).
- El HTML de un partial corre en el mismo origin y bajo el mismo CSP que el box — no se relaja `script-src`/`style-src` para partials, usan los mismos CDNs ya whiteliseados en `securityHeaders()`.
- `resolvePartial()` valida el `slug` contra un regex antes de tocar KV/R2 (mismo criterio defensivo que `resolver.js` ya aplica a `shareId`/`tenantSlug`).
- Un partial que lanza excepción o no resuelve nunca debe romper el box completo — de ahí el `try/catch` en `PartialInjector.element()` con fallback a `el.remove()`.

---

## 8. Qué falta decidir (no bloqueante para v1, pero dejarlo anotado)

- **Invalidación activa de caché** al publicar una versión nueva de partial (hoy: TTL de 300s en KV + 60s en Cache API — aceptable para v1, pero un platform owner que publique un fix urgente esperaría hasta 5 min a que se propague).
- **Canary/staged rollout de partials** — mismo patrón que se discutió para apps instalables (ej. `current_version` estable vs `canary_version`, runtime elige según % de tenants o header de testing). Queda fuera de este spec; el esquema de `htmlbox_partials`/`htmlbox_partial_versions` ya soporta agregarlo después sin romper nada (agregar columna `canary_version` y una condición en `fetchPartialMeta`).
- **Slots múltiples por posición** (header/footer/sidebar) — v1 solo resuelve por `name`, la posición la decide el propio HTML del box poniendo el `<htmlbox-partial>` donde quiera.

---

## 9. Checklist de implementación

1. `shared`: agregar `platformPartialKey()` a `namespacedKey.js`, y `MAX_PARTIAL_VERSIONS` a `constants.js`.
2. `control-plane`: migración `0005_partials.sql`, `routes/partials.js` (CRUD + upload + publish, protegido por `is_platform_owner`), endpoint interno `GET /api/internal/partials/:slug` (protegido por `X-HTMLBox-Internal-Secret`, igual que `/api/internal/boxes/*`).
3. `runtime`: nuevo `lib/partials.js` (`resolvePartial()`), nuevo `sdk/app.js.txt` + regla en `wrangler.jsonc` para bundlearlo como texto, reescribir `htmlServer.js` (`serveBoxHtml()` con `HTMLRewriter`, quitar `injectSdk()`), actualizar los 2 call-sites en `worker.js` para pasar `env`/`request`.
4. Probar en local con `wrangler dev --local` — `HTMLRewriter` funciona sin `--remote`.
5. Crear un partial de prueba (`tenant-nav`) vía las rutas admin nuevas, y un box de prueba con `<htmlbox-partial name="tenant-nav" fallback="Cargando…"></htmlbox-partial>` para validar el flujo completo end-to-end.
