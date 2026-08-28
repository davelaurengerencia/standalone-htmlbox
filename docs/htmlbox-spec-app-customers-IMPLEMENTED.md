# HTMLBox — Spec: customers (cada usuario ve lo suyo) — fase 2 de "usuarios de las apps"

Repo: `htmlbox`. Spec para que el equipo lo implemente al pie de la letra. **Depende de** `htmlbox-spec-app-users.md` (fase 1 — ya entregada): asume que `htmlbox_app_users`/`htmlbox_app_sessions`/`htmlbox_app_magic_links`, `appAuth.js` y las rutas `/api/app-auth/{boxId}/...` de esa spec ya existen.

**Esta spec reemplaza el borrador anterior** (`htmlbox-spec-app-customers-b2b.md`, con `customer_admin`/`member`/`staff` y una tabla `htmlbox_app_customers` separada). Ese diseño resolvía un caso más específico del que hace falta — B2B donde varias personas comparten una sola cuenta de empresa — y no es lo que se necesita como base. **Se puede borrar ese archivo**, esta spec lo supera.

## 0. El modelo correcto, sin vueltas

Un `customer` **es** un `app_user`. No hace falta una tabla nueva, no hace falta "empresa" — 1 email = 1 cuenta = ve solo lo suyo. Así funciona cualquier ecommerce (un shopper ve sus propios pedidos, nunca los de otro), cualquier SaaS simple (cada cuenta ve su propio proyecto/data), y en general cualquier app publicada donde el que entra es un cliente final, no un empleado del tenant.

Esto corrige algo que quedó mal planteado en la fase 1 (§7 de esa spec): ahí dije "v1 = acceso completo, cualquiera con sesión válida ve todo". Eso está bien **solo** para el caso original que motivó la fase 1 — un dashboard interno donde 5 empleados del tenant ven lo mismo. Para cualquier box de cara al público con customers reales, "acceso completo" es el default equivocado: significaría que un customer puede ver los pedidos de todos los demás.

La solución es simple y **por tabla**, no un sistema nuevo de usuarios: cada tabla de datos del box declara si es `'private'` (cada `app_user` ve/edita solo las filas que él mismo creó) o `'shared'` (todos los `app_users` la ven igual — un catálogo, una lista de precios, algo que no es "de nadie" en particular). Nada más.

## 1. Schema — dos columnas nuevas, ninguna tabla nueva

Se agrega a `packages/shared/src/boxSchema.js`, reusando el patrón de `ensureColumn()` (idéntico razonamiento al de la fase 1 §2 con `applyAppUsersSchema` — `CREATE TABLE IF NOT EXISTS` / columna agregada solo si falta, porque SQLite no soporta `ADD COLUMN IF NOT EXISTS`):

```js
// packages/shared/src/boxSchema.js — agregar junto a APP_USERS_SCHEMA_SQL

// Agrega una columna a una tabla si todavía no existe. Chequea con
// PRAGMA table_info antes de alterar — correrlo dos veces sobre el mismo
// box no debe tirar "duplicate column name".
export async function ensureColumn(client, tableName, columnName, columnDefSql) {
  const info = await (typeof client.execute === 'function'
    ? client.execute(`PRAGMA table_info(${tableName})`)
    : client.exec(`PRAGMA table_info(${tableName})`))
  const rows = info.rows || info || []
  const exists = rows.some(r => (r.name || r[1]) === columnName)
  if (exists) return
  const alter = `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefSql}`
  if (typeof client.exec === 'function') await client.exec(alter)
  else await client.execute(alter)
}

// scope de una tabla de datos del box: 'private' (default, cada app_user ve
// solo lo suyo) | 'shared' (todos ven lo mismo — catálogos, listas, etc.)
export async function ensureTableScopeColumn(client) {
  await ensureColumn(client, 'htmlbox_tables', 'scope', `TEXT NOT NULL DEFAULT 'private'`)
}

// dueño de una fila. Nullable: filas creadas por otra vía (ej. el tenant
// cargó un CSV desde el portal, vía dataApi.js) quedan sin dueño y no las ve
// ningún app_user en una tabla 'private' hasta que se les asigne uno — mismo
// criterio fail-closed que en cualquier otra parte de este sistema.
export async function ensureOwnerColumn(client, slug) {
  await ensureColumn(client, `htmlbox_${slug}`, 'owner_user_id', 'TEXT')
}
```

