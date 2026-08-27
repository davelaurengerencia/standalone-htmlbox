# HTMLBox — Arquitectura real sobre Cloudflare

> "Crea tu dashboard con IA. Súbelo a HTMLBox. Conecta tus datos. Automatiza tu negocio."

Documento de decisiones de arquitectura para la plataforma HTMLBox: runtime y
publicador en la nube para dashboards/apps HTML generados con IA (ChatGPT,
Claude, Gemini), con datos separados por box, automatización vía flow-engine
y multi-tenancy completa.

Base de referencia: la plataforma `sivocloud` (misma cuenta Cloudflare) ya
tiene probado en producción el patrón control-plane / data-plane /
tenant-portal sobre Workers + D1 + R2 con auth magic-link — esta arquitectura
porta esos patrones y los adapta al producto HTMLBox, que vive standalone.

---

## 1. Visión y principios

1. **Cero infraestructura para el usuario**: nada de servidores, dominios,
   CORS, despliegues ni Cloudflare visible. Crear HTML con IA → arrastrar →
   enlace para compartir.
2. **Datos separados por box (lo primordial)**: cada HTML Box tiene su propia
   base de datos física. Ni boxes de otros tenants, ni otros boxes del mismo
   tenant, comparten base.
3. **Evolución transparente**: un archivo plano (CSV/Excel) subido hoy puede
   convertirse mañana en tablas consultables sin que el HTML cambie ni el
   usuario escriba SQL.
4. **La ingesta de datos NO siempre es sync**: el modo default es subir
   archivos manualmente para refrescar datos. El sync con sistemas externos
   es opcional y por box.
5. **Automatización como segunda fase del box**: tareas programadas, reportes,
   alertas (email/WhatsApp), sincronización con Google Sheets, agentes — todo
   vía flow-engine.
6. **MCP first**: cada box expone capacidades vía Model Context Protocol para
   agentes externos (Claude Cowork, ChatGPT Work, Gemini Spark…) — no solo
   consulta: los agentes pueden subir/actualizar el HTML y los datos del box,
   de modo que el usuario sigue editando con su agente mientras ve los
   cambios en vivo en HTMLBox (§11).
7. **Todo el UI en Alpine.js** (portal de tenant y panel admin).

---

## 2. Topología — 3 Workers + recursos

Producto standalone en `_standalone/htmlbox/` (repo propio, dominio propio).
Se reutilizan **patrones** de sivocloud, no sus Workers.

| Worker | Dominio | Responsabilidad |
|---|---|---|
| `htmlbox-control-plane` | `controlplane.htmlbox.dev` | Registry de tenants/workspaces/boxes, auth, billing, **aprovisionamiento de la Turso DB de cada box**, panel admin (Alpine) |
| `htmlbox-portal` | `portal.htmlbox.dev` | Tenant Portal (Alpine): crear/subir boxes, gestionar datos y automatizaciones, compartir, permisos |
| `htmlbox-runtime` | `*.htmlbox.dev` | Sirve el HTML de cada box (desde R2), Data API del box, ejecuta flows (flow-engine), webhooks de ingesta, endpoint MCP |

Recursos:

| Recurso | Nombre | Uso |
|---|---|---|
| Cloudflare D1 | `htmlbox-control-plane` | Metadatos: tenants, workspaces, boxes, users/sesiones, memberships, flows, tokens, auditoría |
| Turso | una DB por box: `htmlbox-box-{boxId}` | **Datos de cada box** (lo primordial) |
| R2 | bucket `htmlbox-content` | HTML de los boxes (**historial de las últimas 5 versiones** por box), archivos de datos originales subidos — todo separado por namespace de tenant (ver layout abajo) |
| KV | namespace `htmlbox-cache` | Caché opcional de lecturas calientes (snapshots de tablas) |

### Layout de R2 — namespaces por tenant

