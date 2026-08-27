// src/lib/appAuth.js — auth de usuarios de la app (end-users del box, NO
// usuarios de la plataforma HTMLBox). Vive en runtime porque es el worker
// público que sirve el box. Cada box tiene su propia Turso DB — el
// aislamiento entre boxes es la DB física, no un WHERE box_id = ?.
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

// Busca el app-user por email; null si no existe.
export async function findAppUserByEmail(client, email) {
  const result = await client.execute({
    sql: `SELECT id, email, display_name, role, disabled_at FROM htmlbox_app_users WHERE email = ?1`,
    args: [email],
  })
  return result.rows[0] || null
}

// Crea el app-user si no existe todavía (alta implícita al consumir el
// primer magic link con signup_mode='open', ver htmlbox-spec-app-customers.md
// §3). En signup_mode='invite_only' (default) esto NO se llama desde
// postRequest — el tenant ya agregó al usuario desde el portal (§8).
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

// --- Settings (fase 2 — htmlbox-spec-app-customers.md §3) ---

export async function getSignupMode(client) {
  const result = await client.execute(
    `SELECT signup_mode FROM htmlbox_app_settings WHERE id = 1`,
  )
  return result.rows[0]?.signup_mode || 'invite_only'
}

export async function setSignupMode(client, mode) {
  if (!['invite_only', 'open'].includes(mode)) {
    throw new Error(`signup_mode inválido: ${mode}`)
  }
  await client.execute(
    `UPDATE htmlbox_app_settings SET signup_mode = ?1 WHERE id = 1`,
    [mode],
  )
  return { signup_mode: mode }
}

// --- Cookies ---
//
// `cookiePath` es OBLIGATORIO (a diferencia de session.js, que usa Path=/
// siempre) — ver §6 para por qué el path de esta cookie debe estar scoped
// al box exacto que la emitió. Si la cookie se setea con Path=/, dos boxes
// bajo el mismo subdominio se pisan la cookie entre sí (el segundo login
// sobrescribe al primero en el browser).

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

// Devuelve si la cookie de app-session debe llevar el flag `Secure`.
// Mismas reglas que session.js en control-plane: HTMLBOX_COOKIE_SECURE gana,
// después localhost/host, después protocolo del request.
export function shouldUseSecureCookie(request, env) {
  if (env.HTMLBOX_COOKIE_SECURE === 'true') return true
  if (env.HTMLBOX_COOKIE_SECURE === 'false') return false
  const url = new URL(request.url)
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) return false
  return url.protocol === 'https:'
}

// Devuelve el Path con el que la cookie de app-session se emite.
//
// Decisión (anexo de seguridad hallazgo 2): en vez de derivar el Path del
// header `Referer` (que en el flujo real nunca vale porque el `fetch()`
// a `/consume` se dispara desde `/api/app-auth/{boxId}/verify`, no desde la
// URL pública del box), usamos un Path determinístico basado en el `boxId`:
// la cookie va scoped a `/api/app-auth/{boxId}`, que es el único prefijo
// bajo el cual se sirven los endpoints auth de ESE box (`/me`, `/logout`,
// `/consume`, `/request`). Razones:
//
// - `boxId` es globalmente único (16 chars alfanuméricos random). Cero
//   colisión entre boxes, incluso si dos tenants tienen boxes con el mismo
//   `boxSlug` o el mismo box accesible por múltiples rutas
//   (subdomain + share + path-based).
// - Los endpoints auth son los únicos que necesitan la cookie — la página
//   pública del box (`/{boxSlug}`, `/s/{shareId}` o `/t/{tenant}/{slug}`)
//   es HTML estático y cualquier chequeo de sesión del lado del box se
//   hace desde JS llamando a `/api/app-auth/{boxId}/me`, donde la cookie
//   sí viaja.
// - Cero dependencia de headers inyectables por el browser (Referer es
//   facilmente falsificable o vacío, y según `Referrer-Policy` puede no
//   llegar al endpoint cross-origin).
// - Funciona idéntico para los 3 modos de ruteo (subdomain / path-based
//   / share) sin branching adicional.
//
// boxInfo y request ya no son necesarios pero quedan en la firma para
// compatibilidad con callers/tests existentes — se ignoran.
export function cookiePathForBox(boxInfo, boxId, request) {
  if (!boxId || !/^[a-z0-9]{16}$/.test(boxId)) {
    // Defensa: si el boxId no matchea el formato, no emitir una cookie
    // scopeada a un path arbitrario. Devolvemos '/' igual para no romper,
    // pero el llamador debería invalidar el request antes de llegar acá.
    return '/'
  }
  return `/api/app-auth/${boxId}`
}

// --- Sanity HTML (para /verify, vista de "click acá para entrar" anti-scanner) ---

export function verifyConfirmHtml(boxId, token, returnPath) {
  const safeReturn = String(returnPath || '/').replace(/[<>"]/g, '')
  const safeBox = String(boxId).replace(/[^a-z0-9]/g, '')
  const safeToken = String(token).replace(/[^a-f0-9]/g, '')
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ingresar al box</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 420px; margin: 80px auto; padding: 0 20px; color: #1f2637; background: #f4f6fb; }
  .card { background: #fff; padding: 32px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.06); text-align: center; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { font-size: 13px; color: #555; margin: 0 0 20px; }
  button { background: #6366f1; color: #fff; border: 0; padding: 12px 24px; border-radius: 6px; font-weight: 600; font-size: 14px; cursor: pointer; }
  button:disabled { background: #94a3b8; cursor: wait; }
  .err { color: #b91c1c; margin-top: 12px; font-size: 12px; }
</style>
</head>
<body>
  <div class="card">
    <h1>Confirmar ingreso</h1>
    <p>Tocá el botón para entrar al box. Esta página vence en 15 minutos.</p>
    <button id="go">Ingresar</button>
    <div class="err" id="err"></div>
  </div>
  <script>
    document.getElementById('go').addEventListener('click', async () => {
      const btn = document.getElementById('go')
      btn.disabled = true
      btn.textContent = 'Ingresando…'
      try {
        const res = await fetch('/api/app-auth/${safeBox}/consume', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: '${safeToken}' }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.ok) {
          document.getElementById('err').textContent = 'Error: ' + (data.error || res.status)
          btn.disabled = false
          btn.textContent = 'Reintentar'
          return
        }
        window.location.href = ${JSON.stringify(safeReturn)}
      } catch (err) {
        document.getElementById('err').textContent = 'Error: ' + (err && err.message || err)
        btn.disabled = false
        btn.textContent = 'Reintentar'
      }
    })
  </script>
</body>
</html>`
}

export function verifyErrorHtml(reason) {
  const messages = {
    missing_token: 'Link inválido (no incluye token).',
    invalid_token: 'Link inválido o ya consumido.',
    already_used: 'Este link ya fue usado. Pedí uno nuevo.',
    expired: 'El link venció. Pedí uno nuevo.',
  }
  const text = messages[reason] || 'Link inválido.'
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Link inválido</title>
<style>body { font-family: -apple-system, sans-serif; max-width: 420px; margin: 80px auto; padding: 0 20px; color: #1f2637; }</style>
</head>
<body>
  <h1 style="color:#b91c1c;">${text}</h1>
  <p style="color:#555;">Si llegó acá siguiendo un link de magic link, pedí uno nuevo desde la pantalla de login del box.</p>
</body>
</html>`
}