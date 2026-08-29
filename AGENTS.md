# AGENTS.md — contexto para agentes AI en HTMLBox

> Documento vivo. Si cambiás la arquitectura, los comandos, o una convención
> del repo, actualizá esto en el mismo PR. El objetivo es que un agente
> nuevo (vos o cualquier otro) pueda responder "qué hace este repo, cómo lo
> corro, dónde está cada cosa, qué NO hacer" sin tener que leerlo entero.

---

## 1. Qué es HTMLBox

Plataforma **runtime + publicador** para dashboards y apps HTML generados por
IA (ChatGPT, Claude, Gemini) sobre Cloudflare Workers. El usuario sube un
HTML con datos embebidos, HTMLBox lo sirve en un subdominio wildcards
(`{tenant}.sivocloud.dev/{boxSlug}`) y opcionalmente extrae los datos a una DB
Turso aislada por box, dejando el HTML apuntando a la Data API.

Tres Workers + 3 docs canónicos:

| Doc | Qué cubre |
|---|---|
| `README.md` | Quick start, topología, setup local |
| `arquitectura.md` | Decisiones de arquitectura (topología, multi-tenancy, R2, Turso, RBAC) |
| `htmlbox-spec-*.md` | Specs por feature — las `*-IMPLEMENTED.md` ya están hechas |

## 2. Repo layout

```
htmlbox/
├── packages/
│   ├── shared/         constantes, validadores, schema SQL por box, versioning
│   ├── control-plane/  Worker D1-bound  — registry, AI, internal API (auth vive aparte)
│   ├── auth/           Worker separado — magic links, login, sesión cross-subdomain
│   ├── portal/         Worker reverse-proxy — SPA Alpine.js del tenant
│   ├── runtime-core/   pieza pura de runtime (sirve HTML, resuelve boxes, helpers auth control-plane) — sin bindings propios, sin auth de customer
│   ├── runtime-box-worker/  per-box script WFP (bundle ESM, deploya al dispatch namespace)
│   ├── runtime/        Worker box-local   — sirve HTML, Data API, app-auth, consume @htmlbox/runtime-core
│   ├── landing/        Worker apex de sivocloud.dev (Coming Soon + forward a runtime)
│   └── sivostudio/     EXPERIMENTO aislado — cada box se crea como Worker WFP real
│                        y se edita a sí mismo bajo /box/:boxId/editor/*. Paquete
│                        totalmente separado: NO comparte DB ni bindings con el resto.
│                        Ver `docs/htmlbox-spec-sivostudio-IMPLEMENTED.md`.
├── scripts/
│   ├── dev.sh                  lanza los 6 workers en background con colores
│   ├── migrate-remote.sh       wrangler d1 migrations apply --remote (control-plane + sivostudio)
│   ├── setup-wfp.sh            prepara WFP prod (namespace `htmlbox-boxes`)
│   ├── setup-wfp-experiments.sh prepara WFP para sivostudio (namespace `sivostudio-experiments`)
│   └── wipe-demo.sh            borra TODO el contenido de demo (D1 + R2 + WFP) — usar solo en dev
├── package.json        workspaces npm (packages/*)
└── htmlbox-spec-*.md   specs (las -IMPLEMENTED ya están implementadas)
```

| Worker | Puerto dev | Host dev | Modo wrangler |
|---|---|---|---|
| `htmlbox-control-plane` | 8781 | `controlplane.localhost` | `--remote` |
| `htmlbox-portal` | 8782 | `studio.localhost` | `--remote` |
| `htmlbox-runtime` | 8783 | `runtime.localhost` | `--remote` |
| `htmlbox-landing` | 8784 | `sivocloud.localhost` | `--remote` |
| `htmlbox-auth` | 8785 | `auth.localhost` | `--remote` |
| `htmlbox-sivostudio` | 8786 | `studiov2.localhost` | `--remote` |

**Todos los workers corren `--remote`** — único source of truth, mismas tablas / bindings
que prod. Cada worker levanta un preview en el edge de Cloudflare y la proxy local
(8781-8784) forwardea al edge. Las migrations se aplican con `npm run migrate:remote`
antes de arrancar dev.

**Inter-worker calls vía service bindings** (NO HTTP fetch público):
- `portal → control-plane` vía `env.CONTROL_PLANE.fetch(request)` **solo en prod**
  (ver más abajo — en dev el portal usa fetch HTTP directo, no el binding).