Un solo bucket `htmlbox-content`, separado estrictamente por tenant y luego
por box. El prefijo de tenant en la key permite listar, auditar, medir cuota
y eliminar todo lo de un tenant con un solo prefijo.

```
htmlbox-content/
└── tenants/{tenantSlug}/
    ├── boxes/{boxId}/
    │   ├── versions/v{1..5}.html          # historial del HTML (últimas 5)
    │   ├── uploads/{fileId}/{filename}    # originales de datos subidos
    │   └── assets/{path}                  # imágenes/css/js extra del box
    └── _exports/{runId}/{filename}        # reportes/exportes generados por flows
```

Reglas:

- Las keys las construye **siempre el servidor** (control plane al firmar
  presigned URLs, runtime al leer) a partir del tenant resuelto de la sesión
  — el cliente jamás compone el path. Contención de `../` con el mismo patrón
  `namespacedKey()` de sivocloud (`control-plane/UPLOAD-DESIGN.md`): un
  intento de escape queda contenido dentro del prefijo del propio box.
- `boxId` es globalmente único, pero el namespace de tenant va igual en la
  key — aislamiento explícito, no implícito.

Regla de nombres: **todo recurso lleva el prefijo `htmlbox-`** (Workers, D1,
R2, KV, DBs Turso, secrets, nodos/flows, dominios). Ninguna excepción.

---

## 3. Multi-tenancy

Jerarquía:

```
tenant (empresa/organización)
└── workspaces (espacios de trabajo, estilo Google Drive)
    └── boxes (HTML Boxes — cada uno con su Turso DB)
```

Roles por workspace/box (tabla `htmlbox_memberships`):

| Rol | Puede |
|---|---|
| **Propietario** (owner) | Todo: administrar miembros, billing, borrar boxes |
| **Editor** | Crear/editar boxes, subir datos, configurar automatizaciones |
| **Lector** | Ver boxes compartidos con él (y los públicos, cualquiera) |

**Auth**: se porta el sistema de sivocloud tal cual (`control-plane/auth.js`,
`migrations/0003_auth.sql`): magic-link por email (sin passwords), sesión
cookie `sid` HttpOnly con `Domain=.htmlbox.dev` para compartir sesión entre
los 3 Workers, rate-limit por email, respuesta genérica anti-enumeración,
2 pasos para consumir el link (anti-scanners).

Scoping: el `tenant_id` se resuelve SIEMPRE server-side desde la sesión —
nunca desde parámetros del cliente.

---

## 4. Datos separados: una Turso DB por HTML Box

### Por qué Turso y no D1 para los datos de los boxes

Se evaluó D1 por box: Cloudflare soporta el patrón (50,000 DBs por cuenta,
escalable a millones), PERO los bindings D1 de un Worker son estáticos —
una DB creada dinámicamente por box solo se puede consultar vía el REST API
de Cloudflare, que tiene rate-limit global de cuenta (~1,200 req/5 min,
compartido con todas las operaciones de la API) y la propia doc lo marca como
"best suited for administrative use". Para servir dashboards en producción no
alcanza.

Turso resuelve exactamente esto:

- **Aprovisionamiento dinámico**: la Platform API crea bases on-demand
  (`POST /v1/organizations/{org}/databases`) — flow-engine YA tiene esta
  lógica en el nodo `turso-admin` (`nodes/nodes-turso/admin.js`).
- **Acceso en runtime sin bindings**: `@tursodatabase/serverless` es fetch
  puro — el Worker conecta a la DB del box con URL+token resueltos del
  registry, sin configuración estática. Corre igual en Node y en Workers.
- **Sin rate-limit de API en el data path** (a diferencia del REST de D1).
- **Réplicas de lectura en el edge**: lecturas servidas cerca del Worker.
- **Precedente interno**: sivocloud ya corre datos de negocio sobre Turso
  con el nodo `turso` (migraciones versionadas) y el patrón FlexDB.

D1 se queda para lo que sí le corresponde: metadatos del control plane
(pocas escrituras, bindings estáticos, una sola DB).

