# HTMLBox — Spec: usuarios de las apps (end-users de los boxes)

Repo: `htmlbox`. Spec para que el equipo lo implemente al pie de la letra. Fase 1 de una funcionalidad que se construirá en varias tandas — ver §0 y §9 para el alcance exacto de esta fase y lo que queda deliberadamente afuera.

## 0. Qué es y qué NO es

Hoy HTMLBox tiene un solo tipo de "usuario": el usuario **plataforma** (`htmlbox_users` en D1, tabla del control-plane) — la gente que entra al portal a crear/editar boxes, con roles `owner`/`editor`/`viewer` sobre un **workspace** (`htmlbox_memberships`). Ese sistema es completamente ajeno a esta spec y no se toca.

Esta spec agrega un **segundo tipo de usuario, totalmente distinto**: los **usuarios de la app** — la gente que el tenant invita para que use la app que él construyó y publicó como box (sus clientes, su equipo, quien sea). Ejemplo: un tenant construye un box "Inventario de la tienda" y quiere que sus 5 empleados puedan entrar a verlo con su propio login, sin compartir una sola cuenta.

Puntos clave de diseño, ya decididos:

- **Autenticación por magic link vía email** (confirmado con el usuario — no invitación sin email, no usuario/contraseña).
- **v1 = autorización trivial**: cualquier usuario de la app con sesión válida tiene acceso completo al box. No hay roles ni permisos todavía — pero el schema se diseña desde ahora para que agregarlos después (fase 2+, ver §9) no requiera una migración rompedora.
- **Aislamiento total por box**: los usuarios de la app de un box viven en la **Turso DB propia de ese box** (la misma DB donde ya viven `htmlbox_tables`/`htmlbox_files`/etc. vía `boxSchema.js`), NO en D1. Esto es consistente con el principio ya establecido en todo el proyecto: **siempre DB aislada** por box. Un usuario de la app del box A no existe en ningún lado dentro del box B — son físicamente DBs distintas.
- Esto significa que **no hay usuarios de app compartidos entre boxes**. Si el mismo humano usa dos boxes del mismo tenant, son dos altas independientes (dos emails, potencialmente el mismo, en dos DBs distintas). Eso es intencional para v1 — no bloqueante, ver §9.

## 1. Dónde vive cada pieza (y por qué)

| Pieza | Vive en | Por qué |
|---|---|---|
| Tablas `htmlbox_app_users`/`htmlbox_app_sessions`/`htmlbox_app_magic_links` | Turso DB del box (misma DB que `htmlbox_tables` etc.) | Aislamiento por box — regla fija del proyecto |
| Lógica de auth (`appAuth.js`) | `packages/runtime/src/lib/` | `runtime` es el worker público que ya sirve el box y su Data API (`dataApi.js`, `boxDb.js` viven ahí); el usuario de la app nunca debe pasar por el control-plane |
| Envío del email del magic link | Delegado a `control-plane` vía nuevo endpoint interno | `runtime/wrangler.jsonc` **no tiene binding `send_email`** (confirmado — solo tiene `vars`, `routes`, `r2_buckets`, `kv_namespaces`, `observability`). El control-plane ya tiene el binding `MAIL` y las plantillas en `lib/email.js`. Duplicar infraestructura de email en runtime no tiene sentido — se reusa/generaliza lo que ya existe. |
| Nuevas rutas HTTP públicas (`/api/app-auth/{boxId}/...`) | `runtime` | Mismo worker que sirve `/api/data/{boxId}/...` — mismo patrón de URL, mismo lugar |
| UI para que el tenant administre usuarios de su app | `portal`, nueva tab "Usuarios" en el editor de box | Ahí vive ya toda la UI de gestión de un box |

## 2. Schema nuevo en la Turso DB del box

Se agrega a `packages/shared/src/boxSchema.js`, **como una función separada de `applyBoxSchema`**, no fusionada con `BOX_BASE_SCHEMA_SQL`. Razón: no todos los boxes van a usar "usuarios de la app" — muchos boxes son solo un dashboard interno de una sola persona. Aplicar estas 3 tablas a cada box que se crea (incluso los que nunca las van a usar) es ruido. En cambio, el schema se aplica **on-demand, la primera vez que el tenant activa la tab "Usuarios" en un box** (ver §6).

```js
// packages/shared/src/boxSchema.js — agregar junto a BOX_BASE_SCHEMA_SQL

export const APP_USERS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS htmlbox_app_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  disabled_at TEXT
);

CREATE TABLE IF NOT EXISTS htmlbox_app_sessions (
  id TEXT PRIMARY KEY,
  app_user_id TEXT NOT NULL REFERENCES htmlbox_app_users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS htmlbox_app_magic_links (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_htmlbox_app_sessions_user ON htmlbox_app_sessions(app_user_id);
CREATE INDEX IF NOT EXISTS idx_htmlbox_app_sessions_expires ON htmlbox_app_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_htmlbox_app_magic_links_email_created ON htmlbox_app_magic_links(email, created_at);
CREATE INDEX IF NOT EXISTS idx_htmlbox_app_magic_links_expires ON htmlbox_app_magic_links(expires_at);
`