Default `'private'` (no `'shared'`) es la opción segura: una tabla nueva en un box con customers nace particionada — si el tenant se olvida de marcarla, el peor caso es que un dato quede invisible hasta que se corrija, no que se filtre entre customers.

## 2. `packages/runtime/src/lib/appDataApi.js` (nuevo archivo)

Router separado de `dataApi.js` (que sigue siendo exclusivo de sesión de **plataforma** — el tenant editando su box desde el portal — y no se toca). Rutas:

```
GET  /api/app-data/{boxId}/tables/{slug}/rows    → lee filas (propias si scope='private', todas si 'shared')
POST /api/app-data/{boxId}/tables/{slug}/upsert  → escribe filas (siempre estampadas con el id del app_user, si scope='private')
```

Deliberadamente sin `bulk-create`/`upload`/`columns` — crear tablas y definir columnas sigue siendo trabajo del tenant vía `dataApi.js`/portal. Un `app_user` (customer) solo lee/escribe filas en tablas que el tenant ya definió.

```js
// packages/runtime/src/lib/appDataApi.js
//
// Data API para app_users/customers (fase 2). A diferencia de dataApi.js
// (sesión de PLATAFORMA, sin partición), acá la sesión es de app_user
// (appAuth.js, cookie hbx_app_sid) y toda lectura/escritura sobre una tabla
// 'private' se filtra o estampa automáticamente con el id del app_user
// autenticado — nunca con un valor que venga del caller.

import { resolveBoxDb, getBoxClient } from './boxDb.js'
import { getAppSessionIdFromRequest, validateAppSession } from './appAuth.js'
import { ensureColumn } from '@htmlbox/shared'

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...extraHeaders } })
}

async function requireAppUser(env, boxId, request) {
  const info = await resolveBoxDb(env, boxId, request)
  if (!info) return { error: 'box_not_found', status: 404 }
  const client = await getBoxClient(env, info)
  const sid = getAppSessionIdFromRequest(request)
  const sess = await validateAppSession(client, sid)
  if (!sess) return { error: 'unauthenticated', status: 401 }
  return { client, appUser: sess.appUser }
}

async function getTableScope(client, slug) {
  await ensureColumn(client, 'htmlbox_tables', 'scope', `TEXT NOT NULL DEFAULT 'private'`)
  const result = await client.execute({ sql: `SELECT scope FROM htmlbox_tables WHERE slug = ?1`, args: [slug] })
  return result.rows[0]?.scope || null // null = la tabla no existe
}

async function getRows(request, env, boxId, slug, url) {
  const auth = await requireAppUser(env, boxId, request)
  if (auth.error) return json({ error: auth.error }, auth.status)

  const scope = await getTableScope(auth.client, slug)
  if (!scope) return json({ error: 'table_not_found' }, 404)
  await ensureColumn(auth.client, `htmlbox_${slug}`, 'owner_user_id', 'TEXT')

  const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit')) || 100))
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)

  let sql = `SELECT id, data_json, created_at, updated_at FROM htmlbox_${slug} WHERE deleted_at IS NULL`
  const args = []
  if (scope === 'private') {
    sql += ` AND owner_user_id = ?1`
    args.push(auth.appUser.id)
  }
  // scope === 'shared': sin filtro, todos ven lo mismo.
  sql += ` ORDER BY id ASC LIMIT ${limit} OFFSET ${offset}`

  const result = await auth.client.execute({ sql, args })
  const rows = result.rows.map(r => {
    let data = {}
    try { data = JSON.parse(r.data_json || '{}') } catch { /* keep */ }
    return { id: r.id, ...data, created_at: r.created_at, updated_at: r.updated_at }
  })
  return json({ rows, count: rows.length, limit, offset })
}

async function postUpsert(request, env, boxId, slug) {
  const auth = await requireAppUser(env, boxId, request)
  if (auth.error) return json({ error: auth.error }, auth.status)

  const scope = await getTableScope(auth.client, slug)
  if (!scope) return json({ error: 'table_not_found' }, 404)
  if (scope === 'shared') {
    // v1: tablas compartidas son solo-lectura para app_users — escribir ahí
    // sigue siendo trabajo del tenant (dataApi.js). Habilitar escritura de
    // customers sobre datos compartidos implica resolver conflictos entre
    // ellos editando lo mismo — problema aparte, no bloqueante (§4).
    return json({ error: 'shared_table_read_only_for_app_users' }, 403)
  }

  await ensureColumn(auth.client, `htmlbox_${slug}`, 'owner_user_id', 'TEXT')

  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const rows = Array.isArray(body?.rows) ? body.rows : null
  if (!rows || rows.length === 0) return json({ error: 'missing_rows' }, 400)

  let inserted = 0
  for (const r of rows) {
    if (typeof r !== 'object' || r === null) continue
    // owner_user_id NUNCA sale del body — siempre auth.appUser.id (sesión
    // validada server-side). Si el row trae "owner_user_id"/"user_id", se
    // ignora — no hay forma de que un customer escriba a nombre de otro.
    const { id: _i, created_at: _c, updated_at: _u, owner_user_id: _o, user_id: _uid, ...rest } = r
    await auth.client.execute({
      sql: `INSERT INTO htmlbox_${slug} (data_json, owner_user_id) VALUES (?1, ?2)`,
      args: [JSON.stringify(rest), auth.appUser.id],
    })
    inserted++
  }
  return json({ ok: true, inserted })
}

export async function handleAppDataApi(request, env, url) {
  const m = url.pathname.match(/^\/api\/app-data\/([a-z0-9]{16})\/tables\/([a-z][a-z0-9_]{0,40})\/(rows|upsert)$/)
  if (!m) return null
  const [, boxId, slug, op] = m
  if (op === 'rows' && request.method === 'GET') return await getRows(request, env, boxId, slug, url)
  if (op === 'upsert' && request.method === 'POST') return await postUpsert(request, env, boxId, slug)
  return json({ error: 'method_not_allowed' }, 405)
}
```

