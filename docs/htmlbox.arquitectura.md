# HTMLBox — Cómo guarda y separa datos (Cloudflare, Turso, tokens, tenants)

Documento de referencia técnica. Explica, con archivo y línea de origen, cómo HTMLBox usa cada pieza de almacenamiento y cómo aísla tenants/boxes entre sí. Complementa `arquitectura.md` y `claude/htmlbox-revision-codigo.md` (en el proyecto SIVOCLOUD de Claude) con foco exclusivo en "dónde vive cada dato y quién puede tocarlo".

---

## 1. Mapa general de almacenamiento

HTMLBox usa **cuatro sistemas de almacenamiento distintos**, cada uno con un rol muy específico — no se solapan:

| Sistema | Qué guarda | Quién lo usa | Multi-tenant por |
|---|---|---|---|
| **D1** (`htmlbox-control-plane`) | Metadatos globales: tenants, users, workspaces, memberships, boxes, versiones (metadata), sesiones, magic links, API tokens | Solo el Worker `control-plane` | Columnas `tenant_id` / `workspace_id` |
| **R2** (`htmlbox-content`) | El HTML real de cada versión de cada box + uploads + assets + exports | `control-plane` escribe, `runtime` lee | Prefijo de key `tenants/{slug}/...` |
| **Turso** (una DB por box) | Los **datos** de negocio de cada box (tablas que crea el usuario/agente: CSV subidos, filas manuales, etc.) | `runtime` (Data API) lee/escribe; `control-plane` la aprovisiona | Una base de datos física por box (en modo `cloud`) |
| **KV** (`htmlbox-cache`) | Caché corto de resolución (shareId → box, tenant+slug → box, boxId → credenciales Turso) | `runtime` | Claves prefijadas, TTL 60–300s |

Ningún dato de negocio del usuario vive en D1 — D1 es puro "directorio" (quién es quién, qué box pertenece a quién, qué versión está activa). El contenido pesado (HTML, datos de tablas) vive en R2 y Turso.

---

## 2. D1 — el "directorio" central (`packages/control-plane/migrations/`)

D1 es una sola base SQLite gestionada por Cloudflare, **compartida por todos los tenants** (no hay un D1 por tenant). El aislamiento entre tenants es lógico, vía columnas, no físico:

- `htmlbox_tenants` — un row por tenant (cliente). `slug` es el subdominio (`acme` → `acme.sivocloud.dev`).
- `htmlbox_users` — usuarios de la plataforma. `tenant_id` puede ser `NULL`: eso marca al **platform owner** (el operador de HTMLBox, no un cliente — puede ver/crear cualquier tenant).
- `htmlbox_workspaces` — cada tenant puede tener varios workspaces (agrupan boxes). `tenant_id NOT NULL`.
- `htmlbox_memberships` — tabla puente `(user_id, workspace_id) → role`. El rol (`owner`/`editor`/`viewer`) se resuelve **por workspace**, no por tenant — un usuario puede tener roles distintos en distintos workspaces del mismo tenant.
- `htmlbox_boxes` — cada "box" (una app/dashboard HTML). Referencia tanto a `tenant_id` como a `workspace_id` (redundante a propósito, para queries directas). Acá vive:
  - `turso_db_url` / `turso_db_token` — credenciales de la base Turso de ESE box (ver §4). **El token se guarda en texto plano** — el propio código lo marca como deuda técnica: `-- texto plano por ahora (deuda §13)` en `0003_boxes.sql`.
  - `htmlbox_version` — número de la versión activa (apunta a un archivo en R2, ver §3).
  - `share_id` — id corto para la URL pública `/s/{shareId}` cuando `visibility='public'`.
- `htmlbox_versions` — historial de versiones (metadata: quién, cuándo, resumen). El contenido HTML en sí NO está acá, solo referencia lógica al `version` número — el archivo real está en R2.
- `htmlbox_sessions` / `htmlbox_magic_links` — auth (ver §5).
- `htmlbox_api_tokens` — API keys por box para acceso externo (ver §5).

**Cómo se separa un tenant de otro en D1**: cada query relevante filtra por `tenant_id` o `workspace_id`, y las funciones `assertTenantScope()` / `assertWorkspaceScope()` en `control-plane/src/lib/session.js` son el punto único donde se valida "¿este usuario puede tocar este tenant/workspace?" antes de cualquier lectura/escritura. No hay Row-Level Security nativa de D1 — el aislamiento depende 100% de que cada ruta llame a estas funciones (es decir, es responsabilidad del código de aplicación, no de la base).

---

## 3. R2 — el HTML real, versionado (`packages/shared/src/namespacedKey.js`)

