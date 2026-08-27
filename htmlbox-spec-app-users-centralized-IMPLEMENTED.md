# HTMLBox — Spec: usuarios de app centralizados (fase 3 de "usuarios de las apps")

Repo: `htmlbox`. Spec para que el equipo lo implemente al pie de la letra. **Depende de** `htmlbox-spec-app-users.md` (fase 1) y `htmlbox-spec-app-customers.md` (fase 2) — este documento no las reemplaza, las complementa: agrega un **tipo nuevo** de usuario de app, para el caso puntual de gente que necesita cruzar varias apps/workspaces del mismo tenant sin que el tenant tenga que darla de alta en cada una.

## 0. Qué resuelve y qué no toca

Las fases 1 y 2 (`app_users`/`customers`) viven **dentro de la Turso DB de un box específico** — por diseño, aislados, un email = una cuenta en esa app y en ninguna otra. Eso sigue siendo el camino correcto para el caso típico: un ecommerce, un dashboard, cualquier app donde los usuarios son de esa app y de ninguna otra. **Esta spec no cambia nada de eso.**

Lo que agrega es un segundo tipo de identidad, para el caso que el tenant planteó: alguien (un director comercial, un vendedor senior) que necesita entrar a varias apps del tenant — puntualmente una, varias, un workspace entero, o directamente todo lo que el tenant tiene, sin importar en qué workspace esté — y que el tenant lo dé de alta **una sola vez**, en un solo lugar, en vez de repetirlo app por app.

Como esta identidad cruza boxes (y potencialmente cruza workspaces), no puede vivir dentro de la Turso aislada de un box — tiene que vivir donde ya vive todo lo que cruza boxes/workspaces del mismo tenant: **D1, el control-plane**. Es la misma razón por la que `htmlbox_tenants`/`htmlbox_workspaces`/`htmlbox_memberships` ya están ahí.

## 1. Modelo — identidad + accesos, separados

Dos conceptos separados a propósito: **quién es** (una fila, una sola vez) y **a qué llega** (N filas, una por cada cosa a la que se le da acceso). Separarlos es lo que logra "centralizado" — agregar un acceso nuevo no es "crear el usuario de nuevo en otro lado", es una fila más en una tabla de accesos.

```
htmlbox_tenant_app_users     — quién es (1 fila por email, por tenant)
htmlbox_tenant_app_access    — a qué llega (N filas: box puntual | workspace entero | todo el tenant)
```

### 1.1 Migración nueva en control-plane (D1)

```sql
-- packages/control-plane/migrations/00XX_tenant_app_users.sql
--
-- Usuarios de app centralizados a nivel tenant — cruzan boxes/workspaces.
-- Distinto de htmlbox_app_users (fase 1/2, vive en la Turso de cada box,
-- un email = una app) y distinto de htmlbox_users (usuarios de PLATAFORMA,
-- gente que construye boxes en el portal). Este es un tercer tipo.

CREATE TABLE IF NOT EXISTS htmlbox_tenant_app_users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES htmlbox_tenants(id),
  email TEXT NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  disabled_at TEXT,
  UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS htmlbox_tenant_app_sessions (
  id TEXT PRIMARY KEY,
  tenant_app_user_id TEXT NOT NULL REFERENCES htmlbox_tenant_app_users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS htmlbox_tenant_app_magic_links (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES htmlbox_tenants(id),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- El corazón del diseño: a qué llega cada usuario.
--   scope_type='tenant'    → scope_id NULL (implícito: tenant_id de la fila de arriba). Ve TODO.
--   scope_type='workspace' → scope_id = id del workspace. Ve todas las apps de ese workspace.
--   scope_type='box'       → scope_id = id del box puntual.
CREATE TABLE IF NOT EXISTS htmlbox_tenant_app_access (
  id TEXT PRIMARY KEY,
  tenant_app_user_id TEXT NOT NULL REFERENCES htmlbox_tenant_app_users(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,        -- 'tenant' | 'workspace' | 'box'
  scope_id TEXT,                   -- NULL si scope_type='tenant'
  role TEXT NOT NULL DEFAULT 'full', -- v1: no se valida, ver §4. Deja el campo listo para fase de permisos.
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_htmlbox_tenant_app_sessions_user ON htmlbox_tenant_app_sessions(tenant_app_user_id);
CREATE INDEX IF NOT EXISTS idx_htmlbox_tenant_app_sessions_expires ON htmlbox_tenant_app_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_htmlbox_tenant_app_magic_links_email_created ON htmlbox_tenant_app_magic_links(email, created_at);
CREATE INDEX IF NOT EXISTS idx_htmlbox_tenant_app_access_user ON htmlbox_tenant_app_access(tenant_app_user_id);
CREATE INDEX IF NOT EXISTS idx_htmlbox_tenant_app_access_scope ON htmlbox_tenant_app_access(scope_type, scope_id);
```

