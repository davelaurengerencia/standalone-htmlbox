# HTMLBox — Spec: adoptar Workers for Platforms (WFP) desde ya

Decisión explícita de David: adoptar WFP ahora, no cuando aparezca la primera necesidad real de código server-side por box. Nota honesta antes de entrar al diseño (para que la decisión quede con los ojos abiertos, no para reabrir el debate): hoy el aislamiento que importa — datos — ya está resuelto por Turso-per-box; lo que WFP agrega es aislamiento de *código* por box, que hoy nadie usa todavía (todos los boxes corren exactamente la misma lógica de `runtime`). El costo real de adoptarlo ahora: WFP es un add-on de pago en Cloudflare (cuota de scripts + requests), y el pipeline de publicación pasa de "un `PUT` a R2" a "un `PUT` a R2 + un deploy de Worker script" por cada versión publicada. A cambio, se evita una migración más grande el día que sí haga falta código por box (el trayecto que ya venía insinuando la feature de IA/`aiApply`).

## 1. Qué es hoy, qué cambia

**Hoy** (`packages/runtime/src/worker.js`): un único Worker (`htmlbox-runtime`) atiende TODOS los boxes de TODOS los tenants. Por cada request, resuelve el `boxId` (`resolver.js`, cacheado en KV), pide el HTML activo al control-plane (`fetchActiveHtml` → `GET {controlplane}/api/boxes/{boxId}/active-html`, que a su vez lee de R2 vía `readVersion`), y lo sirve con `serveBoxHtml`. La data API (`handleDataApi`, `handleAppDataApi`, etc.) también corre en ese mismo Worker/isolate compartido por todos los boxes.

**Con WFP**: `htmlbox-runtime` deja de servir el contenido directamente y pasa a ser el **Worker dispatcher** — sigue siendo el único que tiene las `routes` reales (`*.sivocloud.dev` / futuro `*.sivocloud.dev`), pero por cada box resuelto, en vez de pedir el HTML a control-plane, invoca al **Worker propio de ese box** (`env.BOX_DISPATCH.get('box-' + boxId)`) y le reenvía el `fetch()`. Cada box pasa a tener su propio script desplegado dentro de un **dispatch namespace** de Cloudflare — aislado en su propio isolate V8, no comparte memoria/CPU con otros boxes.

En v1 el script por-box **no tiene lógica custom todavía** — es un wrapper delgado que hace exactamente lo mismo que hace `serveBoxHtml`/`handleAppDataApi` hoy, solo que corriendo aislado. Es infraestructura, no una feature nueva para el tenant. El día que un box necesite código propio (webhook, transformación previa a servir, integración con terceros), ese script deja de ser el wrapper genérico y pasa a ser generado/editado — sin tocar el dispatcher ni los demás boxes.

## 2. Piezas nuevas de Cloudflare

- **Dispatch namespace**: `wrangler dispatch-namespace create htmlbox-boxes` (uno para todo el ambiente; no uno por tenant — WFP namespaces son a nivel cuenta, los scripts adentro se identifican por nombre).
- **Binding en `runtime/wrangler.jsonc`**:
  ```jsonc
  "dispatch_namespaces": [
    { "binding": "BOX_DISPATCH", "namespace": "htmlbox-boxes" }
  ]
  ```
- **API token nuevo para control-plane** (no lo tiene hoy): permiso `Workers Scripts:Edit` sobre la cuenta, para poder hacer `PUT /accounts/{account_id}/workers/dispatch/namespaces/htmlbox-boxes/scripts/{script_name}` cada vez que se publica una versión. Se guarda como secret nuevo (`WFP_DEPLOY_TOKEN` o similar) en `control-plane` — nunca en `runtime` (runtime solo necesita *leer* del namespace vía el binding, no escribir scripts).
- **Nombre de script por box**: `box-{boxId}`. `boxId` ya se valida hoy contra `/^[a-z0-9]{16}$/` (confirmado en el fix de seguridad de `cookiePathForBox`, hallazgo H2 del anexo) — mismo patrón, reutilizable tal cual como nombre de script sin sanitizar nada nuevo.
- **Tags legibles en el metadata del script** (parte del body del PUT, NO del nombre). Permiten filtrar en el dashboard de Cloudflare sin exponer el `boxId`:
  - `tenant:{tenantSlug}` — slug del tenant dueño del box
  - `box:{boxSlug}` — slug del box dentro del tenant
  - `tenant-id:{tenantId}` — ID interno del tenant (12 chars `[a-z0-9]`)
  - `box-id:{boxId}` — ID interno del box (16 chars `[a-z0-9]`)
  - `visibility:{public|private}` — visibilidad del box
  - `template:{t}` — template con el que se creó el box (`empty`, `custom`, etc.)
  - Validación: max 32 tags, cada uno max 64 chars, charset `[a-zA-Z0-9_:.-]`. Si una tag viola, `deployBoxWorker` lanza error antes de gastar el PUT.
  - Tags stale: si un tenant renombra su slug o un box se le cambia el slug, el script NO se re-deploya automáticamente (los renames son raros). El operador puede re-disparar el deploy vía `POST /api/internal/wfp/migrate-tags` (one-off endpoint, gateado por `HTMLBOX_INTERNAL_SECRET`), que re-PUTea todos los boxes `wfp_status='ready'` con tags frescos.

## 3. El script por-box (v1, genérico)