Bucket único `htmlbox-content`, compartido por todos los tenants. El aislamiento es por **prefijo de key**, nunca por bucket separado:

```
tenants/{tenantSlug}/boxes/{boxId}/versions/v{1..5}.html   ← el HTML de cada versión
tenants/{tenantSlug}/boxes/{boxId}/uploads/{fileId}/{filename}
tenants/{tenantSlug}/boxes/{boxId}/assets/{path}
tenants/{tenantSlug}/_exports/{runId}/{filename}
```

Reglas de seguridad clave (todas en `namespacedKey.js`):

- **El cliente nunca compone la key.** Siempre la genera el `control-plane` (funciones `boxVersionKey()`, `boxUploadKey()`, etc.) y el `runtime`/`control-plane` la valida antes de leer/escribir (`isInsideBoxNamespace()`, `isInsideTenantNamespace()`).
- Cada segmento de la key pasa por `assertSegment()`, que rechaza `/`, `\`, `.`, `..` y cualquier carácter fuera de `[a-zA-Z0-9_.-]` — corta path traversal de raíz (nadie puede escribir `tenants/acme/../otro-tenant/...`).
- **Versionado (`packages/shared/src/versioning.js`)**: cada push crea `v{N}.html` nuevo. Si hay más de `MAX_BOX_VERSIONS=5` (constante en `shared/src/constants.js`), se borra automáticamente la más antigua (R2 + su fila en `htmlbox_versions`). Rollback **no borra nada** — copia el contenido de una versión vieja como una versión NUEVA (nunca reescribe una `vN.html` existente), así el historial de "qué pasó" queda intacto.
- **Cómo sube el usuario un HTML nuevo** (`control-plane/src/routes/uploads.js`):
  1. El portal pide `POST /api/boxes/:id/upload-url` → control-plane calcula la próxima key (`v{N+1}.html`) y devuelve una URL firmada con HMAC-SHA256 (usando `HTMLBOX_SESSION_SECRET` como clave, firma sobre `key\nexpiresAt`, válida 10 min).
  2. El cliente hace `PUT` directo a esa URL (`/api/_local/upload` en el mismo Worker `control-plane`, que valida la firma y escribe al binding R2).
  3. El cliente confirma con `POST /api/boxes/:id/html`, que **revalida** que el objeto realmente existe en R2, que el tamaño no excede `MAX_HTML_BYTES` (2 MB), y que la versión en la key coincide con la esperada — recién ahí crea la fila en `htmlbox_versions` y purga la más vieja si corresponde.
  - Nota: no es un presigned URL nativo de R2 (S3-style) — es un HMAC casero, porque el binding R2 de Workers no expone `createPresignedUrl()` en producción. El comentario en `uploads.js` lo explica.

---

## 4. Turso — los datos de cada box (`packages/control-plane/src/lib/tursoClient.js`, `packages/runtime/src/lib/boxDb.js`, `packages/runtime/src/lib/dataApi.js`)

Esto es lo más distinto de un modelo "SaaS con una sola base": **cada box tiene su propia base de datos Turso física** (en modo `cloud`). No es una tabla compartida con `box_id` como columna — es aislamiento a nivel de base de datos completa.

### Aprovisionamiento
Cuando se crea un box (`control-plane/src/routes/boxes.js#createBox`):
1. Se llama a `createBoxDatabase(env, boxId)` (`tursoClient.js`).
2. En modo `cloud`: llama a la **Turso Platform API** (`https://api.turso.io/v1`) con el `HTMLBOX_TURSO_PLATFORM_TOKEN` (un secret de organización, NO específico de box) para:
   - Crear la base: `POST /organizations/{org}/databases` con nombre `htmlbox-box-{boxId}` (prefijo validado por `TURSO_DB_NAME_REGEX` en `shared/src/constants.js`) dentro del grupo `htmlbox` (`TURSO_GROUP`).
   - Crear un token de acceso para ESA base: `POST /organizations/{org}/databases/{name}/auth/tokens` — este token (`jwt`) es el que se guarda en `htmlbox_boxes.turso_db_token`.
3. Se guarda `turso_db_url` (`libsql://{hostname}`) y `turso_db_token` en D1, y `turso_status` pasa a `ready`.
4. Se aplica el schema base (`applyBoxSchema()`, definido en `packages/shared/src/boxSchema.js`) — tablas `htmlbox_tables`, `htmlbox_schema_log`, `htmlbox_files`, `htmlbox_runs` que existen en TODA base de box, más las tablas de datos de usuario que se crean dinámicamente (ver abajo).

