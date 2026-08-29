# HTMLBox — Spec: Boxes con backend visual (Flow Engine), sin escribir Worker a mano

Responde a lo que planteó David: le gusta Workers for Platforms (un script por box, bindings/secrets reales), pero le parece demasiada fricción pedirle a alguien que escriba un `worker.js` completo solo para tener un backend. La idea: que el usuario piense únicamente en HTML/JS/CSS del lado del cliente, y que el backend salga de un flujo visual armado con `flow-engine` — sin que nadie del lado del box tenga que tocar código de servidor.

**Mi opinión, corta**: se puede, y no hace falta inventar nada nuevo del lado de `flow-engine` — la librería YA corre en modo `'worker'` en producción hoy mismo (control-plane la usa para el envío de magic links), con bindings nativos de D1/KV/R2/Email y un editor visual ya construido (`editor-vanilla/index.html`, cero dependencias, un solo archivo). Lo que hace falta construir es la capa que conecta ESO con Workers for Platforms — generar automáticamente el `worker.js` de cada box en vez de que alguien lo escriba a mano, y reusar el mecanismo de deploy que ya está especificado en `htmlbox-spec-wfp-consolidacion.md`. No es un proyecto aparte — es la pieza que le faltaba a WFP para que un box normal (no un Box Dev técnico) también pueda tener backend real.

## 0. Qué resuelve esto vs. lo que ya existe

Hoy, según `htmlbox-spec-box-devs-preview.md`/`htmlbox-spec-box-devs-zip-upload.md`, un "Box Dev" es alguien técnico que escribe su propio `worker.js` con `fetch()` a mano. Eso sigue siendo válido y necesario para casos de verdad avanzados (una librería npm específica, un Durable Object custom, un protocolo raro). Pero es demasiado para el caso común: "necesito que al enviar este formulario se guarde en una tabla y se mande un email" — eso no debería requerir escribir una línea de JavaScript de servidor.

Esta spec agrega un TERCER camino (no reemplaza a los otros dos):

1. **Box normal** (hoy): HTML/JS estático, sin backend propio — corre bajo `wrapper.mjs` genérico.
2. **Box con backend visual** (nuevo, esta spec): HTML/JS estático + un flujo diseñado visualmente (`flow-engine`) que define el backend — el `worker.js` que lo sirve se **genera automáticamente**, nadie lo escribe.
3. **Box Dev** (ya specced): `worker.js` escrito a mano por alguien técnico, para lo que ningún flujo visual puede cubrir.

Los tres terminan en el MISMO mecanismo de deploy (`deployBoxWorker()`/`redeployBoxWorker()`, WFP) — la única diferencia entre ellos es de dónde sale el `worker.js` que se bundlea.

## 1. Por qué ya se puede — lo que confirma el propio repo de `flow-engine`

Verificado contra `_flow-engine/AGENTS.md` y `_flow-engine/docs/como-crear-un-backend-en-workers.md` (no contra memoria — ambos documentos fueron actualizados hoy mismo, 2026-08-28, a partir de una auditoría del código real):

- `createFlowEngineApp({ runtime: 'worker', flows, configNodes, extraNodes })` + `app.handleWorker(request, env, ctx)` es un patrón YA usado en producción (`htmlbox/packages/control-plane/src/lib/flows.js`, para el envío de magic links vía el nodo `cloudflare-email`).
- El catálogo de nodos que trae la librería (gratis, con tests) ya cubre lo esencial de un backend de box: `http-in`/`http-response` (rutas), `turso`/`tables` (base de datos — `tables` es justo el "mini-spreadsheet self-service" que ya usan otras apps de SivoCloud), `cloudflare-d1`/`cloudflare-kv`/`cloudflare-r2`/`cloudflare-email` (bindings nativos, no API REST), `transform` (JSONata, sin necesidad de sandbox), `switch`/`change`/`delay`/`catch` (control de flujo), y ya hay paquetes verticales (`paddle-*`, `shopify-*`, `dian-*`) que un box podría necesitar según el rubro del tenant.
- El editor visual (`editor-vanilla/index.html`) ya existe, ya sirve su catálogo de nodos vía `GET /_editor/api/nodes` (incluyendo `extraNodes` que registre la app consumidora), y es un solo archivo sin build — se puede embeber en el portal casi tal cual.