No es código nuevo de lógica de negocio — es la MISMA lógica que hoy vive en `runtime/src/lib/htmlServer.js` + `appDataApi.js` + `dataApi.js`, empaquetada como su propio Worker. Vía workspace (`@htmlbox/runtime-core` o extraer a `@htmlbox/shared` lo que ya sea compartible), para no duplicar el código entre el dispatcher (que ya no lo necesita para servir HTML, pero sí para las rutas que NO son de un box específico — `/health`, `/_sdk/*`, `/_devtools/*`) y el script por-box.

Lo que recibe cada script por-box al invocarse — WFP pasa `args` en `.get(name, args)`, que llegan como una extensión del `env` del script destino:
```js
// en runtime/src/worker.js (dispatcher), reemplaza el bloque de "Box privado"/"Box público":
const boxWorker = env.BOX_DISPATCH.get(`box-${resolved.boxId}`, {
  boxId: resolved.boxId,
  tenantSlug: resolved.tenantSlug,
  boxSlug: resolved.boxSlug,
  visibility: resolved.visibility,
})
return await boxWorker.fetch(request)
```
El script por-box en sí ya no necesita resolver nada — recibe su propia identidad por `args`, y su HTML activo se lo puede pedir al control-plane igual que hoy (`fetchActiveHtml`), o — mejor, ya que se está tocando esto — leerlo directo de R2 vía un binding `BUCKET` en el propio script desplegado, ahorrando el round-trip a control-plane en cada request. Esto último es una mejora real de latencia que WFP habilita de paso, no una necesidad de la spec.

## 4. Pipeline de publicación (dónde cambia)

Hoy, publicar (en `uploads.js` y en `ai.js#applyAnalysis`) es: `env.BUCKET.put(r2Key, html)` + `recordVersion` + `purgeIfOverLimit`. Con WFP se agrega un paso: después de escribir a R2, hacer el `PUT` del script a `htmlbox-boxes/box-{boxId}` (si no existe, crearlo con el wrapper genérico; si ya existe, no hace falta re-subirlo en cada publish — el wrapper lee el HTML de R2 en cada request, no lo embebe en el script — así que el deploy del script solo ocurre UNA VEZ por box, en su creación, no en cada publicación de una nueva versión de HTML).

Esto es importante: **no acoplar "publicar HTML" con "deployar Worker"**. El script por-box es infraestructura estable (se crea una vez, cuando se crea el box); el HTML es contenido que cambia con cada publish y sigue yendo a R2 exactamente igual que hoy. Evita el costo/latencia de un deploy de Worker en cada guardado.

Nuevo paso en `routes/boxes.js` (creación de box): después de insertar la fila en D1, `PUT` del script genérico a `htmlbox-boxes/box-{boxId}`. Si ese `PUT` falla, el box igual se crea (mismo criterio que ya se usa para el aprovisionamiento de Turso en SIVOCLOUD — "si el aprovisionamiento falla, el proyecto se crea igual, no bloquea") — y `runtime` necesita un fallback: si `env.BOX_DISPATCH.get(...)` no encuentra el script (namespace 404), cae al comportamiento actual (pedirle el HTML a control-plane directo) en vez de romper la request del usuario.

## 5. Fuera de alcance de esta spec

- No se define todavía CÓMO un tenant pediría/subiría código custom para su box (eso es la feature futura que esta spec habilita, no la que implementa).
- No se migra la data API (`handleDataApi`/`handleAppDataApi`/`handleTenantAppAuth`) a scripts por-box en esta pasada — quedan en el dispatcher como hoy. Migrarlas es un paso 2 razonable (mismo patrón), pero no bloquea el objetivo de esta spec (aislar el *serving* de HTML).
- No se resuelve billing/cuotas por-tenant a nivel de CPU de Workers — WFP lo expone (`cpuMs` por script en los logs), pero usarlo para facturar no es parte de esto.
- No se toca nada de la migración de dominio — son independientes, se pueden hacer en cualquier orden.

## 6. Checklist de implementación

1. Confirmar que Workers for Platforms está habilitado en la cuenta de Cloudflare (es un add-on — verificar en el dashboard, Billing → Workers for Platforms, antes de escribir código).
2. Crear el dispatch namespace `htmlbox-boxes` (`wrangler dispatch-namespace create htmlbox-boxes`).
3. Agregar el binding `BOX_DISPATCH` a `packages/runtime/wrangler.jsonc`.
4. Extraer a un paquete compartible (o directamente duplicar por ahora, marcado con TODO) la lógica de `serveBoxHtml`/`appDataApi` que va a vivir en el script por-box genérico.
5. Escribir el script genérico por-box (recibe `args` del dispatcher, lee HTML de R2 directo o vía control-plane, sirve igual que hoy).
6. Generar el token `WFP_DEPLOY_TOKEN` (scope `Workers Scripts:Edit`) y guardarlo como secret en `control-plane`.
7. En `routes/boxes.js` (creación de box): agregar el `PUT` del script genérico al namespace, con fallback no-bloqueante si falla.
8. En `runtime/src/worker.js`: reemplazar el bloque de resolución+serve directo por el `env.BOX_DISPATCH.get(...).fetch(request)`, con fallback al comportamiento actual si el dispatch falla (namespace 404 / script no existe).
9. Migrar (con un script único, corrido una vez) los boxes existentes: crear su script genérico en el namespace para que no queden sirviendo por el path viejo indefinidamente.
10. Probar: crear un box nuevo (confirma auto-creación del script), publicar una versión (confirma que NO dispara un redeploy de Worker, solo `BUCKET.put`), servir el box por los 3 modos de ruteo (`/s/`, `/t/`, subdominio) y confirmar que responde igual que antes de la migración.