### Aprovisionamiento (al crear un box)

El control plane, al crear un box:

1. `createDatabase` → `POST /v1/organizations/{org}/databases` con
   `{ name: "htmlbox-box-{boxId}", group: "htmlbox" }` → devuelve hostname.
2. `createToken` → genera el JWT de ESA base (full-access para el runtime).
3. Guarda en el D1 `htmlbox-control-plane`:
   `htmlbox_boxes.turso_db_url` (`libsql://<hostname>`) y
   `htmlbox_boxes.turso_db_token` (solo lo lee el control plane y el runtime;
   jamás llega al browser).
4. Aplica el **schema base del box** (conexión directa con el token recién
   creado).

Opcional: un segundo token **read-only** por box para el SDK de boxes
públicos (ver §10).

### Schema base dentro de cada DB (se aplica solo, al crear el box)

```sql
-- Registro de "hojas"/tablas del box (patrón FlexDB adaptado)
CREATE TABLE htmlbox_tables (
  slug TEXT PRIMARY KEY,            -- ej. "ventas"
  name TEXT NOT NULL,
  columns_json TEXT NOT NULL,       -- [{name, type}]
  mode TEXT NOT NULL DEFAULT 'manual',  -- 'manual' | 'sync' | 'webhook'
  flow_id TEXT,                     -- si mode='sync', qué flow la alimenta
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bitácora de cambios de esquema (auditoría, no bloquea nada)
CREATE TABLE htmlbox_schema_log (
  version INTEGER PRIMARY KEY AUTOINCREMENT,
  table_slug TEXT NOT NULL,
  action TEXT NOT NULL,             -- createTable | addColumn | removeColumn | replace
  detail TEXT,
  snapshot_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Historial de archivos subidos / refreshes
CREATE TABLE htmlbox_files (
  id TEXT PRIMARY KEY,
  table_slug TEXT NOT NULL,
  filename TEXT NOT NULL,
  kind TEXT NOT NULL,               -- csv | xlsx | json
  rows INTEGER NOT NULL DEFAULT 0,
  strategy TEXT NOT NULL,           -- replace | upsert
  r2_key TEXT NOT NULL,             -- original archivado en R2
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Historial de corridas de flows (syncs, automatizaciones)
CREATE TABLE htmlbox_runs (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  status TEXT NOT NULL,             -- ok | error
  summary TEXT,
  ran_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Cada hoja = tabla física propia (no una tabla compartida):
--   htmlbox_<slug> ( id INTEGER PRIMARY KEY AUTOINCREMENT,
--                    data_json TEXT NOT NULL DEFAULT '{}',
--                    created_at, updated_at, deleted_at )
-- Mismo patrón que FlexDB: tabla física por hoja deja la puerta abierta a
-- promover un campo JSON a columna real indexada sin tocar las demás hojas.
```

### Dev local

El driver `@tursodatabase/serverless` es SIEMPRE remoto (no soporta
`file:./x.db`), así que para desarrollo local hay dos opciones (documentar
ambas en el README del proyecto):

- `turso dev` (servidor sqld local en `http://localhost:8080`) — una DB local
  por developer; el runtime apunta ahí con `TURSO_DEV_URL`/`TURSO_DEV_TOKEN`.
- Una DB Turso real de desarrollo (`htmlbox-dev-{developer}`).

El control plane en dev usa `wrangler dev` con D1 local; el flag
`HTMLBOX_TURSO_MODE=local|cloud` conmuta el aprovisionamiento.

---

## 5. Data path en runtime (cómo el HTML habla con sus datos)

```
HTML del box (browser)
   │  window.HTMLBox.table('ventas').rows()
   ▼
htmlbox-sdk.js (inyectado al servir el HTML)
   │  fetch con el boxId + token del box (read-only o sesión)
   ▼
htmlbox-runtime Worker
   │  resuelve credenciales del box desde el registry (server-side)
   │  connect({ url, authToken })  ← @tursodatabase/serverless
   ▼
Turso DB htmlbox-box-{boxId}        (+ KV htmlbox-cache opcional)
```