`role` existe desde v1 con default `'full'` pero **no se valida en ningún lado** de esta spec — mismo criterio que `role` en `htmlbox_app_users` de la fase 2: el campo está listo para que la fase de permisos (todavía no diseñada) lo use por-acceso (el mismo usuario puede ser `'admin'` en un box y `'readonly'` en otro, algo que esta tabla ya soporta con solo llenar la columna — no hace falta migrar nada cuando llegue esa fase).

## 2. Auth — mismo mecanismo (magic link), pero dueño del D1

El login sigue siendo magic link por email, mismo patrón que las fases 1/2 — pero como los datos están en D1, el auth vive del lado de `control-plane`, no de `runtime`. Para que el box publicado (servido por `runtime`, en `{tenant}.htmlbox.dev/...`) nunca tenga que hablarle directo a `controlplane.htmlbox.dev` (evita CORS y mantiene el mismo principio del resto del sistema — el box solo habla con `runtime`), `runtime` expone las rutas públicas y por debajo llama a `control-plane` — exactamente el mismo patrón ya usado para el envío de email en la fase 1 (`sendAppMagicLinkViaControlPlane`, fase 1 §5.1).

### 2.1 Nuevas funciones en `packages/control-plane/src/lib/session.js`

Se agregan junto a las que ya existen para `htmlbox_users`/`htmlbox_sessions` — mismo archivo, mismas convenciones (`randomToken()` ya existe y se reusa tal cual, no se duplica):

```js
// Agregar a session.js — mismas convenciones que isRateLimited/createMagicLink/
// peekMagicLink/consumeMagicLink/createSession/validateSession de arriba en
// el archivo, pero contra htmlbox_tenant_app_* en vez de htmlbox_*.

export async function isTenantAppRateLimited(env, email, tenantId) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM htmlbox_tenant_app_magic_links
     WHERE email = ?1 AND tenant_id = ?2
       AND created_at > datetime('now', '-${AUTH_REQUEST_WINDOW_SEC} seconds')`
  ).bind(email, tenantId).first()
  return (row?.n ?? 0) >= AUTH_REQUEST_MAX_PER_EMAIL
}

export async function createTenantAppMagicLink(env, email, tenantId) {
  const id = randomToken()
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS).toISOString().slice(0, 19).replace('T', ' ')
  await env.DB.prepare(
    `INSERT INTO htmlbox_tenant_app_magic_links (id, email, tenant_id, expires_at) VALUES (?1, ?2, ?3, ?4)`
  ).bind(id, email, tenantId, expiresAt).run()
  return { id, email, tenantId, expiresAt }
}

export async function consumeTenantAppMagicLink(env, tokenId) {
  const result = await env.DB.prepare(
    `UPDATE htmlbox_tenant_app_magic_links SET used_at = datetime('now')
     WHERE id = ?1 AND used_at IS NULL AND datetime(expires_at) > datetime('now')`
  ).bind(tokenId).run()
  if (!result.meta || result.meta.changes === 0) return null
  const row = await env.DB.prepare(
    `SELECT email, tenant_id FROM htmlbox_tenant_app_magic_links WHERE id = ?1`
  ).bind(tokenId).first()
  return row || null
}

export async function findTenantAppUserByEmail(env, tenantId, email) {
  return await env.DB.prepare(
    `SELECT id, email, display_name, disabled_at FROM htmlbox_tenant_app_users WHERE tenant_id = ?1 AND email = ?2`
  ).bind(tenantId, email).first()
}