- `landing → runtime` vía `env.RUNTIME.fetch(request)`

Workaround para bug de wrangler 4.127+ donde fetches worker-to-worker via custom
domain en la misma zona hanguean 20s (522). Service binding es interno (no sale
al edge público), zero-latency, sin loop.

**Trade-off `--remote`**: las vars de wrangler.jsonc apuntan a URLs prod (ej
`HTMLBOX_PORTAL_ORIGIN=https://studio.sivocloud.dev`). Para dev hay que
sobreescribir vía `.dev.vars` cuando el worker corre en `--local` — pero
`--remote` no carga `.dev.vars`. Sol: editar el magic link manualmente en dev
(reemplazar el host) o aceptar que el link apunte a prod.

**Causa raíz confirmada — service bindings NO conectan con sesiones `--remote`
ajenas (2026-08-28)**: cuando `portal` corre `wrangler dev --remote` y llama a
`env.CONTROL_PLANE.fetch()`, ese binding **no** se conecta con la sesión
`--remote` local de `control-plane` — Cloudflare resuelve el binding contra el
script que está REALMENTE deployado en la cuenta con el nombre
`htmlbox-control-plane` (el de prod, vía `npm run deploy` / `wrangler deploy`),
no contra tu preview de dev. Confirmado contra
[`cloudflare/workers-sdk#5578`](https://github.com/cloudflare/workers-sdk/issues/5578)
("Allow local Service Bindings to proxy to a `wrangler dev --remote` session" —
cerrado como "not planned": la plataforma no soporta esto).

Esto **no** es un problema de headers perdidos/strip-eados — es que el código
que responde del otro lado del binding directamente no es el código de dev, es
el código deployado en prod. Evidencia real que confirmó esto: un smoke test
del equipo vía proxy del portal devolvió `mode: 'prod-fallback'`, un valor que
ya no existe en ningún path de `packages/control-plane/src/lib/magic-link.js`
(reemplaza a `email.js`) — solo puede venir de una versión vieja, deployada,
del control-plane. (Nota aparte: `X-Forwarded-Host` tampoco es un header
hop-by-hop de RFC 7230, así que esa hipótesis previa también era incorrecta —
mencionado acá para que quede el registro, aunque ya no es relevante con el
fix de abajo.)

**Fix aplicado (`packages/portal/src/worker.js` — `proxyToControlPlane`)**: en
dev (request con host `*.localhost` + `HTMLBOX_CONTROL_PLANE_ORIGIN` seteado en
`.dev.vars`), el portal usa **siempre** fetch HTTP directo a
`HTMLBOX_CONTROL_PLANE_ORIGIN` (`http://controlplane.localhost:8781` — el proxy
local de la sesión `--remote` real de control-plane), nunca el service binding.
El service binding se sigue usando tal cual en prod y en cualquier caso no-dev,
donde sí hay una sola versión deployada y el binding resuelve correcto.
`injectForwardedHost()` se mantiene (sigue siendo útil como señal explícita
para `magic-link.js::buildMagicLinkUrl`) pero ya no es lo que resuelve este
bug — el fetch HTTP directo sí llega al código de dev real.

**Testear el magic link vía curl directo** a controlplane.localhost:8781
(que sí pasa por la preview con vars dev) sigue siendo válido como diagnóstico
rápido, sin pasar por el portal en absoluto:
```bash
curl -X POST http://controlplane.localhost:8781/api/auth/request \
  -H "Content-Type: application/json" \
  -H "Origin: http://studio.localhost:8782" \
  -d '{"email":"tu@email.com"}'
```
Este path sí devuelve `_dev_preview: http://studio.localhost:8782/...`.

**Segunda capa de defensa — fix client-side (`packages/portal/src/ui-partials/app-script.html.txt`)**:
como el server-side (control-plane) arma el host del link con heurísticas
sobre headers que dependen de la capa de transporte (binding vs. HTTP directo,
y de que quien llame preserve Origin/Referer/X-Forwarded-Host), agregamos una
segunda capa que no depende de nada de eso: `localizeDevPreviewLink()` en el
browser reescribe el host del `_dev_preview` recibido para que coincida con
`window.location` de la pestaña actual, siempre que esa pestaña esté en
`*.localhost`. El browser sabe con certeza absoluta en qué host está — no hay
heurística que pueda fallar acá. Esto es lo que arma el panel "Magic link
generado" y lo que copia el botón "Copiar"; el botón "Entrar" ya no dependía
de esto (consume el token vía `apiFetch('/api/auth/consume', ...)`, un path
relativo que siempre resuelve contra el host actual).

**Forward-compat (DBs exclusivas de dev)**: cuando quieras D1 / Turso DBs
separadas para dev, agregá un bloque `env.dev` en `wrangler.jsonc` con
`d1_databases: [{...database_id: "DEV_DB_ID"...}]`. PERO requiere que TODOS
los workers que llamen al control-plane via service binding corran con
`--env dev` también (mismo nombre de script wrangler). Por ahora wrangler 4
NO propaga env-specific vars cross-binding, así que esa separación queda
pendiente.

**Nota DNS macOS**: `*.localhost` resuelve a `::1` (IPv6) por defecto. Los
wrangler configs tienen `dev.ip = "::"` (IPv6 dual-stack) para que funcione
sin necesidad de editar `/etc/hosts` con sudo.

## 3. Setup local

```bash
npm install                                  # una vez
cp packages/control-plane/.dev.vars.example packages/control-plane/.dev.vars
cp packages/portal/.dev.vars.example          packages/portal/.dev.vars
cp packages/runtime/.dev.vars.example         packages/runtime/.dev.vars
# editarlos con los secretos (HTMLBOX_INTERNAL_SECRET tiene que matchear en los 3)
npm run migrate:remote                        # aplica migrations D1 al control-plane
npm run build -w @htmlbox/runtime-box-worker # bundle del per-box script (sync a control-plane)
npm run dev                                   # levanta los 3 workers
```

### Workers for Platforms (WFP) — primer setup

Después del primer deploy a Cloudflare, hay que correr `./scripts/setup-wfp.sh`
UNA VEZ por ambiente para:

1. Crear el dispatch namespace `htmlbox-boxes`.
2. Guiar al usuario para generar un **Scoped API Token** en dashboard
   (scope: `Workers Scripts: Edit/Read` + resource restringido al
   namespace — esto es lo que evita el peor escenario de filtración
   del token, ver `htmlbox-spec-workers-for-platforms.md`).
3. Guardar el token como secret en control-plane:
   `cd packages/control-plane && wrangler secret put WFP_DEPLOY_TOKEN`.
4. Agregar `HTMLBOX_CLOUDFLARE_ACCOUNT_ID` como var (Cloudflare Account ID).

Sin esos 4 pasos, `htmlbox_boxes.wfp_status` queda en `'failed'` para
todo box nuevo y el dispatcher cae al path viejo (fetchActiveHtml +
serveBoxHtml, comportamiento idéntico al pre-WFP).

### WFP — sivostudio (namespace separado)

El experimento de sivostudio corre en un dispatch namespace DISTINTO
(`sivostudio-experiments`), aislado por completo del de prod. Setup
análogo con `./scripts/setup-wfp-experiments.sh`:

1. Crear el namespace `sivostudio-experiments`.
2. Generar un Scoped API Token con scope SOLO a ese namespace.
3. Guardar el token: `cd packages/sivostudio && wrangler secret put WFP_DEPLOY_TOKEN`.
4. Crear la D1: `wrangler d1 create htmlbox-sivostudio` y actualizar
   `database_id` en `packages/sivostudio/wrangler.jsonc`.

Si la D1 todavía no existe, `npm run migrate:remote` la skipea con
warning (idempotente). Ver `docs/htmlbox-spec-sivostudio-IMPLEMENTED.md`.

Subdominios `*.localhost`: en macOS resuelven solos a 127.0.0.1. En Linux
hay que agregar a `/etc/hosts`.

**Aislamiento de sivostudio (experimento separado)**: el worker
`htmlbox-sivostudio` usa `studiov2.localhost` (dev) / `studiov2.sivocloud.dev`
(prod) — distinto de `studio.*` que pertenece al portal. Refuerza el
aislamiento a nivel de origen (sin CORS ni cookies cruzadas con el portal).

## 4. Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | `bash scripts/dev.sh` — lanza los 6 workers con log tail mergeado |
| `npm run dev:control` / `:portal` / `:runtime` / `:landing` / `:auth` / `:studio` | Levanta UN worker solo (debug rápido) |
| `npm run migrate:remote` | Aplica migrations D1 remotas (`wrangler d1 migrations apply --remote`) — control-plane + sivostudio |
| `npm run build -w @htmlbox/sivostudio` | Inlinea App Studio + bundlea el box-template per-box → `dist/box-worker.mjs` |
| `npm run build:editor -w @htmlbox/sivostudio` | Solo regenera `box-template/editors/app-studio.html.txt` desde `Chats/projects/repl-svelte/` |
| `npm test` | Corre tests de los workspaces (control-plane: node + vitest, runtime/shared: node --test) |
| `npm test -w <pkg>` | Solo el workspace `<pkg>` |

### Tests por workspace
- **`packages/shared`** (`node --test src/__tests__/*.test.js`): constantes, validadores, schema, versioning
- **`packages/runtime-core`** (`node --test __tests__/*.test.js`): pieza pura de runtime (htmlServer, resolver, auth helpers, debugPanel gate, contract). Sin bindings propios — todo fetch mockeado.
- **`packages/runtime-box-worker`** (`node --test __tests__/*.test.js`): tests del bundle (parsea, exporta default, fetch handler, errores del upstream).
- **`packages/runtime`** (`node --experimental-test-module-mocks --test __tests__/*.test.js`): routers puros con fetch mockeado (data API, app-auth, app-data, tenant-app-auth, sdk). Reusa helpers de `@htmlbox/runtime-core`.
- **`packages/control-plane`**: dos suites:
  - `npm run test:node` → `node --test src/__tests__/*.test.js` (unit tests de dataExtractor, session.js, wfpDeployer, dbMigrations, etc.)
  - `npm run test:e2e` → `vitest run` con `cloudflare:test` (e2e real con D1 en miniflare)

## 5. Convenciones

### Prefijos
- TODO recurso lleva `htmlbox-`: Workers (`htmlbox-control-plane`, `htmlbox-portal`, `htmlbox-runtime`), D1 (`htmlbox-control-plane`), R2 (`htmlbox-content`), KV (`htmlbox-cache`), Turso DBs (`htmlbox-box-{boxId}`), tablas (`htmlbox_*`), cookies (`hbx_*`), rutas (`/api/*`), paths de R2 (`tenants/{slug}/...`).
- Constantes en `packages/shared/src/constants.js` (re-exportadas por `@htmlbox/shared`).

### Auth
Tres cookies conviven, una por tipo de usuario — **distinto nombre, distinto scope**:

| Cookie | Scope | Path/Domain | Quién |
|---|---|---|---|
| `sid` | Path=/, Domain=.sivocloud.dev | cross-subdominio | usuario de PLATAFORMA (login en portal) |
| `hbx_app_sid` | Path=`/{boxSlug}` (o `/s/{shareId}`, `/t/{tenant}/{boxSlug}`) | host-only o Domain | CUSTOMER de un box (login en box publicado) |
| `hbx_tapp_sid` | Path=/, Domain=.sivocloud.dev | cross-box del tenant | usuario CENTRALIZADO del tenant (cruza boxes con un solo login) |

Sesiones/magic-links viven en D1 (plataforma + tenant-app) o en Turso del box
(app-user per-box). Secret tokens de Worker a Worker: `HTMLBOX_INTERNAL_SECRET`,
gateado por `requiresInternalSecret` en `routes/internal.js`.

### Aislamiento
- Cada box tiene su propia Turso DB. NO hay `WHERE box_id = ?` en queries — la
  DB física es el aislamiento.
- Los R2 keys SIEMPRE los arma el server, jamas el cliente. Contención de
  `../` con `namespacedKey()` (ver `packages/shared/src/namespacedKey.js`).

### Scope de tablas (fase 2 — customers)
- `htmlbox_tables.scope`: `'private'` (default — cada app-user ve solo lo suyo
  por `owner_user_id`) | `'shared'` (catálogo — todos ven lo mismo).
- Default `'private'` es la opción segura: una tabla nueva en un box con
  customers nace particionada.

### Commit style
Conventional Commits en español:
- `feat(scope): ...` — funcionalidad nueva
- `fix(scope): ...` — bug fix
- `refactor(scope): ...` — refactor sin cambio de comportamiento
- `docs: ...` — solo docs
- `test(scope): ...` — solo tests

Scopes usados: `portal`, `runtime`, `control-plane`, `shared`, `users`, `ai`, `dev`.

## 6. Specs workflow

Cada feature nueva arranca con un `htmlbox-spec-{nombre}.md`. Cuando se
implementa al 100%, se renombra con sufijo `-IMPLEMENTED.md` (commit
`docs: rename ... → -IMPLEMENTED`).

Specs ya implementadas:
- `htmlbox-spec-ai-apply-schema-IMPLEMENTED.md`
- `htmlbox-spec-app-customers-IMPLEMENTED.md`
- `htmlbox-spec-app-users-IMPLEMENTED.md`
- `htmlbox-spec-app-users-centralized-IMPLEMENTED.md`
- `htmlbox-spec-codemirror-editor-IMPLEMENTED.md` (reemplazó a monaco-editor en `eb1500e`; este queda como histórico con header de superseded)
- `htmlbox-spec-debug-panel-IMPLEMENTED.md`
- `htmlbox-spec-migracion-apifetch-IMPLEMENTED.md`
- `htmlbox-spec-monaco-editor-IMPLEMENTED.md` (HISTÓRICO — superseded por codemirror-editor)
- `htmlbox-spec-partials-htmlrewriter-IMPLEMENTED.md`
- `htmlbox-spec-sivostudio-IMPLEMENTED.md`

Anexo cerrado (mismo sufijo `-IMPLEMENTED` significa "todos los
hallazgos cerrados con tests"):
- `htmlbox-anexo-revision-seguridad-app-users-IMPLEMENTED.md` (4 hallazgos cerrados en commit `995a475`)

No hay specs pendientes — todos los `htmlbox-spec-*.md` están en estado `-IMPLEMENTED`. Si necesitás levantar uno nuevo, crealo con nombre nuevo siguiendo el patrón `htmlbox-spec-{nombre}.md`.

## 7. Patrones del proyecto

### Frontend (portal)
- Toda UI es Alpine.js. NO hay React/Vue. Componentes como `function usersTab() { return { ... } }`
  en `packages/portal/src/ui-partials/app-script.html.txt` (es UN solo archivo).
- Llamadas al backend vía `apiFetch(path, opts)` global (ver `appFetch` global al
  inicio de `app-script.html.txt`). NUNCA usar `fetch()` crudo en el portal —
  `apiFetch` maneja credenciales, JSON, errores con `.status/.code/.rayId`.
- Llamadas cross-Worker usan `window.HTMLBOX_RUNTIME_ORIGIN` (inyectado por el
  portal en el shell, ver `packages/portal/src/lib/partials.js` `headAppend`).

### Backend
- `htmlbox-spec-migracion-apifetch.md` migró todo el `fetch()` crudo a
  `apiFetch()` global. NO volver a `fetch()` directo en routes/ del portal.
- Nuevas rutas se agregan al router que corresponda (`handleDataApi`,
  `handleAppAuth`, `handleTenantAppAuth`, `handleInternal`, etc.).
- Patrón de URL: `/api/{scope}/{boxId}/{op}` (box-scoped) o `/api/{scope}/...`
  (tenant-scoped). `{boxId}` SIEMPRE matchea `^[a-z0-9]{16}$`.

### Emails via flow-engine (Fase 3+)

TODO el envío de emails transaccionales pasa por el **flow-engine**
corrriendo como librería dentro del control-plane (`PROJECTS/_flow-engine/`,
módulo linkeado via `"flow-engine": "file:../../../../_flow-engine"` en
`packages/control-plane/package.json`).

- Flows viven en `packages/control-plane/src/flows/*.flow.json`. Cada uno
  es un array de nodos compatible con flow-engine.
- `src/lib/flows.js` bootstrapea el flow-engine app (singleton
  memoizado por signature de env) y expone:
  - `handleFlowWorker(req, env, ctx)` para HTTP requests externos
    (webhooks, smoke tests via curl).
  - `runFlow(flowName, payload, env, ctx)` para llamadas in-process
    desde `routes/*.js`. Construye un Request sintético y delega a
    `app.handleWorker` — sin roundtrip HTTP.
- `src/lib/magic-link.js` construye el magic link URL + render del email
  (subject, text, html) + invoca `runFlow('magic-link', ...)`. Es la
  versión "magrelink" de lo que antes era `lib/email.js` (borrado en
  Fase 3 cuando todo el envío pasó por flow-engine).
- `src/worker.js` rutea `/api/flows/*` a `handleFlowWorker` antes del
  bloque try principal — el path nativo del control-plane sigue intacto.
- Bindings (`EMAIL`) ahora se resuelven vía
  `extractPlatformBindings(env)` del flow-engine — el binding `EMAIL`
  en `wrangler.jsonc` (`send_email: [{ name: "EMAIL" }]`) lo inyecta al
  `ctx.platformBindings` que lee el nodo `cloudflare-email`.

Para agregar un nuevo flow (ej. `app-magic-link`):
1. Crear `src/flows/<nombre>.flow.json` (mismo formato que magic-link).
2. Agregar `import` + entry al mapa `FLOWS` en `src/lib/flows.js`.
3. `runFlow('<nombre>', payload, env, ctx)` desde donde corresponda.

**Política de envío de emails — Fase 4+**: `sendMagicLinkViaFlow` /
`sendAppMagicLinkViaFlow` SIEMPRE invocan `runFlow`. El gate dev/prod vive
en `HTMLBOX_EMAIL_MODE` que lee el nodo `cloudflare-email` del flow-engine:
- `prod` → `env.EMAIL.send(...)` (real, llega al inbox).
- `dev`  → solo loguea el link (dry-run).

En dev (`.dev.vars`) actualmente `HTMLBOX_EMAIL_MODE=prod` → el email SÍ
llega al inbox en local. Para volver a dry-run temporal sin tocar
`.dev.vars`, override en CLI:
```bash
npx wrangler dev --remote --port 8781 --var HTMLBOX_EMAIL_MODE:dev
```

El gate **Fix 3** en `routes/auth.js` decide si el `_dev_preview` se filtra
en la respuesta según `HTMLBOX_ENV`. En prod (`HTMLBOX_ENV=production`)
el previewLink es `undefined` aunque se envíe el email — sin leak del
magic link. En dev, `_dev_preview` se muestra en la SPA para DX.

Para testear un flow via curl:
```bash
curl -X POST http://controlplane.localhost:8781/api/flows/<path-del-http-in>   -H "Content-Type: application/json" -d '{...}'
```

**Monkey-patch de ctx.tenantId / ctx.projectId**: el nodo `cloudflare-email`
upstream requiere ambos. Como el control-plane es single-tenant en dev,
no se setean en ninguna capa todavía. `lib/flows.js::ensureCloudflareEmailPatched()`
envuelve el `execute` del nodo y los inyecta como `'single-tenant-dev'`.
Forward-compat: cuando `createFlowEngineApp` acepte defaults, ese patch
se vuelve trivial de remover.

### Schema
- Box schema se aplica con `applyBoxSchema()` desde `packages/shared/src/boxSchema.js`.
- App-users schema se aplica on-demand con `applyAppUsersSchema()` — la
  primera vez que el tenant abre la tab Usuarios, se crea automáticamente.
- `ensureColumn()` para agregar columnas a tablas existentes sin `ADD COLUMN
  IF NOT EXISTS` (que SQLite no soporta). Usa `PRAGMA table_info` para chequear.

### Versioning
- Cada push crea nueva versión. Si hay >5, se purga la más vieja.
- `recordVersion` + `purgeIfOverLimit` viven en `packages/shared/src/versioning.js`.
- El `apply` de IA usa estos directamente (no usa el baile de presigned-URL —
  escribe a R2 directo porque el writer es el Worker, no el browser).

## 8. Tests — convenciones

- **Sin DB real**: tests mockean `globalThis.fetch` para llamadas a control-plane
  y al Turso client. Los routers tienen gates de auth que cortan antes de tocar
  DB — los tests suelen ejercitar esos gates (401/403/404) sin necesitar DB.
- **Funciones puras**: tests directos sin mock (cookie builders, extractores, etc.).
- **Vitest e2e**: en `packages/control-plane/__tests__/` con `cloudflare:test`.
  Usa miniflare, monta migrations en `MIGRATIONS` array dentro de cada test
  file. Si agregás una migración nueva, hay que actualizar el array del test
  afectado.
- **No commitear tests rojos**: si un test falla por una migración nueva,
  agregá la columna/migration al MIGRATIONS del test (ver `ai.test.js` linea
  ~59 como ejemplo de `candidates_json`).

## 9. Seguridad — reglas duras

- **NUNCA `eval()`, `new Function()`, ni `vm.runInNewContext()`** sobre código
  del tenant. El extractor de arrays usa solo regex + `JSON.parse()` sobre
  texto literal — si no es JSON válido, se descarta.
- **NUNCA ejecutar código del tenant del lado del servidor** (mismo principio
  que el resto del proyecto).
- Cookies siempre `HttpOnly` + `SameSite=Lax` (o `Strict` cuando aplique).
- `Secure` flag: `HTMLBOX_COOKIE_SECURE=true` en prod, omitir en localhost.
- `Domain` solo cuando hay dominio padre registrable (`.sivocloud.dev` en
  prod). En dev (`*.localhost`) NO usar Domain — host-only.
- Internal endpoints SIEMPRE gateados por `X-HTMLBox-Internal-Secret` (ver
  `requiresInternalSecret` en `routes/internal.js`).
- Magic links: `AUTH_REQUEST_WINDOW_SEC=60`, `AUTH_REQUEST_MAX_PER_EMAIL=3`.

### Gate de `_dev_preview` (NEVER leak prod)

**Regla**: nunca devolver `_dev_preview` (que contiene el magic link) en
respuestas de endpoints `/api/auth/*` o `/api/internal/tenant-app-auth/*`
cuando `env.HTMLBOX_ENV === 'production'`. La razón: si el envío de email
falla en prod (modo `prod-fallback`), el preview seguiría siendo el token
del magic link — bypass de auth completo (cualquiera puede pedir el link
de cualquier email y obtenerlo en la respuesta HTTP).

**Implementación**: ambas rutas (`routes/auth.js::postRequest` y
`routes/internal.js::postTenantAppRequest`) gatean `includePreview` con
`!isProd && previewLink != null`. En dev (HTMLBOX_ENV='development' | 'dev'
| undefined) el preview sigue funcionando para el ciclo de feedback.
En prod la respuesta es literal `GENERIC_RESPONSE` (= `{ ok, message }`)
sin campos de dev.

**SI ves un endpoint de auth exponiendo `_dev_preview` en prod: es un
bug de seguridad**. Reference test:
`packages/control-plane/src/__tests__/authPreviewGating.test.js`.

## 10. Sandbox / environment

- **Push a GitHub NO funciona desde el sandbox**: el sandbox resuelve DNS pero
  el TCP es rechazado. El usuario hace `git push` desde su máquina local.
- **Wrangler dev SÍ corre** si hay auth (`wrangler login` o `CLOUDFLARE_API_TOKEN`).
- **`wrangler dev` abre puertos locales**: 8781/8782/8783/8784/8785/8786 + 9229/9230/9231/9232/9235/9236 (inspector).
  Si hay conflicto, `dev.sh` los limpia al inicio.

## 11. NO hacer

- **NO** pushear a github.com desde el sandbox.
- **NO** hacer `eval()`/`new Function()` sobre código del tenant (regla de
  oro, ver §9).
- **NO** usar `fetch()` crudo en el portal — usar `apiFetch()` global.
- **NO** usar `WHERE box_id = ?` en queries del box — el aislamiento es la DB
  física.
- **NO** hacer `Path=/` en cookies de app-user (fase 1/2) — usar
  `cookiePathForBox()` para scope por box.
- **NO** commitear el archivo `.dev.vars` — tiene secretos locales.
- **NO** agregar dependencias sin chequear que ya esté en el package.json de
  algún workspace (los workspaces ya comparten `node_modules` arriba).
- **NO** mover la lógica de emails a runtime — runtime no tiene binding MAIL,
  delega a control-plane vía `POST /api/internal/send-app-magic-link`.
- **NO** marcar un spec como `-IMPLEMENTED` si no está al 100% con tests
  verde. El sufijo `-IMPLEMENTED` es contrato.

## 12. Si hay algo que no entiendo

Probá en este orden:

1. ¿Está en `README.md`? Topología, setup, comandos.
2. ¿Está en `arquitectura.md`? Decisiones de diseño, layout R2, multi-tenancy.
3. ¿Está en un `htmlbox-spec-*-IMPLEMENTED.md`? Features ya implementadas con
   contratos exactos.
4. ¿Está en un `htmlbox-spec-*.md` (sin sufijo)? Features planeadas, ver §6.
5. ¿Está en el código? `grep -rn` es tu amigo. Tests en `__tests__/` suelen
   mostrar ejemplos de uso esperado.

Si nada contesta: pregunta al usuario. NO inventes contratos que no estén
documentados.