- El cliente **nunca** ve la URL/token de Turso ni puede referenciar otra DB:
  el runtime resuelve todo desde `boxId` contra el registry del control plane.
- **KV (`htmlbox-cache`) es opcional**: con Turso ya no es obligatorio
  (a diferencia del diseño con D1 REST). Se usa solo si un dashboard
  demuestra lecturas calientes repetitivas: snapshots JSON de tablas
  regenerados en cada refresh de datos, TTL corto.

### SDK (`window.HTMLBox`)

Se sirve desde el runtime (`/_sdk/htmlbox.js`) y se inyecta al HTML al
momento de publicarlo. API mínima:

```js
await HTMLBox.table('ventas').rows({ limit, offset, where })  // lectura
await HTMLBox.table('ventas').columns()                       // esquema
await HTMLBox.table('ventas').upsert(rows)                    // escritura (rol editor+)
await HTMLBox.table('ventas').onChange(cb)                    // polling suave (v1)
await HTMLBox.flow('refresh-ventas').run()                    // disparar flow
```

Este desacople es la clave de la "evolución transparente": el HTML siempre
habla con `HTMLBox.table(...)` — si detrás hay un CSV subido a mano, un sync
programado o un webhook, no cambia nada en el HTML.

---

## 6. Ingesta de datos — 3 modos por tabla

Cada tabla/hoja de un box declara su `mode`. El modo default es A — **sync
nunca es obligatorio**.

### A. Subida manual (refresh) — default

1. El usuario arrastra CSV/XLSX/JSON en el portal (tab "Datos" del box).
2. Parseo: **CSV y JSON en el Worker** (parser liviano); **XLSX en el
   browser** con SheetJS (CDN) → se mandan las filas ya como JSON (evita
   meter un parser pesado de Excel en el Worker).
3. Estrategia elegida por el usuario: **replace** (borra y recarga la tabla)
   o **upsert** (por columna clave).
4. El runtime escribe en la Turso DB del box (batch/transacción), archiva el
   original en R2 (`tenants/{tenantSlug}/boxes/{boxId}/uploads/{fileId}/...`),
   registra en `htmlbox_files`, invalida caché KV si existe.
5. Re-subir un archivo a la misma tabla = refresh — es el flujo cotidiano.

### B. Sync con sistemas externos — opcional, vía flow-engine

Un flow por box con trigger `schedule` (cron) o manual:

```
schedule → http-request / shopify-* / paddle-* / nodes-dian
        → transform (JSONata) → nodo htmlbox-turso (escrite a la DB del box)
        → htmlbox_runs (bitácora)
```

La tabla queda con `mode='sync'` + `flow_id` — el portal muestra el estado
del último sync y botón "Correr ahora".

### C. Push por webhook/API — opcional, vía flow-engine

Sistemas externos hacen POST directo:

```
https://{tenant}.htmlbox.dev/{boxSlug}/api/ingest/{tabla}
```

Flow con `http-in` → validación (token de ingesta del box) → `transform` →
escritura. Para cuando el sistema origen puede empujar (ERPs, otras apps).

---

## 7. flow-engine como backend (automatización)

Decisión central: **todo lo que corre detrás de un box corre en flow-engine**.

### Integración

- `createFlowEngineApp({ runtime: 'worker' })` — el modo worker YA está
  probado en workerd (`tests/worker/`) y el data-plane de sivocloud ya
  demuestra el patrón completo: flows leídos de DB, webhooks reales,
  bindings a `ctx.platformBindings`.
- Los flows de cada box viven en el D1 del control plane
  (`htmlbox_flows`, con `box_id`) — mismo formato `flow.json` de siempre.