export async function createTenantAppSession(env, tenantAppUserId) {
  const id = randomToken()
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString().slice(0, 19).replace('T', ' ')
  await env.DB.prepare(
    `INSERT INTO htmlbox_tenant_app_sessions (id, tenant_app_user_id, expires_at) VALUES (?1, ?2, ?3)`
  ).bind(id, tenantAppUserId, expiresAt).run()
  return { id, tenantAppUserId, expiresAt }
}

export async function deleteTenantAppSession(env, sessionId) {
  if (!sessionId) return
  await env.DB.prepare(`DELETE FROM htmlbox_tenant_app_sessions WHERE id = ?1`).bind(sessionId).run()
}

// Devuelve { sessionId, tenantAppUser: { id, email, display_name, tenant_id } } o null.
export async function validateTenantAppSession(env, sessionId) {
  if (!sessionId) return null
  const row = await env.DB.prepare(
    `SELECT s.id AS sid, u.id AS user_id, u.email, u.display_name, u.tenant_id, u.disabled_at
       FROM htmlbox_tenant_app_sessions s
       JOIN htmlbox_tenant_app_users u ON u.id = s.tenant_app_user_id
      WHERE s.id = ?1 AND datetime(s.expires_at) > datetime('now')`
  ).bind(sessionId).first()
  if (!row || row.disabled_at) return null
  return { sessionId: row.sid, tenantAppUser: { id: row.user_id, email: row.email, display_name: row.display_name, tenant_id: row.tenant_id } }
}

// Resuelve si un tenant_app_user tiene acceso a un box puntual, mirando las
// 3 formas posibles de acceso (tenant entero / workspace / box puntual).
// box debe traer { id, tenant_id, workspace_id } (ya se resuelve así en
// varios lados del control-plane, ver internal.js getBoxDb).
export async function checkTenantAppAccess(env, tenantAppUserId, box) {
  const row = await env.DB.prepare(`
    SELECT role FROM htmlbox_tenant_app_access
     WHERE tenant_app_user_id = ?1
       AND (
         scope_type = 'tenant'
         OR (scope_type = 'workspace' AND scope_id = ?2)
         OR (scope_type = 'box' AND scope_id = ?3)
       )
     ORDER BY CASE scope_type WHEN 'box' THEN 0 WHEN 'workspace' THEN 1 ELSE 2 END
     LIMIT 1
  `).bind(tenantAppUserId, box.workspace_id, box.id).first()
  return row ? { allowed: true, role: row.role } : { allowed: false }
}
```

`ORDER BY` en `checkTenantAppAccess` prioriza el acceso más específico (box > workspace > tenant) cuando hay más de uno — hoy da igual porque `role` no se usa (§4), pero cuando llegue la fase de permisos, es el orden correcto para que un acceso puntual a un box pueda, por ejemplo, ser más restrictivo que el acceso general al workspace.

### 2.2 Cookie nueva — `hbx_tapp_sid`, con `Domain`, no con `Path`

A diferencia de la cookie de la fase 1 (`hbx_app_sid`, scoped por `Path` a un solo box — ver esa spec §6), esta necesita viajar a **cualquier box** del tenant. Se resuelve igual que ya resuelve la cookie de plataforma (`sid`): `Domain=.htmlbox.dev` en producción. Se agrega a `session.js`, junto a `buildSessionCookie`/`buildClearCookie`:

```js
const TENANT_APP_SESSION_COOKIE = 'hbx_tapp_sid'

export function buildTenantAppSessionCookie(request, sessionId, env) {
  const domain = getCookieDomain(request, env) // reusa la función que ya existe (§ arriba en session.js)
  const parts = [`${TENANT_APP_SESSION_COOKIE}=${sessionId}`, `Max-Age=${SESSION_TTL_SECONDS}`, 'Path=/', 'HttpOnly', 'SameSite=Lax']
  if (domain) parts.push(`Domain=${domain}`)
  if (shouldUseSecureCookie(request, env)) parts.push('Secure')
  return parts.join('; ')
}

export function buildTenantAppClearCookie(request, env) {
  const domain = getCookieDomain(request, env)
  const parts = [`${TENANT_APP_SESSION_COOKIE}=`, 'Max-Age=0', 'Path=/', 'HttpOnly', 'SameSite=Lax']
  if (domain) parts.push(`Domain=${domain}`)
  if (shouldUseSecureCookie(request, env)) parts.push('Secure')
  return parts.join('; ')
}