Lo que **no** está resuelto por la librería (y por eso esta spec no es "simplemente montarla"):

- En modo `'worker'`, los flujos viven **en memoria**, inyectados al crear la app — NO hay una forma de "cargar el flujo del tenant X en runtime" dentro de un único script compartido. Cada script tiene sus flujos fijos, bundleados al compilar.
- El guardado del editor (`POST /_editor/api/*`) devuelve `501` en modo `'worker'` — la persistencia de flujos vía R2 está marcada como pendiente (`TODO(R2-migration)`) en la propia librería. No podemos depender de esa ruta para guardar flujos de boxes.

Estas dos limitaciones apuntan al mismo diseño: **un script por box (como ya hace WFP hoy), no un script compartido con flujos dinámicos** — y el guardado del flujo lo resuelve HTMLBox con su propia infraestructura (R2/D1, la misma que ya usa para el HTML), no con la del editor de `flow-engine`.

## 2. Arquitectura: `worker.js` autogenerado

Para un box con backend visual, en vez de que alguien escriba `worker.js`, control-plane lo **genera** a partir de una plantilla fija + el `flow.json` del box:

```js
// Generado por HTMLBox al momento del deploy — nadie lo edita a mano.
import { createFlowEngineApp, extractPlatformBindings } from 'flow-engine/app'
import boxFlow from './flow.json' with { type: 'json' }
import { htmlboxNodes } from './htmlbox-nodes.js'  // ver §4 — nodos propios si hacen falta

const FLOWS = { 'box': boxFlow }

let appPromise
async function getApp() {
  appPromise ??= createFlowEngineApp({
    runtime: 'worker',
    flows: FLOWS,
    configNodes: [],           // credenciales del box — ver §4, se resuelven vía secrets reales
    httpNodeRoot: '/api',
    extraNodes: htmlboxNodes,
  })
  return appPromise
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/')) {
      const app = await getApp()
      return app.handleWorker(request, env, ctx)
    }
    // No es /api/* → HTML/JS estático del box (mismo mecanismo que
    // `htmlbox-spec-wfp-consolidacion.md` §4: leer directo de R2).
    return serveStaticBoxAssets(request, env)
  },
}
```

Esto une dos piezas que hasta ahora estaban pensadas por separado: el `wrapper.mjs` genérico (sirve HTML) y `flow-engine` (sirve backend) se combinan en UN SOLO script — el mismo que ya se deploya por box vía WFP. El frontend del box hace `fetch('/api/...')` contra su propio dominio, sin CORS, sin service binding, sin nada especial — es el mismo Worker respondiendo las dos cosas.

**Bundle**: `deployBoxWorker()`/`redeployBoxWorker()` (ya existen, sin cambios en su firma) reciben este `worker.js` generado + el `flow.json` del box como si fuera cualquier bundle — el mecanismo de deploy no necesita saber que el contenido vino de un flujo visual en vez de código escrito a mano.

## 3. Editor visual en el portal

Nueva sección del portal (distinta de "Box Dev Studio", que sigue siendo para código a mano): un tab "Backend" en el editor de un box, que embebe `editor-vanilla/index.html` de `flow-engine` (se puede servir tal cual, es un archivo estático sin build) apuntando su `GET /_editor/api/nodes` a una instancia liviana de `flow-engine` corriendo en modo `'node'` o `'worker'` solo para SERVIR EL CATÁLOGO — nunca para guardar.

