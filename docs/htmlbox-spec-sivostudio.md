# Spec: SivoStudio — cada box se edita a sí mismo (`/editor/*` bajo su propia URL de box)

## 0. Qué es esto y por qué se está probando

Hoy, publicar un box es relativamente simple: se sirve HTML/CSS/JS estático
desde R2 y listo. Este spec no reemplaza ese camino — es una ALTERNATIVA que
David quiere probar en paralelo: en vez de que "crear box" sea una operación
barata (sin tocar Cloudflare) y "publicar" sea la primera vez que se despliega
algo real, **se invierte el orden**: crear un box despliega de una vez un
Worker real en Workers for Platforms (WFP), con sus bindings reales y
flow-engine ya montado, y el usuario diseña frontend y backend contra ESE
worker desde el primer segundo — bajo la misma URL que la app final, no en
un dominio de "estudio" aparte.

La idea clave (ajustada respecto a la primera versión de este spec): NO hay
un dominio central `sivostudio.*` sirviendo los editores. Cada box, una vez
creado, se edita A SÍ MISMO, bajo la URL que ya usa hoy el patrón de boxes
sin dominio propio (path-based, no subdominio-based — igual a como ya
funciona el resto de la plataforma):

```
sivocloud.dev/box/uydh7dhyd/                → la app (placeholder hasta el primer deploy)
sivocloud.dev/box/uydh7dhyd/editor/frontend → App Studio, editando este box
sivocloud.dev/box/uydh7dhyd/editor/backend  → Flow Editor, editando este box
sivocloud.dev/box/uydh7dhyd/editor/variables → vars y secrets de este box
sivocloud.dev/box/uydh7dhyd/api/*           → el backend real (flow-engine)
```

`uydh7dhyd` es el boxId. Esto NO requiere aprovisionar un dominio/subdominio
nuevo por cada box creado — se apoya en el mecanismo estándar de Workers
for Platforms: un único Worker "front" recibe todo el tráfico de
`sivocloud.dev/box/*`, le quita el prefijo `/box/:boxId` a la request, y
la despacha con `env.DISPATCH_NAMESPACE.get(boxId).fetch(request)` hacia
el script real de ese box. El `worker.js` de cada box (§2) recibe la
request YA sin el prefijo — ve `/`, `/editor/frontend`, etc. como si fuera
la raíz, sin saber ni importarle bajo qué prefijo lo alcanzaron. Esto es
exactamente el patrón que ya usa el resto de la plataforma para boxes sin
dominio custom todavía — `sivostudio` reutiliza esa misma idea, con su
propio front-worker apuntando al namespace separado (§1.1) en vez del de
producción.

Esto elimina cualquier necesidad de pensar en cross-origin o en "el editor
en un dominio distinto al de la app": el editor y la app SIEMPRE están en
el mismo origen, porque son literalmente el mismo Worker (solo que
alcanzado a través del front-worker de dispatch).

La motivación de fondo (igual que en la primera versión): evitar la
divergencia entre "lo que el usuario prueba mientras diseña" y "lo que
corre cuando publica" — si desde el día 0 todo corre contra el worker
real, no hay sorpresas de última hora. El costo a cambio es aprovisionar
infraestructura real por cada box creado, incluso los que el usuario
abandona sin publicar nunca.

**Alcance de esta fase — a propósito muy reducido:**

- **Sin auth.** `/editor/*` no tiene sesión ni login todavía — cualquiera
  con la URL del box puede editarlo. Ver §6.
- **`sivostudio` deja de ser una app con vistas propias** — se reduce a un
  LANZADOR: una pantalla con el botón "Crear box" que aprovisiona el
  worker y redirige a `<url-del-box>/editor/frontend`. De ahí en adelante
  el usuario nunca vuelve a `sivostudio`.
- **Namespace de WFP separado**, para aislar por completo de producción
  (§1).

## 1. `sivostudio`: el lanzador

Paquete nuevo y separado dentro del monorepo, hermano de
`portal`/`control-plane`/`runtime`:

```
packages/sivostudio/
  src/
    launcher-worker.js   — sirve la pantalla con el botón "Crear box";
                           al crear, llama al aprovisionamiento (§3) y
                           redirige a sivocloud.dev/box/:boxId/editor/frontend.
    front-worker.js       — el Worker que recibe sivocloud.dev/box/*,
                             quita el prefijo /box/:boxId y despacha al
                             script real vía el dispatch namespace de WFP
                             (reusa el mismo patrón que ya existe en la
                             plataforma para boxes sin dominio propio —
                             ver `packages/runtime-box-worker` si ya
                             resuelve esto, para no duplicarlo).
    box-template/
      worker.js           — la PLANTILLA que se genera para cada box
                             nuevo (ver §2). Este archivo es el que de
                             verdad importa — el launcher es solo el
                             botón.
      app-studio/          — copia del prototipo repl-svelte (App
                              Studio), embebida en la plantilla.
  wrangler.jsonc
  package.json
```

Nada de `sivostudio` importa de `portal` ni de `control-plane`.
`sivostudio` mantiene su PROPIO registro de boxes (boxId, nombre, D1 id,
worker script name) — no usa la base de datos de `control-plane`, así
queda de verdad aislado también a nivel de datos, no solo de deploy. Sí
puede importar `flow-engine` y reusar `deployBoxWorker()`/
`redeployBoxWorker()` si ya están expuestos como función reutilizable — si
hoy viven acoplados dentro de `control-plane`, extraerlos a un paquete
compartido (o duplicar la función mínima necesaria en `sivostudio` por
ahora) es preferible a crear una dependencia cruzada entre los dos
proyectos.

### 1.1 Namespace de WFP separado

Los boxes que cree `sivostudio` se despliegan a un dispatch namespace de
Workers for Platforms DISTINTO al de producción (p. ej.
`sivostudio-experiments`). Ventajas:

- Aislamiento total: nada de lo que pase acá puede chocar con un script
  real de un tenant.
- Se puede borrar el namespace completo de un tirón si el experimento se
  descarta, sin tocar nada de producción.
- Permite decidir después, con calma, si esto migra al namespace real o
  se queda separado permanentemente (por ejemplo, como "modo sandbox"
  oficial, con el namespace real reservado solo para cosas publicadas).

## 2. El `worker.js` de cada box: cuatro zonas en un solo script

Cada box, desde el momento en que se crea, es UN Worker con cuatro grupos
de rutas. Estas rutas son relativas a la raíz del propio script — el
front-worker (§1) ya le quitó el prefijo `/box/:boxId` antes de despachar,
así que el box nunca necesita saber su propio boxId para enrutar:

- `/` (y cualquier ruta que no matchee las de abajo) → sirve la app: el
  HTML exportado por App Studio la última vez que se hizo "Deploy" (o un
  placeholder "Este box está vacío" si nunca se ha hecho deploy).
- `/editor/frontend` → sirve App Studio completo (el editor Svelte
  compilado en el navegador), embebido en el propio worker.
- `/editor/backend` → sirve `editor-vanilla/index.html` de flow-engine,
  montado contra el flow-engine REAL de este mismo worker
  (`GET /editor/backend/api/nodes`, redirigiendo internamente al
  `mountPath` real de flow-engine — ver nota de implementación abajo).
- `/editor/variables` → formulario simple de vars/secrets (ver §2.3 de la
  versión anterior de este documento — se mantiene igual, solo cambia la
  ruta).
- `/api/*` → el backend real: `createFlowEngineApp` montado ahí, con los
  flows actuales del box.

Nota de implementación sobre `/editor/backend` y `mountPath`: flow-engine
espera un `mountPath` fijo para su editor (p. ej. `/_editor`). Lo más
simple es dejar que flow-engine siga usando ese `mountPath` interno tal
cual, y que el `worker.js` del box haga un rewrite/proxy transparente:
toda request a `/editor/backend/*` se reescribe a `/_editor/*` antes de
pasarla al `app.handleWorker()`. Así no hay que tocar flow-engine para que
entienda una ruta nueva — el box simplemente decide cómo se llama la
puerta de entrada.

## 3. Qué pasa al crear un box (aprovisionamiento eager)

Al hacer clic en "Crear box" en el lanzador de `sivostudio`:

1. Se crea el registro del box (boxId, nombre) en el registro propio de
   `sivostudio` (§1).
2. Se aprovisionan los recursos reales mínimos:
   - Base D1 nueva (vía la API de Cloudflare, o el mecanismo que ya use
     `deployBoxWorker()` hoy para D1 por-box en `control-plane`).
   - Namespace de KV si aplica (puede posponerse hasta que el usuario use
     un nodo KV en un flow).
