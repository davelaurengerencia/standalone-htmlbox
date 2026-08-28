# HTMLBox — Spec: fortalecer el análisis con IA (entidades, relaciones, metadatos, detección de tipo de app)

## 0. Lo que hay que saber antes de meterle prompt engineering

Hoy `physicalTableSqlFor()` (`packages/shared/src/boxSchema.js`) crea SIEMPRE la misma tabla genérica, sin importar qué columnas propuso la IA:

```sql
CREATE TABLE htmlbox_{slug} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
)
```

Las `columns` que la IA propone (`{name, type, example}`) hoy son **metadata descriptiva, no columnas SQL reales** — cada fila entera se guarda como un blob JSON en `data_json`. Esto importa muchísimo para lo que pediste: `unique`, `auto_increment vs uuid`, y relaciones entre tablas **no se pueden pedir en serio si la columna ni siquiera existe como columna SQL** — serían constraints decorativos que SQLite nunca hace cumplir. Por eso esta spec tiene dos partes que no se pueden separar: (1) el análisis de la IA (prompt, clasificación de tipo de app), y (2) el cambio de `physicalTableSqlFor` para que las columnas declaradas como `unique` o parte de una relación sean columnas SQL reales, no solo texto dentro de un JSON.

`created_at`/`updated_at` YA están en la tabla base (con default de SQLite, no dependen de que la IA los proponga) — lo que falta es `created_by`, que la IA no puede inventar por sí sola: necesita venir de la sesión de quien inserta, no del HTML estático. Ver §4.

## 1. Clasificación de tipo de app — antes de proponer cualquier tabla

Nuevo primer paso en `analyzeHtml()`: clasificar la app en una de 3 categorías, ANTES de pedirle un schema a Gemini. Evita el caso que describiste — un dashboard tipo Power BI que solo visualiza datos ajenos no necesita que le creemos tablas.

```
"app_type": "data_backed" | "read_only_dashboard" | "external_integration"
```

- **`data_backed`**: la app tiene arrays de datos propios que edita/persiste (el caso de hoy — CRM, inventario, formularios). Sigue el flujo actual de proponer tablas.
- **`read_only_dashboard`**: la app solo visualiza — gráficos/tablas que leen de un array embebido pero NUNCA lo modifican (no hay `<form>`, no hay botones de guardar/editar/borrar, no hay `fetch()` con método POST/PUT/DELETE hacia el propio origin). Ejemplo: un dashboard de KPIs armado sobre un array de ventas fijo. Acá la propuesta de tablas es opcional — se ofrece igual (por si el usuario después SÍ quiere que sea editable), pero marcada como `recommended: false` en la respuesta, y el botón "Aplicar" del portal muestra un aviso: *"Esta app parece de solo lectura — crear tablas es opcional."*
- **`external_integration`**: la app llama a APIs de terceros (Shopify, Stripe, cualquier `fetch()` a un dominio que no sea el propio SDK de HTMLBox) para sus datos, y no tiene arrays de datos propios embebidos. Acá NO se propone ninguna tabla — la respuesta de `analyzeHtml` es `{ app_type: 'external_integration', tables: [], reason: '...' }`, y el botón "Aplicar" queda deshabilitado con el motivo.

Detección determinística (no depender de que la IA lo intuya sola): `dataExtractor.js` ya extrae los candidatos de arrays inline (`extractArrayCandidates`) — se le agrega una pasada liviana que cuenta: (a) cuántos `fetch()` hay hacia dominios externos (no `HTMLBOX_SDK_ORIGIN` ni relativos), (b) si hay algún `<form>` o handler `onclick`/`addEventListener` que dispare una mutación (POST/PUT/DELETE, o que reasigne el array candidato completo). Esta cuenta determinística se le pasa a la IA como contexto (igual que ya se hace con `candidates`), y la IA decide `app_type` basándose en eso — no lo inventa a ciegas, y nosotros podemos overridear si la cuenta determinística es inequívoca (0 candidatos + 1+ fetch externo = `external_integration` directo, sin ni llamar a Gemini).