El guardado real NO pasa por `POST /_editor/api/*` de `flow-engine` (bloqueado, 501, en modo worker) — pasa por la API propia de HTMLBox: `POST /api/boxes/:id/flow` guarda el `flow.json` en R2 (mismo bucket/mecanismo que ya usa el HTML del box) y dispara `redeployBoxWorker(reason: 'flow_updated')`. Un flujo es código, no contenido — encaja con la misma distinción que ya hace `htmlbox-spec-wfp-consolidacion.md` entre "publicar HTML" (no redeploya) y "cambian bindings/secrets" (sí redeploya): guardar un flujo también redeploya, porque cambia lo que el script hace, no solo lo que muestra.

"▶ Probar flujo"/"▶ Probar este nodo" del editor (que sí funcionan, corren contra el `runtime: 'node'`/`'worker'` que sirve el catálogo) se pueden dejar activos para prototipar antes de guardar — no hace falta bloquear esa parte, solo el guardado real.

## 4. Bindings, secrets y credenciales — reusa lo ya specced en WFP

Los nodos `turso`/`cloudflare-*` necesitan bindings reales (D1/KV/R2) o una Conexión (`configNodes`) con credenciales — exactamente lo que ya define `htmlbox-spec-wfp-consolidacion.md` §3 (Variables y Secrets por box). No hay que inventar un mecanismo de credenciales nuevo:

- Bindings nativos de Cloudflare (D1/KV/R2 reales del tenant) → declarados en el `metadata.json` del deploy de WFP, igual que para cualquier box con bindings — el `worker.js` generado los recibe en `env`, y `extractPlatformBindings(env)` (helper que ya exporta `flow-engine/app`) los expone en `ctx.platformBindings` para los nodos `cloudflare-*`.
- Credenciales de terceros (una API key de Shopify, por ejemplo) → guardadas cifradas en `htmlbox_box_env` (WFP §3), inyectadas como `secret_text` en el deploy, y armadas como un `configNodes` array al crear la app (`turso-connection`, `shopify-connection`, etc.) — el patrón "Conexión" que `flow-engine` ya define, solo que HTMLBox arma el array en vez de que alguien lo tipee en `config-nodes.json`.

Si el análisis de IA de un box (`htmlbox-spec-ai-analyze-robusto.md`) detecta que el flujo necesita una integración externa, el atajo "¿agregás la key acá?" que ya menciona esa spec apunta exactamente a este mismo lugar.

## 5. Lógica custom (nodo `function`) — sandbox real vía Worker Loader

Si un flujo necesita algo que ningún nodo del catálogo cubre pero no amerita todo un Box Dev, el nodo `function` (JS libre, `new Function`) es la salida — pero corriendo código que en última instancia puede haber sido escrito o editado por un tenant, hace falta el binding `worker_loaders: [{ binding: 'LOADER' }]` en el deploy de WFP para que corra aislado (Worker Loader / Dynamic Workers), no en el mismo isolate que el resto del script. Esto ya está validado en producción según `_flow-engine/docs/resultados-poc-worker-loader-function-node.md` (~2ms de overhead) — declarar el binding en `buildBindingsForBox()` (WFP §3) para boxes con backend visual es todo lo que hace falta, el nodo lo detecta solo.

Sin ese binding, `function` sigue funcionando pero sin aislamiento real — aceptable solo si el código de esos flujos lo escribe el equipo, no un tenant. Recomiendo declarar `LOADER` por default en todos los boxes con backend visual, ya que el público objetivo (tenants no técnicos armando flujos) es justo el caso donde el aislamiento importa.

Alternativa sin binding: el nodo `transform` (JSONata) cubre mucha lógica sin necesitar sandbox en absoluto — la UI del editor puede sugerir `transform` primero y dejar `function` como salida avanzada.

## 6. Limitaciones a comunicar (no bloquean esta spec, pero hay que ser honesto con quien diseña el flujo)