- El `htmlbox-runtime` monta una instancia lógica por request: resuelve el
  box por host+path, carga sus flows, inyecta contexto y corre el motor.

### Contexto inyectado por el runtime (seguridad)

```js
ctx.boxId, ctx.tenantId, ctx.workspaceId   // resueltos del registry, NUNCA del request
ctx.platformBindings.htmlboxDb             // cliente Turso YA scopingado a la DB del box
ctx.platformBindings.BUCKET                // R2 htmlbox-content
ctx.platformBindings.CACHE                 // KV htmlbox-cache
```

El autor de un flow no puede apuntar a otra DB ni a otro box — mismo
principio que `cloudflare-d1.js` aplica con `project_id`.

### Nodos nuevos (`_flow-engine/nodes/nodes-htmlbox/`)

| Nodo | Qué hace |
|---|---|
| `htmlbox-turso` | Operaciones estructuradas (listTables/select/insert/upsert/replaceTable) contra la DB del box vía `ctx.platformBindings.htmlboxDb`. Sin SQL libre para el usuario no técnico (el editor de flows sí puede usar el nodo `turso` genérico) |
| `htmlbox-snapshot` | Regenera/invalida snapshots KV tras cambios (si la caché está activa) |
| `htmlbox-csv-parse` | Convierte CSV (string o archivo de R2) en array de filas para ingesta |

Se **reutilizan sin cambios**: `http-in`/`http-response` (webhooks de
ingesta y endpoints del box), `schedule` (reportes programados, syncs),
`transform` (JSONata — **obligatorio en runtime worker**, el nodo `function`
NO corre en workerd), `template`, `switch`, `split`/`join`, `catch`,
`cloudflare-email` (reportes/alertas por correo), `cloudflare-r2`,
`shopify-*`, `paddle-*`, `nodes-dian`.

### Cron maestro

Los cron triggers de Cloudflare están limitados por cuenta (250). Patrón:
**un solo cron trigger** en `htmlbox-runtime` (cada minuto) que consulta en
el registry qué flows `schedule` vencen en este minuto (por tenant y por
box) y los despacha. Los horarios de cada flow viven en el control plane, no
en wrangler.

---

## 8. Tenant Portal (Alpine.js)

`htmlbox-portal` sirve una SPA **Alpine.js 3 vía CDN** (mismo patrón que
`sivocloud/tenant-portal/ui/index.html`, cero build) + el editor de flows
vanilla de flow-engine montado por box.

Pantallas:

1. **Mis Boxes** — lista por workspace, botón "Nuevo HTML Box", drag & drop
   global de `.html` (crea box) y `.csv/.xlsx/.json` (se vincula como datos).
2. **Detalle de box** con tabs:
   - **Vista previa** — iframe sandbox del HTML publicado.
   - **Editor HTML** — textarea/código + guardar; cada guardada genera una
     versión (se conservan las últimas 5, con restore — §11.2).
   - **Datos** — tablas del box, subida manual (modo A), historial de
     archivos (`htmlbox_files`), modo de cada tabla (manual/sync/webhook),
     preview de filas.
   - **Automatizaciones** — lista de flows del box, editor de flows
     (`flows-editor`), historial de corridas (`htmlbox_runs`).
   - **Compartir** — link público, visibilidad, roles por usuario.
   - **MCP** — endpoint del box, API keys con scopes, y el bloque de
     configuración listo para pegar en Claude Cowork / ChatGPT Work /
     Gemini Spark (§11).
3. **Workspace** — miembros y roles.
4. **Preferencias** — tokens de API, perfil.

---

## 9. Control Plane (Alpine.js)

`htmlbox-control-plane` — panel del owner de la plataforma (mismo estilo que
el control plane de sivocloud, Alpine via CDN):

- Tenants y workspaces (crear, suspender).
- Boxes por tenant: estado, DB Turso asociada, almacenamiento.
- Usuarios y sesiones activas.
- Planes/billing (cajas por plan: nº boxes, filas, storage R2) — integración
  con Paddle en fase posterior (ya hay nodos `paddle-*` y precedentes en
  sivocloud).