3. Se genera el `worker.js` a partir de la plantilla (§2), con flows
   vacíos y el placeholder de app.
4. Se despliega ese `worker.js` al namespace de WFP separado (§1.1), con
   el boxId como nombre del script — sin aprovisionar dominio ni DNS,
   porque el front-worker (§1) ya sabe despachar cualquier boxId
   automáticamente vía `env.DISPATCH_NAMESPACE.get(boxId)`.
5. El lanzador redirige al navegador a
   `sivocloud.dev/box/:boxId/editor/frontend`. A partir de aquí,
   `sivostudio` (el lanzador) ya no vuelve a involucrarse — todo pasa
   dentro del propio worker del box, a través del front-worker.

Resultado: el usuario, segundos después de crear el box, ya está parado
sobre `/editor/frontend` de su propio worker, con `/editor/backend`
disponible ahí mismo — contra bindings reales, no simulados.

## 4. Cómo se comunican realmente frontend y backend (no es un binding)

Aclaración importante para el equipo, porque puede parecer que por vivir
todo en el mismo script hay algo tipo binding entre App Studio y
flow-engine — NO es así:

- **App Studio corre en el navegador** (es Svelte compilado client-side,
  incluso cuando se sirve desde `/editor/frontend`). Cuando el código que
  el usuario está diseñando hace `fetch('/api/...')`, es una petición
  HTTP normal por red, que llega al `fetch(request)` del worker como
  cualquier visita — la recibe el nodo `http in` de flow-engine, sin nada
  especial. Que todo viva en el mismo `worker.js` solo garantiza mismo
  origen (cero CORS), no cambia el mecanismo de transporte.
- **Los bindings reales** (D1/KV/R2) son exclusivamente para la
  comunicación DENTRO del worker, entre los nodos `cloudflare-*` de
  flow-engine y la infraestructura de Cloudflare (`ctx.platformBindings`).
  Eso no tiene nada que ver con cómo el frontend llega al backend.

## 4.1 Velocidad del deploy y cuándo se dispara

Importante para que el equipo no lo implemente mal: un "deploy" acá es una
llamada a la API de Cloudflare subiendo el script al dispatch namespace —
no un pipeline de CI/CD. Suele quedar vivo en 1-2 segundos, no minutos.
Nada que ver con la lentitud de `wrangler dev --remote` de la que veníamos
hablando en sesiones anteriores (eso era un problema de tunneling entre
sesiones de desarrollo, no de subir un script).

Aun así, el redeploy debe dispararse SOLO en acciones explícitas de
guardado del usuario, nunca en cada edición incremental:

- App Studio: cero redeploys mientras se diseña — todo corre en el
  navegador (compilador de Svelte en vivo). Solo toca el worker al hacer
  clic en "Deploy" (§6).
- Flow Editor: redeploy solo al hacer clic en "Guardar" del editor de
  flow-engine (como ya funciona hoy) — nunca en cada arrastre de nodo o
  cambio de campo.
- Variables: redeploy solo al confirmar el formulario, no mientras se
  escribe.

Antes de construir esto, confirmar en la documentación de Cloudflare si
hay límites de tasa (rate limits) para actualizaciones de script en un
namespace de dispatch — no debería ser un problema con guardados puntuales
de usuario, pero vale la pena confirmarlo, no asumirlo.

## 5. Sin auth por ahora — qué significa eso en la práctica

Para esta fase, deliberadamente `/editor/*` no tiene login ni sesión.
Cualquiera con la URL del box puede editarlo. Esto es aceptable solo
porque:

- Corre en un namespace de WFP separado y desechable (§1.1), sin datos de
  tenants reales.
- Las URLs de los boxes no se anuncian ni se enlazan desde el portal
  real — la única forma de llegar es conociendo la URL directamente
  (generada al azar / no adivinable, idealmente).
- No se usa un dominio público indexable para este namespace.

Cuando (y si) esto pase de experimento a algo que reciba tráfico real, ahí
sí hace falta retomar `htmlbox-spec-auth-centralizado.md` y proteger
`/editor/*` con sesión real — pero eso es trabajo para DESPUÉS de validar
que la mecánica (crear box → worker real → editar en vivo → deploy)
funciona y vale la pena. No bloquear el prototipo en eso ahora.