export function getTenantAppSessionIdFromRequest(request) {
  const cookieHeader = request.headers.get('Cookie') || request.headers.get('cookie') || ''
  for (const part of cookieHeader.split(/;\s*/)) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === TENANT_APP_SESSION_COOKIE) return part.slice(eq + 1).trim()
  }
  return null
}
```

Tres cookies conviven sin pisarse porque tienen tres nombres distintos: `sid` (plataforma), `hbx_app_sid` (customer de un solo box, Path-scoped), `hbx_tapp_sid` (esto — Domain-scoped, cruza boxes).

### 2.3 Endpoints internos en control-plane (para que `runtime` los llame)

Agregar a `packages/control-plane/src/routes/internal.js`, en `requiresInternalSecret` (junto a `send-app-magic-link` de la fase 1) y en el router:

```js
// requiresInternalSecret (agregar la condición):
path.startsWith('/api/internal/tenant-app-auth/')

// Router:
if (path === '/api/internal/tenant-app-auth/request' && method === 'POST') return await postTenantAppRequest(request, env)
if (path === '/api/internal/tenant-app-auth/consume' && method === 'POST') return await postTenantAppConsume(request, env)
if (path === '/api/internal/tenant-app-auth/access'  && method === 'POST') return await postTenantAppAccessCheck(request, env)