- Auditoría global (quién creó/borró qué).
- Operación: re-aplicar schema base, regenerar tokens, ver límites.

---

## 10. Publicación y seguridad

### Tipos de publicación

| Tipo | URL | Acceso |
|---|---|---|
| **Público** | `https://htmlbox.dev/s/{shareId}` | Cualquiera con el link. SDK corre con token **read-only** de esa DB embebido al servir el HTML. Landing pages, reportes públicos |
| **Privado** | `https://{tenant}.htmlbox.dev/{boxSlug}` | Requiere sesión + rol ≥ Lector. Escrituras requieren Editor+. ERPs, CRMs, herramientas internas |

> Privados también funcionan sin wildcard DNS: `https://htmlbox.dev/t/{tenantSlug}/{boxSlug}` (path-based fallback).

### Aislamiento

- El HTML de usuario (potencialmente no confiable) se sirve en el dominio de
  runtime (`*.htmlbox.dev`), **nunca** en `portal.htmlbox.dev` ni
  `controlplane.htmlbox.dev` — el sandbox del navegador aísla cookies/storage
  por origen.
- Preview dentro del portal: `<iframe sandbox>` (sin `allow-same-origin`
  sobre el origen del portal).
- Respuestas del runtime con `Content-Security-Policy` base + cabeceras de
  aislamiento (`Cross-Origin-Opener-Policy` etc.) para boxes públicos.

### Subidas de archivos

Patrón ya diseñado y probado en sivocloud (`control-plane/UPLOAD-DESIGN.md`):
**presigned URLs a R2** (el Worker solo firma, los bytes no pasan por él).
La key firmada SIEMPRE incluye el namespace del tenant resuelto de la sesión
(`tenants/{tenantSlug}/boxes/{boxId}/...`) — un tenant no puede firmar ni
leer keys de otro (ver layout en §2). Whitelist de content-types,
sanitización/contención de paths (`../`), límite de tamaño por request.

### Secrets

`HTMLBOX_TURSO_PLATFORM_TOKEN`, `HTMLBOX_SESSION_SECRET`,
`HTMLBOX_R2_ACCESS_KEY_ID` / `HTMLBOX_R2_SECRET_ACCESS_KEY` — vía
`wrangler secret`, nunca en el repo.

---

## 11. MCP por box — el box como workspace de agentes

El MCP no es solo de consulta: es el **canal de autoría** de HTMLBox.
Agentes externos (Claude Cowork, ChatGPT Work, Gemini Spark, Copilot, etc.)
pueden **subir y actualizar el HTML del box**, cargar archivos de datos,
consultar tablas y conectar APIs — así el usuario sigue iterando con su
agente de preferencia mientras **ve los cambios en vivo en HTMLBox** (el
agente pushea → el usuario refresca el link del box).

Endpoint en el runtime: `https://{tenant}.htmlbox.dev/{boxSlug}/mcp`
(Streamable HTTP; variante pública del box usa su API key).

### 11.1 Auto-documentación: el agente entiende HTMLBox antes de actuar

El servidor MCP se explica a sí mismo (los agentes no conocen el producto de
antemano):

- **`instructions` del servidor** (campo estándar MCP): resumen de qué es
  HTMLBox, el ciclo "crear → subir → conectar datos → automatizar", y las
  reglas duras: HTML autocontenido, datos vía `window.HTMLBox` (nunca
  fetch directo a archivos), **versionado obligatorio — se conservan las
  últimas 5 versiones**, cada push requiere `summary`.
- **Tool `htmlbox_guide()`** — devuelve la guía completa en markdown:
  conceptos (box, tablas, modos de ingesta manual/sync/webhook), cómo usar
  el SDK en el HTML, límites (tamaño, sin credenciales embebidas), cómo
  conectar APIs externas vía flows, y el contrato de versionado. Es la
  primera tool que un agente debe llamar.