// Idéntico patrón a applyBoxSchema() — reusa el mismo split-por-';' y el
// mismo fallback exec()/execute() (ver comentario original en applyBoxSchema).
export async function applyAppUsersSchema(client) {
  const stmts = APP_USERS_SCHEMA_SQL
    .split(/;\s*$/m)
    .map(s => s.trim())
    .filter(s => s.length > 0)

  for (const stmt of stmts) {
    if (typeof client.exec === 'function') {
      await client.exec(stmt)
    } else if (typeof client.execute === 'function') {
      await client.execute(stmt)
    } else {
      throw new Error('applyAppUsersSchema: cliente Turso no expone exec() ni execute()')
    }
  }
}
```

Notas de diseño de columnas, pensando en la fase de roles/permisos (§9) sin comprometernos a implementarla ahora:

- `role TEXT NOT NULL DEFAULT 'member'` — existe desde v1 pero **no se valida ni se usa para autorizar nada todavía** (ver §7). Está ahí para que cuando llegue la fase de roles/permisos, no haga falta una migración `ALTER TABLE ADD COLUMN` sobre DBs de boxes que ya tienen usuarios reales.
- `disabled_at` — permite "desactivar" un usuario de la app sin borrarlo (típico requisito de auditoría). v1 lo usa: un usuario con `disabled_at` no nulo no puede pedir magic link ni loguearse (ver `appAuth.js` en §3).
- **NO** se agrega una tabla de "acciones"/"permisos" en esta fase — eso es explícitamente fase 3+ (§9) y su diseño depende de cómo la app declare sus acciones, algo que todavía no está definido.

## 3. `packages/runtime/src/lib/appAuth.js` (nuevo archivo)

Mirror funcional de `packages/control-plane/src/lib/session.js`, adaptado a: (a) trabajar contra un `client` de Turso del box en vez de `env.DB` (D1), (b) nombre de cookie distinto (`hbx_app_sid`, ver §6 — para no colisionar nunca con la cookie de sesión de plataforma `sid`), (c) `Path` de la cookie scoped a la ruta del box (también §6, crítico para que dos boxes bajo el mismo host/subdominio no se pisen la cookie).

```js
// packages/runtime/src/lib/appAuth.js
//
// Auth de usuarios de la app (end-users del box, NO usuarios de la
// plataforma HTMLBox). Vive en runtime porque es el worker público que
// sirve el box. Cada box tiene su propia Turso DB — el aislamiento entre
// boxes es la DB física, no un WHERE box_id = ?.
//
// Convenciones (mismas que session.js del control-plane, con nombres
// distintos para no confundir ambos sistemas):
//   - Cookie "hbx_app_sid" HttpOnly SameSite=Lax, Path scoped al box (§6).
//   - Sesiones = random 32 bytes hex. TTL 30 días (AUTH_SESSION_TTL_DAYS).
//   - Magic links = random 32 bytes hex. TTL 15 min (AUTH_MAGICLINK_TTL_SEC).
//   - Rate limit: mismo AUTH_REQUEST_WINDOW_SEC / AUTH_REQUEST_MAX_PER_EMAIL
//     que la plataforma, pero contado contra htmlbox_app_magic_links del box.
//   - Consumo del magic link en POST (no GET) — anti-scanner de email.

import {
  AUTH_MAGICLINK_TTL_SEC, AUTH_SESSION_TTL_DAYS,
  AUTH_REQUEST_WINDOW_SEC, AUTH_REQUEST_MAX_PER_EMAIL,
} from '@htmlbox/shared'

export const APP_SESSION_COOKIE = 'hbx_app_sid'
export const APP_SESSION_TTL_SECONDS = AUTH_SESSION_TTL_DAYS * 24 * 60 * 60
export const APP_MAGIC_LINK_TTL_MS = AUTH_MAGICLINK_TTL_SEC * 1000

// --- Crypto (idéntico a session.js — no vale la pena importarlo cross-package
// solo por esto; una función de 4 líneas duplicada es más simple que acoplar
// runtime a control-plane) ---

export function randomToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// --- Magic links ---