// { tenantId, email } → { ok, _dev_preview?, _email_mode? } — mismo shape que
// GENERIC_RESPONSE, corre el rate-limit + crea el magic link + llama
// sendAppMagicLinkEmail (reusa TAL CUAL la función de la fase 1 — ya acepta
// {toEmail, magicLink, boxName}, acá boxName queda null/nombre del tenant).
async function postTenantAppRequest(request, env) {
  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const { tenantId, email: rawEmail } = body || {}
  const email = (rawEmail || '').trim().toLowerCase()
  const GENERIC = { ok: true }
  if (!tenantId || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(GENERIC)

  const appUser = await findTenantAppUserByEmail(env, tenantId, email)
  if (!appUser || appUser.disabled_at) return json(GENERIC) // invite_only siempre acá — ver §5, no hay modo 'open'

  if (await isTenantAppRateLimited(env, email, tenantId)) return json(GENERIC)

  const { id: tokenId } = await createTenantAppMagicLink(env, email, tenantId)
  // magicLink lo arma runtime (sabe su propio origin) y lo manda en el body —
  // mismo motivo que en fase 1 §4: control-plane no arma URLs de runtime.
  const magicLink = body.magicLinkBase ? `${body.magicLinkBase}${tokenId}` : null
  if (!magicLink) return json({ error: 'missing_magic_link_base' }, 400)

  const tenant = await env.DB.prepare(`SELECT name FROM htmlbox_tenants WHERE id = ?1`).bind(tenantId).first()
  const emailResult = await sendAppMagicLinkEmail(env, { toEmail: email, magicLink, boxName: tenant?.name || null })
  return json({ ...GENERIC, _dev_preview: emailResult?.previewLink, _email_mode: emailResult?.mode })
}

// { token } → { ok, tenantAppUser, cookie } — consume + crea sesión. El
// cookie completo (string) se devuelve para que runtime lo reenvíe tal cual
// en su propia respuesta — control-plane no puede setear una cookie que
// termine en el browser del visitante del box (esa respuesta la arma
// runtime, no control-plane).
async function postTenantAppConsume(request, env) {
  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const token = body?.token
  if (!token) return json({ error: 'missing_token' }, 400)

  const consumed = await consumeTenantAppMagicLink(env, token)
  if (!consumed) return json({ error: 'invalid_or_expired_token' }, 400)

  const appUser = await findTenantAppUserByEmail(env, consumed.tenant_id, consumed.email)
  if (!appUser || appUser.disabled_at) return json({ error: 'user_not_found_or_disabled' }, 403)

  const sess = await createTenantAppSession(env, appUser.id)
  const cookie = buildTenantAppSessionCookie(request, sess.id, env)
  return json({ ok: true, tenantAppUser: { id: appUser.id, email: appUser.email, display_name: appUser.display_name }, cookie })
}

// { boxId } + cookie hbx_tapp_sid reenviada por runtime → { allowed, role?, tenantAppUser? }
async function postTenantAppAccessCheck(request, env) {
  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const boxId = body?.boxId
  if (!boxId) return json({ error: 'missing_box_id' }, 400)

  const sid = getTenantAppSessionIdFromRequest(request)
  const v = await validateTenantAppSession(env, sid)
  if (!v) return json({ allowed: false })

  const box = await env.DB.prepare(`SELECT id, tenant_id, workspace_id FROM htmlbox_boxes WHERE id = ?1`).bind(boxId).first()
  if (!box || box.tenant_id !== v.tenantAppUser.tenant_id) return json({ allowed: false })

  const access = await checkTenantAppAccess(env, v.tenantAppUser.id, box)
  if (!access.allowed) return json({ allowed: false })
  return json({ allowed: true, role: access.role, tenantAppUser: v.tenantAppUser })
}
```

## 3. Rutas públicas en `runtime` + integración con `appDataApi.js`

Mismo prefijo de URL que la fase 1, pero SIN `{boxId}` en `request`/`verify`/`consume` porque el login no es de un box — es del tenant (`{boxId}` sí aparece en `me`/`logout`/y en el chequeo de acceso, porque ahí sí importa desde qué box se está preguntando):

```
POST /api/tenant-app-auth/{boxId}/request  { email }              → pide magic link (proxy a control-plane)
GET  /api/tenant-app-auth/{boxId}/verify?token=…&return=<path>    → página HTML auto-POST (mismo patrón que fase 1 §5.2)
POST /api/tenant-app-auth/{boxId}/consume  { token }               → consume + setea cookie hbx_tapp_sid
GET  /api/tenant-app-auth/{boxId}/me                                → { tenantAppUser } o { tenantAppUser: null }
POST /api/tenant-app-auth/{boxId}/logout                            → limpia cookie
```

`{boxId}` va en la URL en las 5 rutas por consistencia con el resto del sistema (mismo shape que `/api/app-auth/{boxId}/...`), aunque `request`/`verify`/`consume` internamente solo necesitan `resolveBoxDb(env, boxId, request)` para sacar el `tenantId` del box (`boxInfo` ya trae `tenantSlug` — hace falta agregar `tenant_id` crudo a lo que devuelve `resolveBoxDb`/`getByShare`/`getByTenantSlug` en `internal.js`/`boxDb.js`, hoy exponen `tenant_slug` pero no el `id` — cambio menor, ver checklist).

```js
// packages/runtime/src/lib/tenantAppAuth.js (nuevo archivo, thin proxy a control-plane)

async function postRequest(request, env, boxId) {
  const boxInfo = await resolveBoxDb(env, boxId, request) // necesita traer tenant_id, ver nota arriba
  if (!boxInfo) return json({ error: 'box_not_found' }, 404)

  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const url = new URL(request.url)
  const returnPath = sanitizeReturnPath(body?.returnPath, url) // reusar de appAuth.js, fase 1 §5.1
  const magicLinkBase = `${url.origin}/api/tenant-app-auth/${boxId}/verify?return=${encodeURIComponent(returnPath)}&token=`

  const res = await fetch(`${env.HTMLBOX_CONTROL_PLANE_ORIGIN}/api/internal/tenant-app-auth/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-HTMLBox-Internal-Secret': env.HTMLBOX_INTERNAL_SECRET || '' },
    body: JSON.stringify({ tenantId: boxInfo.tenantId, email: body?.email, magicLinkBase }),
  })
  const data = await res.json().catch(() => ({ ok: true }))
  if (env.HTMLBOX_ENV === 'production') delete data._dev_preview
  return json(data)
}

async function postConsume(request, env, boxId) {
  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }

  const res = await fetch(`${env.HTMLBOX_CONTROL_PLANE_ORIGIN}/api/internal/tenant-app-auth/consume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-HTMLBox-Internal-Secret': env.HTMLBOX_INTERNAL_SECRET || '' },
    body: JSON.stringify({ token: body?.token }),
  })
  const data = await res.json()
  if (!res.ok || !data.ok) return json({ error: data.error || 'consume_failed' }, res.status || 400)

  // El cookie ya viene armado por control-plane (mismo Domain/Secure que
  // aplicaría ahí) — runtime solo lo reenvía en SU respuesta, que es la que
  // realmente llega al browser del visitante del box.
  return json({ ok: true, tenantAppUser: data.tenantAppUser }, 200, { 'Set-Cookie': data.cookie })
}
```

**Integración con `appDataApi.js`** (fase 2): `requireAppUser()` hoy solo intenta `validateAppSession` (fase 1, box-local). Se agrega un segundo intento, como fallback, antes de devolver `unauthenticated`:

```js
// Modificar requireAppUser() en appDataApi.js (fase 2 §2):
async function requireAppUser(env, boxId, request) {
  const info = await resolveBoxDb(env, boxId, request)
  if (!info) return { error: 'box_not_found', status: 404 }
  const client = await getBoxClient(env, info)

  const sid = getAppSessionIdFromRequest(request)
  const sess = await validateAppSession(client, sid)
  if (sess) return { client, appUser: sess.appUser, isTenantWide: false }

  // Fallback: ¿hay un tenant_app_user con acceso a ESTE box?
  const tsid = getTenantAppSessionIdFromRequest(request) // de appAuth.js/tenantAppAuth.js, reexportado
  if (tsid) {
    const res = await fetch(`${env.HTMLBOX_CONTROL_PLANE_ORIGIN}/api/internal/tenant-app-auth/access`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `hbx_tapp_sid=${tsid}`,
        'X-HTMLBox-Internal-Secret': env.HTMLBOX_INTERNAL_SECRET || '',
      },
      body: JSON.stringify({ boxId }),
    })
    const data = await res.json().catch(() => ({ allowed: false }))
    if (data.allowed) {
      // v1: acceso = ve todo, como un customer 'staff' sin owner_user_id
      // propio — se trata como cross-owner, análogo a como getRows/postUpsert
      // ya tratan scope='shared' (sin filtro). Ver §4 para por qué v1 no
      // valida `role` acá tampoco.
      return { client, appUser: { id: data.tenantAppUser.id, email: data.tenantAppUser.email }, isTenantWide: true }
    }
  }

  return { error: 'unauthenticated', status: 401 }
}
```

Y en `getRows`/`postUpsert` (fase 2 §2), la única diferencia es que `isTenantWide` se comporta como el `scope==='shared'` de una tabla `'private'` — ve todo, sin filtrar por `owner_user_id`:

```js
// Dentro de getRows, reemplazar el bloque `if (scope === 'private') { ... }` por:
if (scope === 'private' && !auth.isTenantWide) {
  sql += ` AND owner_user_id = ?1`
  args.push(auth.appUser.id)
}
// isTenantWide → sin filtro, ve todas las filas de todos los customers de ESTE box.