- **Tool `get_box_status()`** — estado actual del box: versión activa del
  HTML + historial, tablas y sus modos, flows existentes, URL pública/privada
  para que el agente se la devuelva al usuario tras cada cambio.
- **Resources MCP** (lectura declarativa): `box://guide`,
  `box://html/current`, `box://tables/{slug}/schema`, `box://flows`.

### 11.2 Tools de HTML (autoría versionada)

| Tool | Qué hace |
|---|---|
| `get_html(version?)` | HTML actual (o de una versión dada) |
| `push_html(content, summary)` | Sube/actualiza el HTML del box. Genera una **nueva versión**, valida tamaño/sintaxis básica, invalida caché y devuelve la URL del box + nº de versión |
| `list_versions()` | Historial: versión, quién/cuándo (agente, usuario, flow), summary |
| `get_version(n)` | Contenido de una versión histórica |
| `rollback(version)` | Restaura una versión anterior (genera una nueva versión, nunca destruye historial) |

**Versionado — regla fija: se conservan las últimas 5 versiones.**

- Cada push (portal, drag&drop o MCP) genera una versión.
- Storage: R2 `tenants/{tenantSlug}/boxes/{boxId}/versions/v{n}.html` +
  metadata en D1 del control plane (`htmlbox_versions`: version, source
  `portal|agent|api`, agent name, summary, created_at). Al superar 5, la más
  antigua se purga.
- El box publicado sirve siempre la versión activa con header
  `X-HTMLBox-Version: {n}` y sin caché agresiva — el agente le dice al
  usuario "refresca" y ve el cambio al instante.
- El tab Editor HTML del portal muestra el historial (5 versiones) con
  restore, mismo backend.

### 11.3 Tools de datos

| Tool | Qué hace |
|---|---|
| `list_tables()` / `describe_table(slug)` | Esquema del box |
| `query_table(slug, where?, limit?)` | Lectura estructurada |
| `upload_data_file(slug, filename, file_base64, strategy)` | El agente sube CSV/XLSX/JSON que el usuario quiera ver/trabajar en el box — mismo pipeline que la subida manual del portal (§6A: replace/upsert, original archivado en R2, registro en `htmlbox_files`) |
| `upsert_rows(slug, rows, key?)` | Escritura directa de filas (agentes que ya traen los datos estructurados) |

### 11.4 Tools de automatización y conexión a APIs

Los agentes también saben que un box **puede conectarse a APIs externas**:

| Tool | Qué hace |
|---|---|
| `list_flows()` / `run_flow(flowId)` | Ver y disparar automatizaciones del box |
| `create_sync_flow(spec)` | Crea un flow de sync desde una especificación declarativa (fuente: URL/API + auth, schedule, tabla destino, mapeo) — el runtime lo traduce a nodos flow-engine (`schedule`/`http-request` → `transform` → `htmlbox-turso`). El agente conecta el box a la API que el usuario pida sin tocar el editor visual |
| `get_run_history(flowId)` | Bitácora de corridas (`htmlbox_runs`) |

### 11.5 Auth y scopes

API key por box (tabla `htmlbox_api_tokens`, patrón `0009_api_tokens.sql` de
sivocloud). Scopes:

| Scope | Permite |
|---|---|
| `read` | guía, estado, schemas, queries, `get_html` |
| `write_html` | `push_html`, `rollback` |
| `write_data` | `upload_data_file`, `upsert_rows` |
| `execute` | `run_flow`, `create_sync_flow` |

El tab MCP del portal genera la key con los scopes que el dueño elija y
muestra el bloque de configuración listo para pegar en Claude Cowork,
ChatGPT Work o Gemini Spark. Cada push queda auditado con el nombre del
agente y la API key usada (tabla `htmlbox_versions.source`/`agent`).

---

## 12. Fases de implementación