export async function isRateLimited(client, email) {
  const result = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM htmlbox_app_magic_links
           WHERE email = ?1 AND created_at > datetime('now', '-${AUTH_REQUEST_WINDOW_SEC} seconds')`,
    args: [email],
  })
  const n = result.rows[0]?.n ?? 0
  return n >= AUTH_REQUEST_MAX_PER_EMAIL
}

export async function createMagicLink(client, email) {
  const id = randomToken()
  const expiresAt = new Date(Date.now() + APP_MAGIC_LINK_TTL_MS).toISOString().slice(0, 19).replace('T', ' ')
  await client.execute({
    sql: `INSERT INTO htmlbox_app_magic_links (id, email, expires_at) VALUES (?1, ?2, ?3)`,
    args: [id, email, expiresAt],
  })
  return { id, email, expiresAt }
}

export async function peekMagicLink(client, tokenId) {
  if (!tokenId) return { ok: false, reason: 'missing_token' }
  const result = await client.execute({
    sql: `SELECT id, email, expires_at, used_at FROM htmlbox_app_magic_links WHERE id = ?1`,
    args: [tokenId],
  })
  const row = result.rows[0]
  if (!row) return { ok: false, reason: 'invalid_token' }
  if (row.used_at) return { ok: false, reason: 'already_used' }
  const check = await client.execute({
    sql: `SELECT (datetime(?1) > datetime('now')) AS ok FROM (SELECT 1)`,
    args: [row.expires_at],
  })
  if (!check.rows[0]?.ok) return { ok: false, reason: 'expired' }
  return { ok: true, email: row.email }
}

export async function consumeMagicLink(client, tokenId) {
  const upd = await client.execute({
    sql: `UPDATE htmlbox_app_magic_links SET used_at = datetime('now')
           WHERE id = ?1 AND used_at IS NULL
             AND datetime(expires_at) > datetime('now')`,
    args: [tokenId],
  })
  if (!upd.rowsAffected) return null
  const result = await client.execute({
    sql: `SELECT email FROM htmlbox_app_magic_links WHERE id = ?1`,
    args: [tokenId],
  })
  return result.rows[0]?.email || null
}

// --- App users ---

// Busca el app-user por email; null si no existe o está deshabilitado.
export async function findAppUserByEmail(client, email) {
  const result = await client.execute({
    sql: `SELECT id, email, display_name, role, disabled_at FROM htmlbox_app_users WHERE email = ?1`,
    args: [email],
  })
  return result.rows[0] || null
}

// Crea el app-user si no existe todavía (alta implícita al consumir el
// primer magic link — el tenant ya lo "invitó" agregándolo desde el portal,
// ver §8; si el email NO fue agregado por el tenant, NO se crea acá — ver
// consumeAndLogin() más abajo, que exige que el usuario ya exista).
export async function createAppUser(client, email, displayName = null) {
  const id = `au_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
  await client.execute({
    sql: `INSERT INTO htmlbox_app_users (id, email, display_name) VALUES (?1, ?2, ?3)`,
    args: [id, email, displayName],
  })
  return { id, email, display_name: displayName, role: 'member', disabled_at: null }
}

// --- Sessions ---

export async function createAppSession(client, appUserId) {
  const id = randomToken()
  const expiresAt = new Date(Date.now() + APP_SESSION_TTL_SECONDS * 1000).toISOString().slice(0, 19).replace('T', ' ')
  await client.execute({
    sql: `INSERT INTO htmlbox_app_sessions (id, app_user_id, expires_at) VALUES (?1, ?2, ?3)`,
    args: [id, appUserId, expiresAt],
  })
  return { id, appUserId, expiresAt }
}

export async function deleteAppSession(client, sessionId) {
  if (!sessionId) return
  await client.execute({ sql: `DELETE FROM htmlbox_app_sessions WHERE id = ?1`, args: [sessionId] })
}

// Devuelve { sessionId, appUser } o null. appUser.disabled_at != null también
// invalida la sesión (por si el tenant deshabilita al usuario mientras tiene
// una sesión activa — se corta en el siguiente request, no inmediatamente,
// igual que el resto del sistema no tiene invalidación push).
export async function validateAppSession(client, sessionId) {
  if (!sessionId) return null
  const result = await client.execute({
    sql: `SELECT s.id AS sid, s.expires_at,
                 u.id AS user_id, u.email, u.display_name, u.role, u.disabled_at
            FROM htmlbox_app_sessions s
            JOIN htmlbox_app_users u ON u.id = s.app_user_id
           WHERE s.id = ?1
             AND datetime(s.expires_at) > datetime('now')`,
    args: [sessionId],
  })
  const row = result.rows[0]
  if (!row) return null
  if (row.disabled_at) return null
  return {
    sessionId: row.sid,
    appUser: { id: row.user_id, email: row.email, display_name: row.display_name, role: row.role },
  }
}

// --- Cookies ---
//
// `cookiePath` es OBLIGATORIO (a diferencia de session.js, que usa Path=/
// siempre) — ver §6 para por qué el path de esta cookie debe estar scoped
// al box exacto que la emitió.