## 2. Prompt: entidades, relaciones, unique, estrategia de ID

Extender el `SYSTEM_PROMPT` de `aiProvider.js` — hoy pide `columns: [{name, type, example}]` plano, sin relaciones ni constraints. Nueva forma:

```json
{
  "app_type": "data_backed",
  "tables": [
    {
      "slug": "productos",
      "name": "Productos",
      "description": "...",
      "id_strategy": "autoincrement" | "uuid",
      "columns": [
        { "name": "sku", "type": "string", "unique": true, "nullable": false, "example": "SKU-001" },
        { "name": "categoria_id", "type": "number", "references": "categorias.id", "nullable": true, "example": 3 }
      ],
      "sample_rows": [...],
      "source_var": "productos"
    }
  ]
}
```

Reglas nuevas para el prompt:
- **`id_strategy`**: `"uuid"` si el HTML ya genera IDs propios como string (`crypto.randomUUID()`, `Date.now()+Math.random()`, IDs con formato no-numérico en los datos de ejemplo) — señal de que el propio código del tenant depende de poder generar el ID en el cliente antes de guardar (offline-first, optimistic UI). `"autoincrement"` en cualquier otro caso (default, más simple, es lo que ya soporta `physicalTableSqlFor` hoy).
- **`unique`**: true solo si el ejemplo/candidato muestra que el campo actúa como identificador natural (email, SKU, slug, código) — no adivinar sobre campos genéricos como `nombre`.
- **`references`**: `"{tabla}.{columna}"` cuando el valor de un campo de una tabla aparece como PK/valor-único de otra tabla propuesta en la MISMA respuesta (ej. `categoria_id` en `productos` referenciando `id` de `categorias`). Nunca inventar una tabla referenciada que no esté en la misma propuesta — si la referencia es a algo externo (una API de terceros), el campo va como `string`/`number` normal, sin `references`.
- Sigue la regla ya existente: **conservador** — no proponer relaciones ni unique "por si acaso"; solo cuando el HTML da evidencia real (dos arrays que comparten un campo con el mismo nombre y valores que se pisan, ej. `pedidos[].clienteId` y `clientes[].id`).

`validateProposal()` se extiende para validar `references` contra las tablas realmente propuestas en la misma respuesta (mismo criterio que ya usa para `source_var` contra `candidates` — rechazar/anular si la IA inventa una referencia a una tabla que no existe en su propia respuesta).

## 3. Columnas reales (superseded — ver `htmlbox-spec-tablas-reales.md`)

David decidió ir más lejos que "promover solo unique/references": **todas** las columnas que declare la IA (y también las de creación manual/CSV/bulk-create, que comparten el mismo storage) pasan a ser columnas SQL reales, no un blob `data_json` con duplicación. Esa decisión de fondo — y el diseño completo (mapeo de tipos, `PRAGMA table_info` como fuente de verdad, `ALTER TABLE` para evolución, `extra_json` como escape hatch para lo no declarado) — está en `htmlbox-spec-tablas-reales.md`. Esta sección queda reemplazada por esa spec: `applyAnalysis` usa `ensureTableReal`/`buildCreateTableSql` de ahí en vez de `physicalTableSqlFor`.

**Orden de creación de tablas**: si hay `references` entre tablas de la misma propuesta, crear primero las tablas referenciadas (topological sort simple sobre el grafo de `references` — con máximo unas pocas tablas por propuesta esto es trivial, sin necesidad de una librería). Esto sigue aplicando igual con columnas reales.

## 4. `created_by` — no es un campo que la IA pueda inventar

La IA no tiene forma de saber "quién" crea cada fila mirando HTML estático — eso depende de la sesión de quien hace el insert en runtime, no del análisis. Conectar esto con lo que YA existe:

- Si el box tiene customers (fase 2, `htmlbox-spec-app-customers.md`) y la tabla en cuestión es `scope='private'`, el `created_by` correcto YA es `owner_user_id` — no hace falta una columna nueva, es la misma columna que ya filtra por dueño. La spec de fortalecimiento debe aclarar esto en el prompt/UI en vez de agregar una columna redundante: "esta tabla ya trackea el dueño vía `owner_user_id`".
- Si la tabla es `scope='shared'` (datos de negocio del tenant, no de un customer particular) y el box tiene usuarios de plataforma administrándola, `created_by` sí tiene sentido como columna nueva — pero su valor viene de la sesión del PLATFORM USER que hace el POST vía el portal/API, nunca de la IA ni del HTML. Se agrega como columna promovida (igual que `unique`/`references`, columna SQL real) rellenada por el handler de `postUpsert`/`postUpload` de `appDataApi.js`/`dataApi.js` a partir de `auth.user.email` — no por el usuario final del box.
- No agregar `created_by` a tablas `scope='private'` de un customer — sería redundante con `owner_user_id` y confuso (dos columnas que dicen "quién" con semántica ligeramente distinta).

## 5. Qué expone el portal (UI, no solo backend)

- El modal de "Analizar con IA" (`modal-ai-schema.html.txt`) muestra ahora el `app_type` detectado como primera línea, con los 3 casos:
  - `data_backed`: comportamiento actual, sin cambios visuales aparte de mostrar relaciones (una tabla con una flecha "→ referencia a {otra tabla}" en vez de solo la lista de columnas).
  - `read_only_dashboard`: banner amber "Esta app parece de solo lectura — las tablas son opcionales" antes de la lista de tablas propuestas, con "Aplicar" igual disponible pero no destacado.
  - `external_integration`: sin lista de tablas, mensaje explicando por qué ("Esta app se conecta a {dominio detectado} — no requiere base de datos propia"), botón "Aplicar" ausente (no deshabilitado, ausente — no hay nada que aplicar).

## 6. Fuera de alcance

- No se decide todavía si `references` soporta relaciones N:M (tabla intermedia) — v1 es solo 1:N vía FK simple, que cubre el 90% de los casos reales de un box.
- No se migra retroactivamente ninguna tabla ya creada con el schema viejo (genérico, sin columnas promovidas) — esto aplica solo a análisis/applies nuevos desde que se implemente.
- No se valida en tiempo real (mientras el usuario edita el HTML) — el análisis sigue siendo on-demand (botón "Analizar con IA" o auto-análisis al guardar, ya existente).
- La detección de `external_integration`/`read_only_dashboard` es heurística, no perfecta — casos ambiguos (un dashboard que ocasionalmente permite editar un solo campo) quedan del lado conservador: si hay CUALQUIER señal de mutación, se clasifica `data_backed`.

## 7. Checklist

1. Extender `dataExtractor.js` con el conteo determinístico de fetch-externo y señales de mutación (forms/handlers).
2. Extender `SYSTEM_PROMPT`/`buildPrompt` con `app_type`, `id_strategy`, `unique`, `references` — pasando el conteo determinístico como contexto adicional.
3. Extender `validateProposal` para validar `references` contra las tablas de la misma propuesta, y `id_strategy` contra el enum permitido.
4. Cambiar `physicalTableSqlFor(slug, columns)` para aceptar columnas y promover las marcadas `unique`/`references` a columnas SQL reales + FKs, con orden topológico simple para múltiples tablas relacionadas.
5. Actualizar `applyAnalysis` para: (a) rellenar las columnas promovidas al insertar cada fila (además de `data_json` completo), (b) ordenar la creación de tablas según `references`, (c) saltear la creación de tablas si `app_type === 'external_integration'`.
6. Implementar la lógica de `created_by` en `postUpsert`/`postUpload` para tablas `scope='shared'` con columna promovida, tomando el email de la sesión de plataforma — nunca de la IA.
7. UI del modal: banner de `app_type`, flechas de relación entre tablas, mensaje de "no requiere base de datos" para `external_integration`.
8. Tests: casos de la detección de `app_type` (dashboard puro, integración externa, app normal con forms), FK creada correctamente y orden topológico con 3 tablas encadenadas, `created_by` poblado solo para `scope='shared'`, `unique` rechaza un insert duplicado (probar contra Turso real, no solo el mock).