| Fase | Entregable |
|---|---|
| **1. Fundación** | Monorepo `_standalone/htmlbox/` (3 Workers), D1 `htmlbox-control-plane` + migraciones (tenants/workspaces/users/sessions/memberships), auth portada, panel admin mínimo, portal skeleton Alpine |
| **2. Boxes** | Crear box → provisión Turso (createDatabase+createToken+schema base) + registry; subir HTML (presigned R2); servir box público/privado; preview; **versionado de HTML (últimas 5 versiones)** |
| **3. Datos** | SDK `window.HTMLBox`; tab Datos del portal; subida manual CSV/XLSX/JSON con replace/upsert; historial `htmlbox_files`; KV opcional |
| **4. Automatización** | flow-engine en el runtime (modo worker); nodos `nodes-htmlbox/`; flows por box desde el portal; cron maestro; syncs externos; webhooks de ingesta |
| **5. Colaboración** | Roles editor/lector funcionales, invitaciones, auditoría, historial de cambios |
| **6. MCP + canales** | Endpoint MCP por box como **canal de autoría** (agentes suben/actualizan HTML, datos y flows — §11), API keys/scopes; reportes programados por email; (posterior: WhatsApp, Google Sheets) |

---

## 13. Riesgos y límites conocidos

| Riesgo | Mitigación |
|---|---|
| Cupo de DBs del plan Turso (free: limitado) | Plan pago de Turso para producción; nombre `htmlbox-box-*` permite listar/depurar por prefijo |
| Token Turso de la DB en el registry (D1) | Cifrado de campos sensibles en etapa posterior (mismo debt documentado en sivocloud); acceso solo control-plane/runtime con sesión |
| 250 cron triggers por cuenta (Cloudflare) | Un solo cron maestro que despacha desde el registry (§7) |
| XLSX pesado en el browser | Límite de filas por subida; chunking de inserts hacia Turso |
| Nodo `function` de flow-engine no corre en workerd | Flows de producción con `transform` (JSONata) — documentado en el portal al elegir nodo |
| HTML de usuario malicioso | Aislamiento de origen (§10), sandbox en previews, CSP; el HTML no tiene credenciales de escritura si el box es público |
| Crecimiento de tablas por box | Límites por plan (filas/storage); la DB por box ya es el shard natural |
| Pérdida de una DB Turso | Backups: Turso permite duplicar DBs; job periódico del control plane para boxes pagos (fase 5+) |
| Agente MCP pushea HTML roto | Versionado (últimas 5) + `rollback()` inmediato; validación básica de tamaño/sintaxis en `push_html`; scope `write_html` optativo por API key |

---

## Anexo: mapa de decisiones rápidas

| Decisión | Elección | Por qué |
|---|---|---|
| DB por box | Turso (`htmlbox-box-{boxId}`) | Aprovisionamiento dinámico + acceso sin bindings estáticos + sin rate-limit de API + réplicas edge |
| Metadatos | D1 `htmlbox-control-plane` | Una sola DB, bindings estáticos, patrón sivocloud |
| Backend de automatización | flow-engine (`runtime: 'worker'`) | Ya probado en workerd; nodos Turso/email/Shopify listos |
| UIs | Alpine.js 3 (CDN) | Cero build, mismo patrón que tenant-portal de sivocloud |
| Nombres | prefijo `htmlbox-` en TODO | Regla fija del producto |
| Ingesta default | Subida manual (refresh) | El usuario no técnico no siempre quiere sync |
| Caché | KV opcional | Con Turso no es obligatoria; se activa por necesidad medida |
| MCP | Canal de autoría bidireccional (§11) | Los agentes (Claude Cowork, ChatGPT Work, Gemini Spark) editan el box en vivo; el usuario itera desde su agente viendo cambios en HTMLBox |
| Versionado HTML | Últimas 5 versiones, toda mutación versiona | Regla fija del producto; rollback sin destruir historial; auditoría de quién (agente/usuario) cambió qué |