## 6. Botón "Deploy" (publicar de verdad)

Cuando el usuario está conforme con su diseño, desde `/editor/frontend`:

1. App Studio exporta el bundle final (igual que "Exportar HTML" hoy,
   pero en vez de descargar, hace `POST /editor/api/frontend` — un
   endpoint que vive en el MISMO worker del box — con el HTML resultante).
2. El flow actual (ya guardado incrementalmente desde `/editor/backend`,
   vía `POST /editor/api/flow`) se marca como la versión "publicada".
3. El worker regenera su propio código: se reescribe la ruta `/` para
   servir el HTML real recién exportado (en vez del placeholder), con el
   flow real (no vacío) ya montado en `/api/*`. `/editor/frontend` y
   `/editor/backend` siguen existiendo igual, para seguir iterando
   después de publicar.
4. `redeployBoxWorker(reason: 'published')` sobre el mismo script — no se
   crea un script nuevo, se actualiza el existente.
5. A partir de aquí, la URL del box sirve la app real en `/`, con los
   editores disponibles ahí mismo bajo `/editor/*`.

## 7. Costos y limpieza — lo que hay que vigilar

Aprovisionar D1 + un Worker real por cada box CREADO (no solo publicado)
tiene costo de infraestructura y de "basura" acumulada: boxes que el
usuario crea, prueba, y abandona sin publicar nunca. Se recomienda:

- Un job periódico que identifique boxes sin actividad ni publish en N
  días (p. ej. 30) y libere sus recursos (borrar el Worker de WFP, marcar
  la D1 para borrado).
- Un límite razonable de boxes "en diseño" simultáneos, para no dejar que
  el namespace de pruebas crezca sin control.

## 8. Relación con specs existentes

- Toma prestado el patrón de `worker.js` (estático + flow-engine
  combinados) descrito en `htmlbox-spec-box-flows-backend.md`, pero
  `sivostudio` implementa su propia versión mínima — no depende de que
  esa spec esté implementada en `control-plane` primero.
- `htmlbox-spec-auth-centralizado.md` queda como trabajo FUTURO, para
  cuando esto deje de ser un experimento aislado (ver §5) — no es
  dependencia de esta fase.
- Es un prototipo separado de `htmlbox-spec-box-devs-preview.md` (el
  preview desechable bajo demanda, que sí vive dentro de `control-plane`).
  Se comparan resultados más adelante, no hay que unificarlos ahora.

## 9. Checklist de implementación

- [ ] Paquete `packages/sivostudio` con el lanzador mínimo (botón "Crear
      box" + registro propio de boxes).
- [ ] Namespace de WFP separado (`sivostudio-experiments` o similar).
- [ ] Front-worker que recibe `sivocloud.dev/box/*`, quita el prefijo y
      despacha vía `env.DISPATCH_NAMESPACE.get(boxId)` — revisar primero
      si `packages/runtime-box-worker` ya resuelve esto y se puede
      reusar/apuntar al namespace separado en vez de reescribirlo.
- [ ] Plantilla de `worker.js` de box con las cuatro zonas: `/`,
      `/editor/frontend`, `/editor/backend`, `/editor/variables`,
      `/api/*`.
- [ ] Rewrite/proxy interno de `/editor/backend/*` → `mountPath` real de
      flow-engine (sin tener que modificar flow-engine).
- [ ] Botón "Crear box": aprovisiona D1 + Worker con la plantilla y
      redirige a `<url-del-box>/editor/frontend`.
- [ ] `/editor/frontend`: copiar el prototipo `repl-svelte` (App Studio)
      como punto de partida, embebido en el worker del box.
- [ ] `/editor/variables`: formulario de vars/secrets, guardado en el
      propio worker/registro del box, redeploy al guardar.
- [ ] Endpoints internos del box: `POST /editor/api/flow`,
      `POST /editor/api/frontend`, `POST /editor/api/variables`.
- [ ] Botón "Deploy": funde HTML de App Studio + flow guardado +
      variables, reescribe `/` del propio worker y redespliega.
- [ ] Job de limpieza de boxes abandonados (D1 + Worker sin actividad).
- [ ] (Después, no ahora) revisar si mover a auth real y/o al namespace
      de producción, según qué tan bien funcione el experimento.