Wiring en `packages/runtime/src/worker.js`, junto al bloque de `/api/data/`:

```js
import { handleAppDataApi } from './lib/appDataApi.js'
// ...
if (path.startsWith('/api/app-data/')) {
  return (await handleAppDataApi(request, env, url)) || notFound('not_found')
}
```

**Punto de seguridad central:** en `postUpsert`, `owner_user_id` sale siempre de `auth.appUser.id` (la sesión validada), nunca del body. Es la única línea que garantiza que un customer no pueda escribir datos a nombre de otro.

## 3. Signup: la fase 1 asumía invitación — para customers hace falta auto-registro

Este es el segundo ajuste real sobre la fase 1, además del de acceso por-fila. La fase 1 (`postRequest`, §5 de esa spec) exige que el email **ya exista** como `app_user` antes de poder pedir el magic link — el tenant lo agrega a mano desde el portal. Eso tiene sentido para "mis 5 empleados" (invitación explícita), pero **no** para un ecommerce: ahí cualquier visitante nuevo tiene que poder crear su cuenta solo, escribiendo su email y listo — nadie lo invita antes.

Se agrega un flag de configuración por box, en una tabla mínima nueva (una sola fila, para no forzar otra vez `ALTER TABLE` sobre `htmlbox_app_users`):

```js
// Agregar a boxSchema.js, junto a lo demás de esta fase.
export const APP_SETTINGS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS htmlbox_app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  signup_mode TEXT NOT NULL DEFAULT 'invite_only'
);
`
// signup_mode: 'invite_only' (default — comportamiento de fase 1, el tenant
// da de alta cada email a mano) | 'open' (cualquiera puede pedir su magic
// link y la cuenta se crea sola — modo ecommerce/customer-facing).