- **Estado entre requests**: `ctx.flow`/`ctx.global` de `flow-engine` viven en memoria del isolate — no persisten entre reinicios ni se comparten entre instancias del Worker (no hay Durable Objects detrás todavía, según el propio roadmap de la librería). Un flujo que necesite recordar algo entre llamadas (un contador, un carrito) tiene que usar `turso`/`cloudflare-kv` explícitamente, no `ctx.global`. Vale la pena que el editor embebido en el portal muestre un aviso cuando alguien use `ctx.global` en un `function`/`transform`, para que no se sorprenda en producción.
- **Cada guardado de flujo es un deploy**: no hay hot-reload — coherente con el resto de WFP, pero hay que comunicarlo en la UI ("Guardar" en el tab Backend tarda unos segundos porque redeploya, a diferencia de "Publicar" en el tab HTML).
- **Sin firma HMAC lista para todo**: si un flujo recibe un webhook externo (ej. Stripe) que necesita verificar firma, hoy solo Paddle tiene el nodo de verificación (`paddle-webhook-verify.js`) — la base (`msg.headers`/`msg.rawBody`, disponibles siempre) ya está, pero falta el nodo específico para otros proveedores. Se agrega bajo demanda, no bloquea el lanzamiento de esta spec.

## 7. Relación con los specs existentes

- **`htmlbox-spec-wfp-consolidacion.md`**: es la base — bindings, secrets, `redeployBoxWorker()`, y el `worker.js` sirviendo HTML directo de R2 (§4 de esa spec) se combinan literalmente en el mismo archivo generado (§2 de acá). Esta spec depende de esa.
- **`htmlbox-spec-box-devs-preview.md`/`-zip-upload.md`**: siguen existiendo para el caso "necesito un Worker de verdad, no un flujo" — el Box Dev técnico. Ambos caminos son opciones dentro del mismo mecanismo de deploy, no se compite entre sí.
- **`htmlbox-spec-ai-analyze-robusto.md`/`ai-tool-loop.md`**: un desarrollo natural a futuro (fuera de alcance de esta spec) es que la IA proponga el flujo visual directamente a partir de lo que detecta en el HTML — "veo un `<form>` que apunta a `/api/contacto` → ¿armo el flujo que lo recibe y lo guarda en una tabla?" — pero eso es una spec aparte, esta solo deja la infraestructura lista para que exista.

## 8. Checklist

1. Plantilla del `worker.js` generado (§2) — un solo archivo, parametrizado por `flow.json` + lista de bindings del box.
2. `POST /api/boxes/:id/flow` — guarda `flow.json` en R2 (mismo bucket que HTML), dispara `redeployBoxWorker(reason: 'flow_updated')`.
3. Instancia liviana de `flow-engine` (modo `'node'` o `'worker'`, sin bindings reales) solo para servir `GET /_editor/api/nodes` al editor embebido — nunca se le pega para guardar.
4. Portal: tab "Backend" en el editor de box, embebiendo `editor-vanilla/index.html` de `flow-engine` apuntado al endpoint del punto 3, con el guardado real redirigido al punto 2.
5. `buildBindingsForBox()` (WFP §3): agregar `worker_loaders: [{ binding: 'LOADER' }]` por default en boxes con backend visual.
6. `extraNodes` propios de HTMLBox si hacen falta (ej. un nodo que sepa mandar el email de bienvenida de un tenant sin que el flujo tenga que armar el `cloudflare-email` a mano) — opcional, no bloquea el lanzamiento inicial.
7. Tests: un flujo con `http-in` + `turso` (CRUD real) deployado como box real responde correctamente contra Turso real del tenant (no mock); un flujo con `function` sin `LOADER` sigue funcionando (sin sandbox); un flujo con `function` y `LOADER` corre aislado (test que confirme que no puede tocar `ctx.platformBindings` crudo de otro box); guardar un flujo dispara exactamente un `redeployBoxWorker`, no más de uno por guardado.
