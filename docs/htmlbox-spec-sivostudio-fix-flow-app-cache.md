# Fix: cachear el flow-engine app en `box-template/worker.js` (sivostudio)

## 0. Qué encontramos

Revisando el código actual de `packages/sivostudio/box-template/worker.js`,
tanto la zona `editor-backend` como la zona `api` hacen, en **cada
request**, sin excepción:

1. `loadStoredFlows(env, boxId)` — un `GET` a R2
   (`box-template/lib/handlers.js:189-197`).
2. `createFlowEngineApp({...})` completo desde cero — reconstruyendo todos
   los nodos y el wiring del flow.

Esto pasa en las dos zonas de forma independiente (código duplicado, cada
una hace su propio `loadStoredFlows` + `createFlowEngineApp`).

## 1. Por qué es un problema

- **Latencia extra en cada request real.** Cualquier hit a `/api/*` (el
  backend público del box, el que sirve tráfico de verdad) paga primero
  una lectura de R2 y luego el costo de reconstruir toda la app de
  flow-engine, antes de procesar el mensaje. Eso es overhead en el
  camino caliente, no solo en un "arranque" ocasional.
- **Se pierde el estado en memoria de flow-engine.** `ctx.flow` y
  `ctx.global` están documentados (AGENTS.md de flow-engine) como estado
  que debe persistir EN MEMORIA entre requests dentro del mismo isolate.
  Si se crea una instancia nueva de la app en cada request, ese estado se
  resetea siempre — cualquier flow que dependa de memoria compartida
  entre llamadas simplemente no va a funcionar como se espera, y va a ser
  difícil de diagnosticar si no se sabe de antemano que la causa es esta.

## 2. La corrección

Cachear a nivel de módulo (fuera del handler `fetch`, así sobrevive entre
requests dentro del mismo isolate) tanto el flow cargado como la instancia
de la app construida a partir de él. Estructura sugerida en
`box-template/worker.js`:

```js
// Cache a nivel de módulo — sobrevive entre requests del mismo isolate.
let cachedFlowsEtag = null
let cachedApp = null

async function getFlowApp(env, boxId) {
  // HEAD a R2 es mucho más barato que GET — solo trae metadata (etag),
  // no el body completo. Si no cambió, no releemos ni reconstruimos nada.
  const head = env.STUDIO_R2 ? await env.STUDIO_R2.head(`box-${boxId}/flow.json`) : null
  const currentEtag = head?.etag ?? null

  if (cachedApp && currentEtag === cachedFlowsEtag) {
    return cachedApp
  }

  const flows = await loadStoredFlows(env, boxId)
  cachedApp = await createFlowEngineApp({
    runtime: 'worker',
    flows,
    mountPath: '/editor/backend',
    httpNodeRoot: '/api',
    nodes: coreNodes,
    platformBindings: extractPlatformBindings(env),
  })
  cachedFlowsEtag = currentEtag
  return cachedApp
}
```

Y en los dos call-sites (`editor-backend` y `api`), reemplazar el bloque de
`loadStoredFlows` + `createFlowEngineApp` por `const app = await
getFlowApp(env, boxId)`.

Esto resuelve las dos partes del problema: en el caso normal (el flow no
cambió desde la última request en este isolate), el costo por request baja
a un `R2.head()` (barato) en vez de un `R2.get()` + reconstrucción
completa — y la MISMA instancia de app se reusa entre requests, así que
`ctx.flow`/`ctx.global` sí persisten como se espera mientras el isolate
esté vivo.

## 3. Sobre la "frescura" del cache — qué aceptar en esta fase

Con este fix, un flow recién guardado tarda en verse SOLO si el mismo
isolate sigue vivo con un `cachedFlowsEtag` viejo — pero como el chequeo es
un `R2.head()` en cada request (no un cache "para siempre"), en la
práctica se refleja en la siguiente request a ese isolate, casi
inmediato. No hace falta ninguna invalidación activa más sofisticada
(pub/sub entre isolates, etc.) — sería sobre-ingeniería para esta fase
experimental. Si el equipo prueba esto y el `head()` sigue pareciendo
mucho costo, la alternativa más simple es no invalidar en absoluto y
aceptar que un cambio de flow solo se ve cuando Cloudflare recicla el
isolate (pasa con frecuencia de todas formas) — pero empezar con la
versión del `head()` es la opción correcta por defecto.

## 4. Checklist

- [ ] Extraer `getFlowApp(env, boxId)` a `box-template/worker.js` (o a
      `lib/handlers.js` si prefieren mantener `worker.js` como puro
      orquestador) con cache a nivel de módulo + chequeo de etag vía
      `R2.head()`.
- [ ] Reemplazar los dos call-sites duplicados (`editor-backend`, `api`)
      para usar `getFlowApp()` en vez de reconstruir la app inline.
- [ ] Test: dos requests seguidas al mismo isolate con el mismo flow en
      R2 no deben disparar un segundo `R2.get()` (solo el `head()`) ni una
      segunda llamada a `createFlowEngineApp()` — verificar con un mock
      que cuenta invocaciones.
- [ ] Test: guardar un flow nuevo (cambia el etag en R2) y hacer otra
      request debe SÍ reconstruir la app con el flow actualizado.
- [ ] Test (si es viable con el runtime de test actual): un flow que
      escribe algo en `ctx.global` en una request debe poder leerlo en la
      siguiente request al mismo isolate — confirma que el estado en
      memoria ya no se resetea.