Si algo falla en el camino, el box queda creado igual pero con `turso_status='failed'` o `'schema_failed'` — hay un endpoint de reintento (`POST /api/internal/retry-schema/:boxId`) para reparar desde el panel admin.

### Modo local (dev)
`HTMLBOX_TURSO_MODE=local` (default): en vez de la Platform API, se conecta a un `sqld` corriendo en `localhost:8080` (`turso dev`). **Importante**: en este modo, TODAS las boxes de TODOS los tenants comparten la misma instancia física de sqld — no hay una base por box en dev. El código lo reconoce explícitamente en los comentarios de `tursoClient.js` y `dataApi.js`. Esto significa que en dev, si dos boxes distintos crean una tabla de datos con el mismo slug (por ejemplo "ventas"), sus filas terminan en la misma tabla física — ver el hallazgo #5 en `claude/htmlbox-revision-codigo.md` del proyecto SIVOCLOUD para el detalle de riesgo.

### Cómo se accede a los datos de un box en runtime
`runtime/src/lib/boxDb.js#resolveBoxDb()`:
1. El Worker `runtime` (que sirve el HTML y expone `/api/data/{boxId}/...`) NO tiene las credenciales Turso — se las pide al `control-plane` vía `GET /api/internal/boxes/{boxId}/db`, reenviando la cookie de sesión del usuario.
2. El control-plane valida la sesión y la membresía, y devuelve `{turso_db_url, turso_db_token}` en JSON.
3. El runtime cachea esa respuesta en KV (`boxdb:{boxId}`, TTL 60s) para no pegarle al control-plane en cada request.
4. Con esas credenciales, `connect({url, authToken})` (librería `@tursodatabase/serverless`) abre una conexión libsql directa a la base del box — sin pasar de nuevo por el control-plane para cada query.

### Estructura de datos dentro de cada Turso DB de box (`boxSchema.js`)
- `htmlbox_tables` — catálogo de "hojas"/tablas que el usuario definió dentro de ese box (slug, nombre, columnas como JSON, modo manual/flow).
- `htmlbox_schema_log` — auditoría de cambios de schema.
- `htmlbox_files` — registro de archivos subidos (CSV/JSON) y su resultado (cuántas filas, estrategia replace/upsert).
- `htmlbox_runs` — corridas de flows (fase 4, no implementada aún).
- Las tablas de **datos de usuario** se crean dinámicamente por slug: `htmlbox_{slug}` (p. ej. `htmlbox_ventas`), con columnas fijas `id, data_json, created_at, updated_at, deleted_at` — todo el contenido de fila va empaquetado como JSON en `data_json` (no hay columnas tipadas por campo), y el borrado es lógico (`deleted_at`), nunca `DELETE` físico.

### Cómo se separa el acceso por rol dentro de un box
El **token Turso en sí no tiene restricción de rol** — es un token con acceso completo a esa base física. El control de "¿este usuario puede leer/escribir estos datos?" es enteramente de aplicación, en `runtime/src/lib/dataApi.js`:
- Lectura (`GET .../rows`, `.../columns`) — requiere membresía en el workspace (cualquier rol: owner/editor/viewer).
- Escritura (`POST .../upsert`, `.../upload`) — requiere rol `owner` o `editor` explícitamente.

