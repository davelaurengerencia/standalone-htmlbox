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
(`{tenant}.htmlbox.dev/{boxSlug}`) y opcionalmente extrae los datos a una DB
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
│   ├── control-plane/  Worker D1-bound  — auth plataforma, registry, AI, internal API
│   ├── portal/         Worker reverse-proxy — SPA Alpine.js del tenant
│   └── runtime/        Worker box-local   — sirve HTML, Data API, app-auth
├── scripts/
│   ├── dev.sh          lanza los 3 workers en background con colores
│   └── migrate-remote.sh wrangler d1 migrations apply --remote
├── package.json        workspaces npm (packages/*)
└── htmlbox-spec-*.md   specs (las -IMPLEMENTED ya están implementadas)
```

| Worker | Puerto dev | Host dev | Modo wrangler |
|---|---|---|---|
| `htmlbox-control-plane` | 8781 | `controlplane.localhost` | `--remote` (necesita D1 real) |
| `htmlbox-portal` | 8782 | `portal.localhost` | `--local` |
| `htmlbox-runtime` | 8783 | `runtime.localhost` | `--local` |

**Por qué runtime/portal son `--local`** y no `--remote`: necesitan hacer
fetch a `controlplane.localhost` desde workerd local (cross-origin + subdominio
distinto). Si corrieran en `--remote`, el workerd estaría en el edge y no
podría resolver `controlplane.localhost`. El control-plane sí va en
`--remote` porque su D1 real solo está en Cloudflare.

## 3. Setup local

```bash
npm install                                  # una vez
cp packages/control-plane/.dev.vars.example packages/control-plane/.dev.vars
cp packages/portal/.dev.vars.example          packages/portal/.dev.vars
cp packages/runtime/.dev.vars.example         packages/runtime/.dev.vars
# editarlos con los secretos (HTMLBOX_INTERNAL_SECRET tiene que matchear en los 3)
npm run migrate:remote                        # aplica migrations D1 al control-plane
npm run dev                                   # levanta los 3 workers
```

Subdominios `*.localhost`: en macOS resuelven solos a 127.0.0.1. En Linux
hay que agregar a `/etc/hosts`.

## 4. Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | `bash scripts/dev.sh` — lanza los 3 workers con log tail mergeado |
| `npm run dev:control` / `:portal` / `:runtime` | Levanta UN worker solo (debug rápido) |
| `npm run migrate:remote` | Aplica migrations D1 remotas (`wrangler d1 migrations apply --remote`) |
| `npm test` | Corre tests de los 3 workspaces (control-plane: node + vitest, runtime/shared: node --test) |
| `npm test -w <pkg>` | Solo el workspace `<pkg>` |

### Tests por workspace
- **`packages/shared`** (`node --test __tests__/*.test.js`): constantes, validadores, schema, versioning
- **`packages/runtime`** (`node --experimental-test-module-mocks --test __tests__/*.test.js`): routers puros con fetch mockeado
- **`packages/control-plane`**: dos suites:
  - `npm run test:node` → `node --test src/__tests__/*.test.js` (unit tests de dataExtractor, session.js helpers, etc.)
  - `npm run test:e2e` → `vitest run` con `cloudflare:test` (e2e real con D1 en miniflare)

## 5. Convenciones

### Prefijos
- TODO recurso lleva `htmlbox-`: Workers (`htmlbox-control-plane`, `htmlbox-portal`, `htmlbox-runtime`), D1 (`htmlbox-control-plane`), R2 (`htmlbox-content`), KV (`htmlbox-cache`), Turso DBs (`htmlbox-box-{boxId}`), tablas (`htmlbox_*`), cookies (`hbx_*`), rutas (`/api/*`), paths de R2 (`tenants/{slug}/...`).
- Constantes en `packages/shared/src/constants.js` (re-exportadas por `@htmlbox/shared`).

### Auth
Tres cookies conviven, una por tipo de usuario — **distinto nombre, distinto scope**:

| Cookie | Scope | Path/Domain | Quién |
|---|---|---|---|
| `sid` | Path=/, Domain=.htmlbox.dev | cross-subdominio | usuario de PLATAFORMA (login en portal) |
| `hbx_app_sid` | Path=`/{boxSlug}` (o `/s/{shareId}`, `/t/{tenant}/{boxSlug}`) | host-only o Domain | CUSTOMER de un box (login en box publicado) |
| `hbx_tapp_sid` | Path=/, Domain=.htmlbox.dev | cross-box del tenant | usuario CENTRALIZADO del tenant (cruza boxes con un solo login) |

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
- `htmlbox-spec-debug-panel-IMPLEMENTED.md`
- `htmlbox-spec-migracion-apifetch-IMPLEMENTED.md`
- `htmlbox-spec-monaco-editor-IMPLEMENTED.md`
- `htmlbox-spec-partials-htmlrewriter-IMPLEMENTED.md`

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
- `Domain` solo cuando hay dominio padre registrable (`.htmlbox.dev` en
  prod). En dev (`*.localhost`) NO usar Domain — host-only.
- Internal endpoints SIEMPRE gateados por `X-HTMLBox-Internal-Secret` (ver
  `requiresInternalSecret` en `routes/internal.js`).
- Magic links: `AUTH_REQUEST_WINDOW_SEC=60`, `AUTH_REQUEST_MAX_PER_EMAIL=3`.

## 10. Sandbox / environment

- **Push a GitHub NO funciona desde el sandbox**: el sandbox resuelve DNS pero
  el TCP es rechazado. El usuario hace `git push` desde su máquina local.
- **Wrangler dev SÍ corre** si hay auth (`wrangler login` o `CLOUDFLARE_API_TOKEN`).
- **`wrangler dev` abre puertos locales**: 8781/8782/8783 + 9229/9230/9231 (inspector).
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