// postUpsert: si auth.isTenantWide, no tiene sentido "escribir como si fuera
// un customer" (¿a nombre de quién quedaría la fila?) — devolver 403 con un
// error claro en vez de inventar un owner. Ver §4, no bloqueante para v1.
if (auth.isTenantWide) return json({ error: 'tenant_wide_users_are_read_only_in_v1' }, 403)
```

## 4. Alcance v1 — igual de trivial que las fases anteriores, a propósito

Acceso = ver todo, sin restricción, ni de lectura/escritura por acción ni de "puede ver pero no escribir". La columna `role` en `htmlbox_tenant_app_access` existe pero no se lee en ningún `if` de esta spec — es la tercera vez que se repite este patrón (fase 1 §7 `role` en `app_users`, fase 2 no la reintrodujo, ahora acá) y es intencional: **todas** las specs de "usuarios de las apps" dejan la puerta abierta a un sistema de roles/permisos único, que se diseña una sola vez cuando llegue esa fase — no antes, y no distinto en cada una de estas specs.

Con la limitación explícita de arriba (`postUpsert` devuelve 403 para `tenant_wide` — no hay "a nombre de quién" queda una escritura de alguien que no es dueño de nada puntual): en v1, un usuario centralizado **lee** todo lo que su acceso alcanza, no escribe. Escribir a nombre de un tenant_app_user es exactamente el tipo de decisión que depende de cómo se diseñe el sistema de roles — no se resuelve a medias acá.

## 5. Qué queda fuera de esta spec (no bloqueante)

- **Auto-registro (`signup_mode='open'`) para usuarios centralizados.** A diferencia de la fase 2, acá NO existe — un `tenant_app_user` siempre lo da de alta el tenant a mano. Tiene sentido: esta capa es para gente de confianza del tenant (staff, no clientes anónimos), invitación explícita es lo correcto por defecto y no hace falta un modo alternativo.
- **Permisos de escritura para usuarios centralizados** (§4) — hoy es solo lectura.
- **UI para elegir "en qué box estoy parado"** cuando un `tenant_app_user` tiene acceso a varios — mismo comentario que en el borrador B2B descartado: es trabajo del tenant sobre el HTML de su propio box, no de HTMLBox como plataforma.
- **Revocar acceso en cascada al remover a alguien de un workspace/tenant en el sistema de plataforma.** Este sistema (`htmlbox_tenant_app_users`) es completamente independiente de `htmlbox_users`/`htmlbox_memberships` — dar de baja a alguien como colaborador de plataforma NO afecta sus accesos acá, son dos sistemas distintos con dueños distintos. Si en la práctica siempre va a ser la misma persona en ambos sistemas, es una mejora de UX a futuro (un solo botón "dar de baja a esta persona de todo"), no algo que resolver ahora.

## 6. Checklist de implementación

1. Migración D1 nueva: `htmlbox_tenant_app_users`/`_sessions`/`_magic_links`/`_access` (§1.1).
2. Agregar a `session.js`: `isTenantAppRateLimited`, `createTenantAppMagicLink`, `consumeTenantAppMagicLink`, `findTenantAppUserByEmail`, `createTenantAppSession`, `deleteTenantAppSession`, `validateTenantAppSession`, `checkTenantAppAccess`, `buildTenantAppSessionCookie`, `buildTenantAppClearCookie`, `getTenantAppSessionIdFromRequest` (§2.1, §2.2).
3. Agregar a `internal.js`: `/api/internal/tenant-app-auth/request|consume|access`, en `requiresInternalSecret` (§2.3).
4. **Cambio previo necesario**: `resolveBoxDb`/`getByShare`/`getByTenantSlug` (`boxDb.js`, `internal.js`) hoy devuelven `tenant_slug` pero no `tenant_id` crudo — agregarlo a los `SELECT` y al objeto que devuelven, lo necesita `postRequest` de `tenantAppAuth.js` (§3).
5. Crear `packages/runtime/src/lib/tenantAppAuth.js` con las 5 rutas públicas (§3), wirear en `worker.js`.
6. Modificar `requireAppUser()`, `getRows()`, `postUpsert()` de `appDataApi.js` (fase 2) para el fallback `isTenantWide` (§3).
7. Nuevas rutas admin en `control-plane` (portal, sesión de plataforma, `assertTenantScope`): `POST/GET /api/tenant-app-users` (alta/listado), `POST /api/tenant-app-users/{id}/access` (otorgar — body `{scope_type, scope_id}`), `DELETE /api/tenant-app-users/{id}/access/{accessId}` (revocar).
8. Nueva página/sección en el portal (fuera del editor de un box puntual — esto es a nivel tenant, no a nivel box) para administrar estos usuarios y sus accesos.
9. Probar: dar de alta un `tenant_app_user`, otorgarle acceso `scope_type='box'` a un box puntual — confirmar que ve los customers de ESE box (sin filtrar por `owner_user_id`) y que NO puede acceder a otro box del mismo tenant sin acceso otorgado.
10. Probar `scope_type='workspace'`: otorgar acceso a un workspace con 2+ boxes, confirmar que alcanza a ambos sin altas individuales.
11. Probar `scope_type='tenant'`: confirmar que alcanza incluso a un box creado DESPUÉS de otorgar el acceso (no hay que re-otorgar nada al crear apps nuevas).
12. Probar que `postUpsert` devuelve `tenant_wide_users_are_read_only_in_v1` para un `tenant_app_user`, en cualquier scope.
13. Probar que la cookie `hbx_tapp_sid` viaja correctamente entre dos boxes distintos del mismo tenant bajo subdominios distintos (`Domain=.htmlbox.dev`) — a diferencia de `hbx_app_sid` de la fase 1, que NO debe viajar entre boxes.