Como el token no distingue esto a nivel de Turso, cualquier código que llegue a obtener el token crudo (por ejemplo llamando directamente a `GET /api/internal/boxes/:id/db`, que hoy no filtra por rol — ver hallazgo #4 del doc de revisión) puede saltarse esta restricción de aplicación y escribir directo. Vale la pena tenerlo presente como límite del modelo actual: la separación de permisos vive en el código del Data API, no en Turso.

---

## 5. Tokens y secretos — quién es cada uno

| Token / secreto | Dónde vive | Formato | TTL | Para qué |
|---|---|---|---|---|
| **Cookie de sesión `sid`** | Cliente (HttpOnly cookie) + `htmlbox_sessions` en D1 | 32 bytes random, hex | 30 días (`AUTH_SESSION_TTL_DAYS`) | Identifica al usuario logueado en portal/runtime. `HttpOnly; SameSite=Lax; Secure` (en https); `Domain=.sivocloud.dev` en prod para compartirla entre los 3 Workers. |
| **Magic link token** | URL de email + `htmlbox_magic_links` en D1 | 32 bytes random, hex | 15 min (`AUTH_MAGICLINK_TTL_SEC`), un solo uso (`used_at`) | Login sin password. Rate-limit: máx 3 pedidos por email cada 60s (`AUTH_REQUEST_MAX_PER_EMAIL` / `AUTH_REQUEST_WINDOW_SEC`). |
| **`HTMLBOX_SESSION_SECRET`** | Secret de Worker (`wrangler secret put`) | string | — | Clave HMAC-SHA256 para firmar las URLs de upload a R2 (§3) — NO firma las cookies de sesión (esas son solo un ID random validado contra D1, no un JWT). |
| **API token de box (`hbx_...`)** | Se muestra una sola vez al crearlo; se guarda el HASH (SHA-256) en `htmlbox_api_tokens` | prefijo `hbx_` + random | opcional `expires_at` | Acceso externo de solo-lectura (o más, según `scope`: `read`, `write_html`, `write_data`, `execute`) a UN box específico, sin necesitar sesión de usuario — pensado para integraciones (ver uso en `getActiveHtml()` de `uploads.js`, que acepta `Authorization: Bearer hbx_...` con scope `read` para servir el HTML activo de un box privado sin cookie). |
| **`HTMLBOX_TURSO_PLATFORM_TOKEN`** | Secret de Worker, solo en `control-plane` | JWT de Turso (org-level) | — | Autoriza contra la Turso **Platform API** para crear/administrar bases — es un token de organización, nunca llega al browser ni al runtime. |
| **`turso_db_token`** (por box) | Columna en `htmlbox_boxes` (D1), **texto plano** | JWT de Turso (db-level) | sin expiración explícita hoy | Token de acceso a LA base Turso de ESE box específico. Lo genera `cloudCreateDb()` al aprovisionar. El runtime lo obtiene vía el endpoint interno `/api/internal/boxes/:id/db` (nunca se lo pasa directo al browser del usuario). |
| **HMAC de upload** (`sig`) | Generado al vuelo, no se persiste | hex (SHA-256) | 10 min (`exp` en la URL) | Autoriza un único `PUT` a una key específica de R2 — evita que cualquiera con la URL del bucket pueda escribir HTML arbitrario. |
| **`HTMLBOX_R2_ACCESS_KEY_ID` / `SECRET`** | Secrets de Worker | — | — | Declarados para firmar URLs S3-compatible "fuera del Worker" si hiciera falta — hoy el flujo real usa el HMAC casero de arriba, no estas keys directamente. |

---

## 6. Cómo se separan los tenants, de punta a punta

Resumiendo las tres capas de aislamiento que actúan en conjunto:

1. **A nivel de aplicación (D1)**: todo query relevante filtra por `tenant_id`/`workspace_id`, validado en `assertTenantScope()`/`assertWorkspaceScope()` antes de tocar cualquier fila. Es aislamiento lógico — misma base, mismas tablas, filtrado por columna.
2. **A nivel de almacenamiento de archivos (R2)**: aislamiento por prefijo de key obligatorio (`tenants/{slug}/...`), generado siempre server-side y nunca por el cliente, con validación anti-traversal en cada segmento.
3. **A nivel de datos de negocio (Turso)**: aislamiento físico real — una base de datos completa por box (en `cloud` mode). Esto es más fuerte que el aislamiento lógico de D1/R2: aunque alguien comprometiera las credenciales de UN box, no vería datos de otro box, porque literalmente están en otra base de datos.

El punto más débil de esta cadena hoy es que el paso 3 depende de que el `turso_db_token` nunca se filtre — y como se documenta en `claude/htmlbox-revision-codigo.md`, el endpoint interno que lo entrega no filtra por rol, así que cualquier miembro autenticado del workspace (incluso viewer) puede obtenerlo directamente. Vale la pena revisar ese punto si se va a manejar información sensible de clientes reales.

---

## 7. Dominios y cómo cada Worker sabe con qué tenant/box está hablando

- `controlplane.sivocloud.dev` → Worker `control-plane` — el único que toca D1 y Turso Platform API directamente, y el único que puede escribir en R2 (todas las escrituras de HTML pasan por acá, aunque sea vía la URL firmada).
- `portal.sivocloud.dev` → Worker `portal` — SPA Alpine.js del tenant, actúa como proxy transparente de `/api/*` hacia `control-plane` (para evitar CORS) y sirve estáticos. No toca D1/R2/Turso directamente.
- `*.sivocloud.dev` → Worker `runtime` — sirve el HTML publicado de cada box y expone la Data API. Resuelve `{tenantSlug}.sivocloud.dev/{boxSlug}` (privado, con sesión) o `/s/{shareId}` (público, sin sesión) contra el control-plane (`resolveByTenantAndSlug`/`resolveByShareId` en `resolver.js`), cachea esa resolución en KV 5 min, y lee el HTML directamente de R2. Para datos, en cambio, pide credenciales Turso al control-plane por cada box la primera vez (cacheado 60s) y luego habla directo con Turso.