export async function applyAppSettingsSchema(client) {
  const stmts = APP_SETTINGS_SCHEMA_SQL.split(/;\s*$/m).map(s => s.trim()).filter(Boolean)
  for (const stmt of stmts) {
    if (typeof client.exec === 'function') await client.exec(stmt)
    else await client.execute(stmt)
  }
  // fila única por default — INSERT OR IGNORE porque puede llamarse varias veces
  const insert = `INSERT OR IGNORE INTO htmlbox_app_settings (id, signup_mode) VALUES (1, 'invite_only')`
  if (typeof client.exec === 'function') await client.exec(insert)
  else await client.execute(insert)
}
```

Cambio en `postRequest` de `appAuth.js`/rutas de fase 1 (agregar, no reescribir toda la función — ver la fase 1 §5.1 para el resto que sigue igual):

```js
// Reemplaza este bloque en postRequest (fase 1):
//   const appUser = await findAppUserByEmail(client, email)
//   if (!appUser || appUser.disabled_at) return json(GENERIC)
//
// Por:
let appUser = await findAppUserByEmail(client, email)
if (!appUser) {
  const settings = await client.execute(`SELECT signup_mode FROM htmlbox_app_settings WHERE id = 1`)
  const signupMode = settings.rows[0]?.signup_mode || 'invite_only'
  if (signupMode !== 'open') return json(GENERIC) // invite_only: mismo comportamiento que fase 1
  appUser = await createAppUser(client, email) // ya existe en appAuth.js, fase 1 §3
}
if (appUser.disabled_at) return json(GENERIC)
```

Nuevo endpoint admin para que el tenant elija el modo desde el portal (mismo patrón `requireBox()` que el resto de rutas admin):

```
GET  /api/app-auth/{boxId}/admin/settings              → { signup_mode }
POST /api/app-auth/{boxId}/admin/settings { signup_mode } → cambia el modo ('invite_only' | 'open')
```

## 4. Qué queda fuera de esta spec (no bloqueante)

- **Una cuenta compartida por varias personas de la misma empresa** (el caso B2B real del borrador anterior — `customer_admin`/`member` sobre una tabla `htmlbox_app_customers`). Sigue siendo válido como necesidad, pero es la excepción, no la base — se retoma como extensión aparte el día que haya un caso concreto que la necesite, no antes.
- **Equipo interno del tenant viendo todo cruzando customers** (el "staff" del borrador anterior) — mismo motivo: es una necesidad de un tipo de app particular (CRM/portal B2B interno), no del caso general. El tenant, mientras tanto, sigue pudiendo ver todos los datos de todos los customers desde el portal vía `dataApi.js` (sesión de plataforma, sin partición) — eso ya existe y no cambia.
- **Escritura en tablas `scope='shared'` desde un customer** (`postUpsert` las rechaza con 403) — quedan de solo lectura para `app_users` en v1.
- **Verificación de email / dominio en modo `signup_mode='open'`** — cualquiera que escriba un email real recibe el magic link y se crea la cuenta; no hay chequeo de que el dominio del email pertenezca a algo en particular. Para un ecommerce esto es correcto (cualquiera compra), pero si algún box necesita restringir el auto-registro a ciertos dominios, es una mejora sobre `signup_mode` a futuro, no parte de esto.
- **Cambiar el `scope` de una tabla que ya tiene filas** — igual nota que en el borrador anterior: sin migración de datos que decida a quién le corresponde cada fila existente, cambiarlo a mano puede dejarlas inaccesibles. Operación manual por ahora.

## 5. Checklist de implementación

1. Agregar `ensureColumn()`, `ensureTableScopeColumn()`, `ensureOwnerColumn()` a `packages/shared/src/boxSchema.js` (§1).
2. Crear `packages/runtime/src/lib/appDataApi.js` con `getRows`/`postUpsert`/`handleAppDataApi` (§2), wirearlo en `worker.js` bajo `/api/app-data/`.
3. Agregar `APP_SETTINGS_SCHEMA_SQL`/`applyAppSettingsSchema()` a `boxSchema.js`, y el cambio en `postRequest` de fase 1 para soportar `signup_mode='open'` (§3).
4. Agregar las rutas admin `/api/app-auth/{boxId}/admin/settings` (GET/POST) (§3).
5. Agregar en el portal (tab "Usuarios" de fase 1) un toggle simple "¿Cualquiera puede registrarse?" que pega contra `/admin/settings`.
6. Al crear una tabla desde el portal (donde hoy se define `columns_json`), agregar la opción de marcarla `scope='private'` (default) o `'shared'`.
7. Probar el caso ecommerce: `signup_mode='open'`, dos emails distintos piden magic link sin que el tenant los haya agregado antes, ambos consiguen cuenta y sesión. Cada uno crea filas en una tabla `scope='private'` vía `POST /api/app-data/{boxId}/tables/{slug}/upsert` — confirmar que `GET rows` de uno NUNCA devuelve filas del otro.
8. Probar una tabla `scope='shared'`: ambos customers ven las mismas filas en `GET`, `POST upsert` devuelve 403 para los dos.
9. Probar `signup_mode='invite_only'` (default): un email que el tenant NO agregó pide magic link y recibe la respuesta genérica sin crear cuenta — mismo comportamiento que fase 1 sin este cambio.
10. Probar la migración: una tabla creada antes de esta fase (sin `owner_user_id`) — confirmar que `ensureColumn()` la agrega sola en el primer request, y que las filas viejas (`owner_user_id = NULL`) no aparecen para ningún customer en una tabla `'private'` hasta que se les asigne uno.