export function buildAppSessionCookie(sessionId, cookiePath, secure) {
  const parts = [
    `${APP_SESSION_COOKIE}=${sessionId}`,
    `Max-Age=${APP_SESSION_TTL_SECONDS}`,
    `Path=${cookiePath}`,
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function buildAppClearCookie(cookiePath, secure) {
  const parts = [
    `${APP_SESSION_COOKIE}=`,
    'Max-Age=0',
    `Path=${cookiePath}`,
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function getAppSessionIdFromRequest(request) {
  const cookieHeader = request.headers.get('Cookie') || request.headers.get('cookie') || ''
  for (const part of cookieHeader.split(/;\s*/)) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === APP_SESSION_COOKIE) return part.slice(eq + 1).trim()
  }
  return null
}
```

Por qué `isRateLimited`/`createMagicLink`/etc. reciben `client` en vez de `env`: en `session.js` (control-plane) el D1 binding vive en `env.DB` y es global al Worker. Acá el cliente Turso es **específico del box** — se resuelve por request con `getBoxClient(env, boxInfo)` (ya existente en `boxDb.js`) y no tiene sentido esconder esa resolución dentro de cada función de auth.

## 4. Nuevo endpoint interno en control-plane: enviar el email

`runtime` no tiene binding de email — delega el envío al control-plane, que sí lo tiene. A diferencia del flujo de plataforma (`sendMagicLinkEmail` en `email.js`, que arma el link internamente apuntando siempre al portal), acá **el link ya viene armado por runtime** apuntando a `runtime` mismo (`{runtimeOrigin}/api/app-auth/{boxId}/verify?...`) — el control-plane no sabe ni le importa cuál es el origin de runtime.

### 4.1 `packages/control-plane/src/lib/email.js` — agregar función nueva

No se toca `sendMagicLinkEmail` (sigue siendo exclusivo del login de plataforma). Se agrega una función hermana:

```js
// Agregar en email.js, junto a renderMagicLinkEmail/sendMagicLinkEmail.
// A diferencia de sendMagicLinkEmail, acá el magicLink llega YA ARMADO
// (runtime lo construye apuntando a sí mismo) — esta función solo
// renderiza y envía, no decide el link.

function renderAppMagicLinkEmail({ toEmail, magicLink, boxName }) {
  const label = boxName ? `"${boxName}"` : 'la app'
  const subject = `Tu link de ingreso a ${label}`

  const textBody = `Hola,

Recibimos un pedido de acceso para ${toEmail} a ${label}.

Click acá para ingresar (válido por 15 minutos):
${magicLink}

Si no pediste este link, ignorá este mail.`

  const htmlBody = `<!doctype html>
<html><body style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 40px auto; padding: 0 20px; color: #1f2637;">
  <p>Hola,</p>
  <p>Recibimos un pedido de acceso para <strong>${escapeHtml(toEmail)}</strong> a ${escapeHtml(label)}.</p>
  <p style="margin: 28px 0;">
    <a href="${escapeHtml(magicLink)}" style="background: #6366f1; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Ingresar</a>
  </p>
  <p style="color: #666; font-size: 13px;">O copiá y pegá este link en tu navegador (válido por 15 minutos):<br><br><code style="background: #f4f6fb; padding: 6px 10px; border-radius: 4px; word-break: break-all;">${escapeHtml(magicLink)}</code></p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 28px 0;">
  <p style="color: #999; font-size: 12px;">Si no pediste este link, ignorá este mail.</p>
</body></html>`

  return { subject, textBody, htmlBody }
}

// Devuelve { sent, previewLink? } — mismo shape que sendMagicLinkEmail, para
// que el caller (routes/internal.js) lo pueda tratar igual.
export async function sendAppMagicLinkEmail(env, { toEmail, magicLink, boxName }) {
  const mode = (env.HTMLBOX_EMAIL_MODE || 'dev').toLowerCase()
  const fromAddress = env.HTMLBOX_EMAIL_FROM_ADDRESS || FROM_ADDRESS_DEFAULT
  const fromName = env.HTMLBOX_EMAIL_FROM_NAME || FROM_NAME_DEFAULT

  const { subject, textBody, htmlBody } = renderAppMagicLinkEmail({ toEmail, magicLink, boxName })

  if (mode === 'dev') {
    console.log('[email][dev][app-user] Magic link NO enviado. Pegá esto en el browser:')
    console.log(`  → ${magicLink}`)
    return { sent: false, previewLink: magicLink, mode: 'dev' }
  }

  if (mode === 'prod') {
    if (!env.MAIL || typeof env.MAIL.send !== 'function') {
      console.error('[email][prod][app-user] HTMLBOX_EMAIL_MODE=prod pero no hay binding MAIL.')
      return { sent: false, previewLink: magicLink, mode: 'prod-fallback', error: 'mail_binding_missing' }
    }
    try {
      await env.MAIL.send({
        from: { name: fromName, email: fromAddress },
        to: [{ email: toEmail }],
        subject, text: textBody, html: htmlBody,
      })
      return { sent: true, mode: 'prod' }
    } catch (err) {
      console.error('[email][prod][app-user] error enviando magic link:', err?.message || err)
      return { sent: false, previewLink: magicLink, mode: 'prod-fallback', error: err?.message || 'send_failed' }
    }
  }

  console.warn(`[email][app-user] HTMLBOX_EMAIL_MODE="${mode}" desconocido — cayendo a dev.`)
  return { sent: false, previewLink: magicLink, mode: 'dev-fallback' }
}
```

### 4.2 `packages/control-plane/src/routes/internal.js` — nueva ruta

Agregar al router de `handleInternal` (junto a las rutas existentes) y **agregar este path a `requiresInternalSecret`** — este endpoint dispara envío real de email, así que debe estar detrás del mismo secreto compartido que `/api/internal/boxes/*`:

```js
// En la condición requiresInternalSecret (arriba del todo de handleInternal):
const requiresInternalSecret =
  path.startsWith('/api/internal/boxes/') ||
  path === '/api/internal/whoami' ||
  path === '/api/internal/send-app-magic-link'   // ← agregar

// En el router, junto a los demás matches:
if (path === '/api/internal/send-app-magic-link' && method === 'POST') {
  return await postSendAppMagicLink(request, env)
}

// Import nuevo al principio del archivo:
import { sendAppMagicLinkEmail } from '../lib/email.js'

// Nueva función, junto a las demás del archivo:
async function postSendAppMagicLink(request, env) {
  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const toEmail = (body?.toEmail || '').trim().toLowerCase()
  const magicLink = body?.magicLink || ''
  const boxName = body?.boxName || null
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(toEmail) || !magicLink) {
    return json({ error: 'invalid_body' }, 400)
  }
  const result = await sendAppMagicLinkEmail(env, { toEmail, magicLink, boxName })
  return json(result)
}
```

## 5. Nuevas rutas en `runtime`

Mismo patrón de URL que la Data API existente (`/api/data/{boxId}/...`): las rutas van bajo `/api/app-auth/{boxId}/...`. Se agregan en `packages/runtime/src/worker.js`, con la lógica en un nuevo router dentro de `appAuth.js` (o un archivo hermano `routes/appAuthRoutes.js` si el equipo prefiere separar router de lógica — cualquiera de las dos formas es válida, lo que importa es el contrato de URL de abajo).

```
POST /api/app-auth/{boxId}/request   { email }              → pide magic link (respuesta genérica, anti-enumeración)
GET  /api/app-auth/{boxId}/verify?token=…&return=<path>     → página HTML que auto-POSTea al consume
POST /api/app-auth/{boxId}/consume   { token }               → consume + crea sesión + setea cookie
GET  /api/app-auth/{boxId}/me                                → sesión actual del app-user (o { appUser: null })
POST /api/app-auth/{boxId}/logout                            → cierra sesión
```

### 5.1 `postRequest` — pedir magic link

```js
async function postRequest(request, env, boxId) {
  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const email = (body?.email || '').trim().toLowerCase()
  const GENERIC = { ok: true, message: 'Si el email está habilitado, recibirás un link.' }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(GENERIC)

  const boxInfo = await resolveBoxDb(env, boxId, request)
  if (!boxInfo) return json({ error: 'box_not_found' }, 404)
  const client = await getBoxClient(env, boxInfo)

  // Solo mandamos magic link a emails que el tenant YA agregó como usuario
  // de la app (ver §8 — el alta la hace el tenant desde el portal). Esto
  // evita que cualquiera se "auto-registre" solo por pedir un link.
  const appUser = await findAppUserByEmail(client, email)
  if (!appUser || appUser.disabled_at) {
    // Misma respuesta genérica — no leak de qué emails existen.
    return json(GENERIC)
  }

  if (await isRateLimited(client, email)) {
    console.log(`[app-auth] rate-limited box=${boxId} email=${email}`)
    return json(GENERIC)
  }

  const { id: tokenId } = await createMagicLink(client, email)
  const url = new URL(request.url)
  const returnPath = sanitizeReturnPath(body?.returnPath, url)
  const verifyUrl = `${url.origin}/api/app-auth/${boxId}/verify?token=${tokenId}&return=${encodeURIComponent(returnPath)}`

  const emailResult = await sendAppMagicLinkViaControlPlane(env, {
    toEmail: email, magicLink: verifyUrl, boxName: boxInfo.boxSlug,
  })

  // Igual que el flujo de plataforma: en dev (o si prod falló) devolvemos
  // el preview link para no bloquear el desarrollo/QA. Gateado por
  // HTMLBOX_ENV del propio runtime, NUNCA en base a lo que devuelva el
  // control-plane a ciegas — así una prod mal configurada no empieza a
  // leakear links reales a cualquier browser.
  if (env.HTMLBOX_ENV !== 'production' && emailResult?.previewLink) {
    return json({ ...GENERIC, _dev_preview: emailResult.previewLink })
  }
  return json(GENERIC)
}

// Llama al endpoint interno del control-plane (§4.2).
async function sendAppMagicLinkViaControlPlane(env, { toEmail, magicLink, boxName }) {
  const origin = env.HTMLBOX_CONTROL_PLANE_ORIGIN
  if (!origin) throw new Error('appAuth: HTMLBOX_CONTROL_PLANE_ORIGIN no configurado')
  const headers = { 'Content-Type': 'application/json' }
  if (env.HTMLBOX_INTERNAL_SECRET) headers['X-HTMLBox-Internal-Secret'] = env.HTMLBOX_INTERNAL_SECRET
  const res = await fetch(`${origin}/api/internal/send-app-magic-link`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ toEmail, magicLink, boxName }),
  })
  if (!res.ok) return null
  return await res.json()
}

// Evita open-redirect: solo se acepta un path relativo (empieza con "/",
// no empieza con "//" — eso sería protocol-relative a otro host), si no,
// cae al root "/".
function sanitizeReturnPath(raw, url) {
  const p = typeof raw === 'string' ? raw : ''
  if (p.startsWith('/') && !p.startsWith('//')) return p
  return '/'
}
```

### 5.2 `getVerify` + `postConsume` — consumir el link y loguear

```js
async function getVerify(request, env, boxId) {
  const url = new URL(request.url)
  const token = url.searchParams.get('token')
  const returnPath = sanitizeReturnPath(url.searchParams.get('return'), url)

  const boxInfo = await resolveBoxDb(env, boxId, request)
  if (!boxInfo) return new Response('Box no encontrado', { status: 404 })
  const client = await getBoxClient(env, boxInfo)

  const peek = await peekMagicLink(client, token)
  if (!peek.ok) {
    return new Response(verifyErrorHtml(peek.reason), {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }
  return new Response(verifyConfirmHtml(boxId, token, returnPath), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

async function postConsume(request, env, boxId) {
  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const token = body?.token
  if (!token) return json({ error: 'missing_token' }, 400)

  const boxInfo = await resolveBoxDb(env, boxId, request)
  if (!boxInfo) return json({ error: 'box_not_found' }, 404)
  const client = await getBoxClient(env, boxInfo)

  const email = await consumeMagicLink(client, token)
  if (!email) return json({ error: 'invalid_or_expired_token' }, 400)

  const appUser = await findAppUserByEmail(client, email)
  // A diferencia del login de plataforma (que auto-crea el user), acá el
  // usuario de la app YA debe existir (lo agregó el tenant, §8). Si en el
  // ratísimo margen entre request→consume el tenant lo borró, cortamos.
  if (!appUser || appUser.disabled_at) return json({ error: 'user_not_found_or_disabled' }, 403)

  const sess = await createAppSession(client, appUser.id)
  const cookiePath = cookiePathForBox(boxInfo, boxId, new URL(request.url))
  const secure = shouldUseSecureCookie(request, env)
  const cookie = buildAppSessionCookie(sess.id, cookiePath, secure)
  return json({ ok: true, appUser: { id: appUser.id, email: appUser.email, display_name: appUser.display_name } }, 200, { 'Set-Cookie': cookie })
}
```

### 5.3 `getMe` / `postLogout`

```js
async function getMe(request, env, boxId) {
  const boxInfo = await resolveBoxDb(env, boxId, request)
  if (!boxInfo) return json({ error: 'box_not_found' }, 404)
  const client = await getBoxClient(env, boxInfo)
  const sid = getAppSessionIdFromRequest(request)
  const v = await validateAppSession(client, sid)
  if (!v) return json({ appUser: null })
  return json({ appUser: v.appUser })
}

async function postLogout(request, env, boxId) {
  const boxInfo = await resolveBoxDb(env, boxId, request)
  if (!boxInfo) return json({ error: 'box_not_found' }, 404)
  const client = await getBoxClient(env, boxInfo)
  const sid = getAppSessionIdFromRequest(request)
  await deleteAppSession(client, sid)
  const cookiePath = cookiePathForBox(boxInfo, boxId, new URL(request.url))
  const secure = shouldUseSecureCookie(request, env)
  return json({ ok: true }, 200, { 'Set-Cookie': buildAppClearCookie(cookiePath, secure) })
}
```

## 6. Cookie: nombre, Secure y **Path scoped al box**

Ya definido en `appAuth.js` (§3): la cookie se llama **`hbx_app_sid`**, nunca `sid` — así no hay ninguna chance de colisión con la cookie de sesión de plataforma (que además vive en otro dominio funcional: control-plane/portal vs. runtime).

**El punto crítico es el `Path`.** `resolver.js` ya deja claro que un mismo host puede servir varios boxes distintos por path (`{tenant}.htmlbox.dev/{boxSlugA}`, `{tenant}.htmlbox.dev/{boxSlugB}`) o que el mismo box puede tener múltiples rutas válidas según su modo (`/s/{shareId}` público, `/t/{tenant}/{boxSlug}` o `/{boxSlug}` privado). Si la cookie `hbx_app_sid` se setea con `Path=/`, dos boxes bajo el mismo subdominio se van a pisar la cookie entre sí (el segundo login sobrescribe al primero en el browser).

La defensa en profundidad es doble:

1. **Path scoped**: la cookie se setea con `Path` = el prefijo exacto de la ruta pública del box (`/s/{shareId}`, `/t/{tenant}/{boxSlug}` o `/{boxSlug}`), nunca `/`. Así, en el browser, la cookie de un box simplemente no viaja en absoluto a las requests de otro box que comparte host.
2. **Aislamiento físico de datos** (ya cubierto en §1/§3): aunque por algún bug el browser mandara la cookie a otro box, `validateAppSession()` corre contra la Turso DB de *ese* box específico — un session id que no existe en esa DB simplemente no valida. No hay ningún `WHERE box_id = ?` que se pueda saltear porque no existe una tabla compartida entre boxes.

```js
// Agregar a appAuth.js (o al router de rutas — donde el equipo prefiera,
// mientras quede junto a buildAppSessionCookie/buildAppClearCookie).
//
// boxInfo viene de resolveBoxDb() (boxSlug, tenantSlug). boxId es el id
// crudo de la URL (/api/app-auth/{boxId}/...). Reconstruimos el Path
// público real del box a partir de cómo llegó el request — mirando el
// header Referer (la página del box que hizo el fetch) es más confiable
// que adivinar el modo, porque el mismo boxId puede exponerse por más de
// una ruta (share vs. path-based vs. subdomain) a lo largo del tiempo.
function cookiePathForBox(boxInfo, boxId, requestUrl) {
  // Preferimos el Referer (la URL de la página del box que está llamando
  // a /api/app-auth/...) — de ahí sale el path exacto que el browser debe
  // scoped-ear.
  // Si no hay Referer usable, fallback a /{boxSlug} (el modo más común).
  return `/${boxInfo.boxSlug}`
}

function shouldUseSecureCookie(request, env) {
  if (env.HTMLBOX_COOKIE_SECURE === 'true') return true
  if (env.HTMLBOX_COOKIE_SECURE === 'false') return false
  const url = new URL(request.url)
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) return false
  return url.protocol === 'https:'
}
```

**Nota para el equipo, marcada explícitamente como algo a resolver durante la implementación** (no es ambigüedad de diseño, es un detalle que depende de probar contra los 3 modos reales): `cookiePathForBox` arriba usa `/{boxSlug}` a secas, que cubre el modo privado-por-subdominio (el más común). Para boxes servidos por `/s/{shareId}` o `/t/{tenant}/{boxSlug}`, el Path correcto es ese prefijo completo, no `/{boxSlug}`. Antes de implementar, leer `boxInfo.visibility` (ya viene en el objeto que devuelve `resolveBoxDb`) y el propio `request.url` para elegir el prefijo correcto entre los 3 casos de `resolver.js` — la función de arriba es el esqueleto, no el cálculo final de los 3 casos.

## 7. Autorización v1 (trivial, pero con las puertas abiertas para fase 2+)

Para esta fase: **cualquier `appUser` con sesión válida (`validateAppSession()` devuelve no-null) tiene acceso completo** a lo que sea que el box quiera exponerle. No hay chequeo de `role` en ningún lado del código de esta spec — la columna `role` existe en la tabla (§2) pero **ninguna función de `appAuth.js` la usa para decidir nada**. Eso es intencional: se agrega recién cuando exista la fase de roles/permisos (§9), y en ese momento el trabajo es agregar los chequeos, no migrar el schema.

Cómo lo usa el HTML del box (SDK): fuera del alcance mecánico de esta spec (el SDK — `packages/runtime/src/sdk/htmlbox-sdk.txt` — no se toca acá), pero el contrato para quien programe esa parte después es: llamar a `GET /api/app-auth/{boxId}/me` para saber si hay sesión, `POST /api/app-auth/{boxId}/request` para pedir el link, y confiar en que si `me` devuelve un `appUser` no-null, ese usuario tiene acceso completo.

## 8. UI en el portal — tab "Usuarios" del box

Nueva tab en el editor de box del portal (junto a "Editor HTML", "Datos", etc. en `packages/portal/src/ui-partials/main-panel.html.txt`), donde el tenant administra los usuarios de SU app. Usa el patrón ya establecido `apiFetch()` (ver `htmlbox-spec-migracion-apifetch.md` — este código nuevo debe usar `apiFetch()` desde el día uno, no `fetch()` crudo).

Como esta tab pega directo contra rutas de `runtime` (no del control-plane — los datos de usuarios de la app viven en la Turso DB del box, gestionada por runtime), usa el mismo patrón que ya existe en `dataTab()` para las llamadas a `${RUNTIME}` (ver `htmlbox-spec-migracion-apifetch.md` §"5 llamadas raw en `dataTab()` a `${RUNTIME}`" para el patrón exacto de URL base a usar).

Endpoints de administración necesarios (**nuevos, distintos de los de auth del §5** — estos requieren sesión de PLATAFORMA con rol editor+ sobre el box, no sesión de app-user):

```
GET    /api/app-auth/{boxId}/admin/users              → lista usuarios de la app (auth: sesión de plataforma, editor+)
POST   /api/app-auth/{boxId}/admin/users  { email, display_name } → agrega usuario
POST   /api/app-auth/{boxId}/admin/users/{id}/disable  → deshabilita (disabled_at = now)
POST   /api/app-auth/{boxId}/admin/users/{id}/enable   → reactiva (disabled_at = NULL)
DELETE /api/app-auth/{boxId}/admin/users/{id}          → borra (también borra sus sesiones — ON DELETE CASCADE ya lo cubre)
```

Estos van en `runtime` (mismo archivo/router que §5) pero **la auth es la de plataforma**, no `appAuth.js` — usan el mismo patrón `requireBox()` que ya existe en `dataApi.js` (líneas ~65-83, ya revisado — chequea sesión de plataforma vía `readSession()`/`checkMembership()` contra el control-plane, exige rol `editor` o superior). No se reinventa ese chequeo — se reusa tal cual.

```js
async function getAdminUsers(request, env, boxId) {
  const auth = await requireBox(env, boxId, request) // ya existe en dataApi.js
  if (auth.error) return json({ error: auth.error }, auth.status)

  const client = await getBoxClient(env, auth.info)
  const result = await client.execute(
    `SELECT id, email, display_name, role, created_at, disabled_at FROM htmlbox_app_users ORDER BY created_at DESC`
  )
  return json({ users: result.rows })
}

async function postAdminAddUser(request, env, boxId) {
  const auth = await requireBox(env, boxId, request)
  if (auth.error) return json({ error: auth.error }, auth.status)
  if (auth.auth.role === 'viewer') return json({ error: 'forbidden' }, 403)

  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const email = (body?.email || '').trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'invalid_email' }, 400)

  const client = await getBoxClient(env, auth.info)

  // La primera vez que se usa esta tab en un box, la tabla htmlbox_app_users
  // puede no existir todavía — aplicar el schema es idempotente (CREATE
  // TABLE IF NOT EXISTS), así que se puede llamar siempre sin chequear antes.
  await applyAppUsersSchema(client)

  const existing = await client.execute({ sql: `SELECT id FROM htmlbox_app_users WHERE email = ?1`, args: [email] })
  if (existing.rows.length) return json({ error: 'already_exists' }, 409)

  const id = `au_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
  await client.execute({
    sql: `INSERT INTO htmlbox_app_users (id, email, display_name) VALUES (?1, ?2, ?3)`,
    args: [id, email, body?.display_name || null],
  })
  return json({ ok: true, user: { id, email } })
}
```

`applyAppUsersSchema(client)` llamado en cada `postAdminAddUser` (idempotente, `CREATE TABLE IF NOT EXISTS`) es la forma más simple de "activar" la funcionalidad para un box sin necesitar un botón de "activar usuarios" separado ni un flag en D1 — la tab "Usuarios" simplemente funciona la primera vez que se usa. Costo: un `CREATE TABLE IF NOT EXISTS` extra en cada alta de usuario (barato, Turso lo resuelve en microsegundos) — si se vuelve un problema medible, cachear en KV que el box ya tiene el schema aplicado (mismo patrón TTL que `resolveBoxDb`), pero no hacerlo de entrada, es una optimización prematura.

## 9. Qué queda fuera de esta spec (fases futuras, explícitamente no bloqueante)

Esto es lo que el usuario planteó como visión completa, pero pidió explícitamente hacer en tandas — **nada de esto se implementa ahora**:

- **Roles y permisos reales.** La columna `role` existe (§2) pero no se valida en ningún lado. Cuando llegue esta fase: cada `appUser` tiene un `role`, y hay una tabla de mapeo `role → acciones permitidas`.
- **Una app declarando sus propias acciones ("una app declara todas sus acciones, una IA puede encontrarlas").** Esto requiere que el box exponga de alguna forma (¿un manifest JSON embebido en el HTML? ¿un análisis del HTML/JS por IA, similar a lo que ya hace `aiProvider.js`/`routes/ai.js` para otras cosas del proyecto?) qué acciones existen. Sin definir todavía — es la pieza más abierta de toda la visión y merece su propia spec de diseño cuando llegue el momento, no una implementación apurada ahora.
- **UI de "roles y permisos" poblada dinámicamente**, al estilo de la librería CASL ("ability") que el usuario mencionó como referencia de patrón — un editor visual donde el tenant arma qué puede hacer cada rol, alimentado por las acciones que la app declaró en el punto anterior.
- **Usuarios de app compartidos entre boxes del mismo tenant.** Hoy cada alta es por-box (mismo email en dos boxes = dos filas en dos DBs distintas, dos passwords/sesiones distintas). Si en el futuro se quiere "un login, todas mis apps", es un cambio de arquitectura bastante más grande (¿DB compartida a nivel tenant para identidad, con las Turso DBs de cada box referenciando solo el id? eso empieza a tensionar el principio de "siempre DB aislada" y necesita su propia conversación).
- **Registro de invitación con expiración/reenvío desde el portal** (hoy el alta en §8 es inmediata — el tenant escribe el email y ya puede loguear; no hay un estado "invitado, pendiente de aceptar").
- **Notificación al app-user de que fue agregado** (hoy no se manda ningún email al agregarlo — recién recibe email cuando él mismo pide el magic link). Es una mejora de UX menor, no bloqueante.

## 10. Checklist de implementación

1. Agregar `APP_USERS_SCHEMA_SQL` y `applyAppUsersSchema()` a `packages/shared/src/boxSchema.js` (§2).
2. Crear `packages/runtime/src/lib/appAuth.js` con todas las funciones de §3.
3. Agregar `sendAppMagicLinkEmail()`/`renderAppMagicLinkEmail()` a `packages/control-plane/src/lib/email.js` (§4.1).
4. Agregar la ruta `POST /api/internal/send-app-magic-link` a `packages/control-plane/src/routes/internal.js`, incluyéndola en `requiresInternalSecret` (§4.2).
5. Agregar las rutas públicas `/api/app-auth/{boxId}/request|verify|consume|me|logout` en `runtime` (§5), resolviendo el `cookiePathForBox()` correcto para los 3 modos de `resolver.js` (nota de §6 — esto es lo único que requiere pensar/probar contra el routing real, todo lo demás es mecánico).
6. Agregar las rutas de administración `/api/app-auth/{boxId}/admin/users*` en `runtime`, reusando `requireBox()` de `dataApi.js` (§8).
7. Agregar la tab "Usuarios" en `packages/portal/src/ui-partials/main-panel.html.txt` + el estado/métodos correspondientes en `app-script.html.txt`, usando `apiFetch()` (§8).
8. Probar el flujo completo en dev (`HTMLBOX_EMAIL_MODE=dev`, usar el `_dev_preview` link): tenant agrega un email desde el portal → simular al app-user pidiendo el magic link desde el box → consumir → confirmar que `GET /api/app-auth/{boxId}/me` devuelve el `appUser` → logout → confirmar que vuelve a `null`.
9. Probar el caso de colisión de cookie: dos boxes del mismo tenant bajo el mismo subdominio (`{tenant}.htmlbox.dev/boxA` y `{tenant}.htmlbox.dev/boxB`), loguear un app-user distinto en cada uno, confirmar en devtools que existen dos cookies `hbx_app_sid` con `Path` distinto y que cada una solo viaja a su box.
10. Probar deshabilitar un usuario (`disabled_at`) con una sesión activa — confirmar que el siguiente `GET /me` devuelve `null`.
