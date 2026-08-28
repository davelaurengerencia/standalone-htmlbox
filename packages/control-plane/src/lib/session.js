// src/lib/session.js — port de sivocloud/control-plane/auth.js, adaptado a HTMLBox.
//
// Convenciones:
//   - Cookie "sid" HttpOnly SameSite=Lax. Domain configurable por var
//     HTMLBOX_SESSION_DOMAIN (en prod ".sivocloud.dev", en dev "" host-only).
//   - Sesiones = random 32 bytes hex. TTL 30 días.
//   - Magic links = random 32 bytes hex. TTL 15 min.
//   - Rate limit: 1 magic link pedido cada 60s por email.
//   - Consumo del magic link en POST (no GET).

import {
  SESSION_COOKIE_NAME, SESSION_COOKIE_DOMAIN,
  AUTH_MAGICLINK_TTL_SEC, AUTH_SESSION_TTL_DAYS,
  AUTH_REQUEST_WINDOW_SEC, AUTH_REQUEST_MAX_PER_EMAIL,
  ROLE_OWNER, ROLE_EDITOR, ROLE_VIEWER,
} from '@htmlbox/shared'

// --- Constantes exportadas ---

export const SESSION_TTL_SECONDS = AUTH_SESSION_TTL_DAYS * 24 * 60 * 60
export const MAGIC_LINK_TTL_MS = AUTH_MAGICLINK_TTL_SEC * 1000
export const RATE_LIMIT_WINDOW_MS = AUTH_REQUEST_WINDOW_SEC * 1000
export const SESSION_COOKIE = SESSION_COOKIE_NAME

// --- Crypto ---

export function randomToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Devuelve si la cookie de sesión debe llevar el flag `Secure`.
//
// En `wrangler dev --remote` request.url refleja el protocolo del edge
// (https:) aunque el browser esté hablando HTTP con controlplane.localhost.
// Si mandamos Secure, el browser rechaza el Set-Cookie porque él ve http://.
//
// Reglas:
//   - Si HTMLBOX_COOKIE_SECURE está seteado explícito ('true'/'false'), gana.
//   - Si el hostname del request es *.localhost o localhost, NO usar Secure.
//   - Si no, deferir a request.url.protocol.
function shouldUseSecureCookie(request, env) {
  if (env.HTMLBOX_COOKIE_SECURE === 'true')  return true
  if (env.HTMLBOX_COOKIE_SECURE === 'false') return false
  const url = new URL(request.url)
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) return false
  return url.protocol === 'https:'
}

// Devuelve el valor del atributo Domain de la cookie. '' = host-only (dev).
//
// Reglas:
//   1. Si el request viene proxied desde un portal en un dominio que NO es
//      *.sivocloud.dev (ej: htmlbox-portal.sivocloud-latam.workers.dev), el
//      browser rechaza cookies con Domain que no matchea el origen del
//      response. Usamos host-only para que la cookie se guarde en el
//      origen actual del usuario.
//   2. Si el env var HTMLBOX_SESSION_DOMAIN está explícitamente set, gana.
//   3. Si el hostname del request es *.sivocloud.dev, usamos ".sivocloud.dev"
//      para compartir sesión entre subdomains.
//   4. Si nada matchea, host-only (dev).
function getCookieDomain(request, env) {
  const url = new URL(request.url)
  const origin = request.headers.get('Origin') || ''
  const referer = request.headers.get('Referer') || ''
  const userHost = extractHost(origin) || extractHost(referer)

  // (1) Portal en dominio no-sivocloud.dev → host-only
  if (userHost && !userHost.endsWith('.sivocloud.dev') && !userHost.endsWith('.localhost')) {
    return ''
  }

  // (2) Override por env var
  if (env.HTMLBOX_SESSION_DOMAIN) return env.HTMLBOX_SESSION_DOMAIN

  // (3) Producción *.sivocloud.dev
  if (url.hostname.endsWith('.sivocloud.dev')) return '.sivocloud.dev'

  // (4) Default
  return ''
}

function extractHost(url) {
  if (!url) return ''
  try { return new URL(url).hostname } catch { return '' }
}

// --- Magic links ---

export async function isRateLimited(env, email) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM htmlbox_magic_links
     WHERE email = ?1 AND created_at > datetime('now', '-${AUTH_REQUEST_WINDOW_SEC} seconds')`
  ).bind(email).first()
  return (row?.n ?? 0) >= AUTH_REQUEST_MAX_PER_EMAIL
}

export async function createMagicLink(env, email, origin = 'portal') {
  const id = randomToken()
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS).toISOString().slice(0, 19).replace('T', ' ')
  // `origin` indica de qué UI vino el pedido ('portal' | 'admin') y determina
  // adónde redirige el confirmHtml después del login. Persistido en la fila
  // para que el `verify` (que es GET en el email link) sepa el destino.
  // Valores permitidos: 'portal' (default para backward compat), 'admin'.
  //
  // Renombrado de 'from' → 'origin': 'from' es palabra reservada SQL
  // (FROM keyword), el INSERT/SELECT tira "syntax error at offset N".
  // 'origin' no es keyword, queda legible y a prueba de futuros typos.
  const safeOrigin = (origin === 'admin' || origin === 'portal') ? origin : 'portal'
  await env.DB.prepare(
    `INSERT INTO htmlbox_magic_links (id, email, expires_at, origin) VALUES (?1, ?2, ?3, ?4)`
  ).bind(id, email, expiresAt, safeOrigin).run()
  return { id, email, expiresAt, origin: safeOrigin }
}

export async function peekMagicLink(env, tokenId) {
  if (!tokenId) return { ok: false, reason: 'missing_token' }
  const row = await env.DB.prepare(
    `SELECT id, email, expires_at, used_at, origin FROM htmlbox_magic_links WHERE id = ?1`
  ).bind(tokenId).first()
  if (!row) return { ok: false, reason: 'invalid_token' }
  if (row.used_at) return { ok: false, reason: 'already_used' }
  const stillValid = await env.DB.prepare(
    `SELECT (datetime(?1) > datetime('now')) AS ok FROM (SELECT 1)`
  ).bind(row.expires_at).first()
  if (!stillValid?.ok) return { ok: false, reason: 'expired' }
  return { ok: true, email: row.email, origin: row.origin || 'portal' }
}

export async function consumeMagicLink(env, tokenId) {
  const result = await env.DB.prepare(
    `UPDATE htmlbox_magic_links SET used_at = datetime('now')
     WHERE id = ?1 AND used_at IS NULL
       AND datetime(expires_at) > datetime('now')`
  ).bind(tokenId).run()
  if (!result.meta || result.meta.changes === 0) return null
  const row = await env.DB.prepare(
    `SELECT email FROM htmlbox_magic_links WHERE id = ?1`
  ).bind(tokenId).first()
  return row?.email || null
}

// --- Sessions ---

export async function createSession(env, userId) {
  const id = randomToken()
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString().slice(0, 19).replace('T', ' ')
  await env.DB.prepare(
    `INSERT INTO htmlbox_sessions (id, user_id, expires_at) VALUES (?1, ?2, ?3)`
  ).bind(id, userId, expiresAt).run()
  return { id, userId, expiresAt }
}

export async function deleteSession(env, sessionId) {
  if (!sessionId) return
  await env.DB.prepare(`DELETE FROM htmlbox_sessions WHERE id = ?1`).bind(sessionId).run()
}

export async function validateSession(env, sessionId) {
  if (!sessionId) return null
  const row = await env.DB.prepare(
    `SELECT s.id AS sid, s.expires_at,
            u.id AS user_id, u.email, u.display_name, u.tenant_id, u.is_platform_owner
       FROM htmlbox_sessions s
       JOIN htmlbox_users u ON u.id = s.user_id
      WHERE s.id = ?1
        AND datetime(s.expires_at) > datetime('now')`
  ).bind(sessionId).first()
  if (!row) return null
  return {
    sessionId: row.sid,
    user: {
      id: row.user_id,
      email: row.email,
      display_name: row.display_name,
      tenant_id: row.tenant_id,
      is_platform_owner: row.is_platform_owner === 1,
    },
  }
}

// --- Cookies ---

export function buildSessionCookie(request, sessionId, env) {
  const domain = getCookieDomain(request, env)
  const parts = [
    `${SESSION_COOKIE}=${sessionId}`,
    `Max-Age=${SESSION_TTL_SECONDS}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (domain) parts.push(`Domain=${domain}`)
  if (shouldUseSecureCookie(request, env)) parts.push('Secure')
  return parts.join('; ')
}

export function buildClearCookie(request, env) {
  const domain = getCookieDomain(request, env)
  const parts = [
    `${SESSION_COOKIE}=`,
    'Max-Age=0',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (domain) parts.push(`Domain=${domain}`)
  if (shouldUseSecureCookie(request, env)) parts.push('Secure')
  return parts.join('; ')
}

export function getSessionIdFromRequest(request) {
  const cookieHeader = request.headers.get('Cookie') || request.headers.get('cookie') || ''
  for (const part of cookieHeader.split(/;\s*/)) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (name === SESSION_COOKIE) return part.slice(eq + 1).trim()
  }
  return null
}

// --- Scoping (HTMLBox) ---

export function assertTenantScope(currentUser, tenantId, action = 'access') {
  if (!currentUser) throw new Error('No hay sesión activa.')
  if (currentUser.is_platform_owner) return
  if (currentUser.tenant_id !== tenantId) {
    throw new Error(`Sin permiso para ${action} el tenant "${tenantId}"`)
  }
}

export async function assertWorkspaceScope(env, currentUser, workspaceId, action = 'access') {
  if (!currentUser) throw new Error('No hay sesión activa.')
  const ws = await env.DB.prepare(
    `SELECT id, tenant_id FROM htmlbox_workspaces WHERE id = ?1`
  ).bind(workspaceId).first()
  if (!ws) throw new Error(`Workspace "${workspaceId}" no existe.`)
  // Para platform owners: si el workspace pertenece a un tenant que el
  // user creó (tenant_id en ws), devolvemos rol 'owner' implícito. Esto
  // cubre el caso típico (platform owner crea tenant y workspace y luego
  // opera sobre ellos sin tener fila explícita en htmlbox_memberships).
  if (currentUser.is_platform_owner) {
    return { ...ws, role: ROLE_OWNER }
  }
  if (ws.tenant_id !== currentUser.tenant_id) {
    throw new Error(`Sin permiso para ${action} el workspace "${workspaceId}".`)
  }
  // rol mínimo: viewer
  const m = await env.DB.prepare(
    `SELECT role FROM htmlbox_memberships WHERE user_id = ?1 AND workspace_id = ?2`
  ).bind(currentUser.id, workspaceId).first()
  if (!m) throw new Error(`Sin membresía en el workspace "${workspaceId}".`)
  return { ...ws, role: m.role }
}

export function requireRole(membership, ...allowed) {
  if (!membership?.role) throw new Error('Sin membresía.')
  if (!allowed.includes(membership.role)) {
    throw new Error(`Rol "${membership.role}" no autorizado (requiere uno de: ${allowed.join(', ')})`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fase 3 — htmlbox-spec-app-users-centralized.md
//
// Tenant app users: identidad + accesos, separados. Vive en D1 (control-plane)
// porque cruza boxes/workspaces. Mismo mecanismo de magic link que plataforma
// (randomToken reusado) y que app-users por-box (mismas constantes TTL), pero
// contra htmlbox_tenant_app_*.
//
// Cookie: `hbx_tapp_sid`, Domain-scoped (no Path-scoped como hbx_app_sid) para
// que viaje a cualquier box del tenant. Reusa getCookieDomain() y
// shouldUseSecureCookie() de arriba (mismas reglas que `sid` plataforma).
// ─────────────────────────────────────────────────────────────────────────────

const TENANT_APP_SESSION_COOKIE = 'hbx_tapp_sid'

// --- Magic links ---

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

// --- Tenant app users ---

export async function findTenantAppUserByEmail(env, tenantId, email) {
  return await env.DB.prepare(
    `SELECT id, email, display_name, disabled_at
       FROM htmlbox_tenant_app_users
      WHERE tenant_id = ?1 AND email = ?2`
  ).bind(tenantId, email).first()
}

export async function createTenantAppUser(env, tenantId, email, displayName = null) {
  const id = `tu_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
  await env.DB.prepare(
    `INSERT INTO htmlbox_tenant_app_users (id, tenant_id, email, display_name) VALUES (?1, ?2, ?3, ?4)`
  ).bind(id, tenantId, email, displayName).run()
  return { id, tenant_id: tenantId, email, display_name: displayName }
}

// --- Sessions ---

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

export async function validateTenantAppSession(env, sessionId) {
  if (!sessionId) return null
  const row = await env.DB.prepare(
    `SELECT s.id AS sid, u.id AS user_id, u.email, u.display_name, u.tenant_id, u.disabled_at
       FROM htmlbox_tenant_app_sessions s
       JOIN htmlbox_tenant_app_users u ON u.id = s.tenant_app_user_id
      WHERE s.id = ?1 AND datetime(s.expires_at) > datetime('now')`
  ).bind(sessionId).first()
  if (!row || row.disabled_at) return null
  return {
    sessionId: row.sid,
    tenantAppUser: {
      id: row.user_id,
      email: row.email,
      display_name: row.display_name,
      tenant_id: row.tenant_id,
    },
  }
}

// --- Access checks ---

// Resuelve si un tenant_app_user tiene acceso a un box puntual, mirando las
// 3 formas posibles de acceso (tenant entero / workspace / box puntual).
// box debe traer { id, tenant_id, workspace_id }.
//
// Defensa en profundidad (anexo de seguridad hallazgo 3): el JOIN con
// htmlbox_tenant_app_users acá adentro garantiza que un tenant_app_user de
// OTRO tenant NO puede acceder a boxes de este tenant aunque tenga una fila
// con scope_type='tenant' apuntando a otro tenant — si esa fila existiera
// por bug, simplemente no matchea porque u.tenant_id != box.tenant_id.
// Antes este check vivía solo en el caller (postTenantAppAccessCheck en
// internal.js) — si otro caller olvidaba replicarlo, abría un cross-tenant.
// Ahora es parte de la función.
export async function checkTenantAppAccess(env, tenantAppUserId, box) {
  const row = await env.DB.prepare(`
    SELECT a.role FROM htmlbox_tenant_app_access a
      JOIN htmlbox_tenant_app_users u ON u.id = a.tenant_app_user_id
     WHERE a.tenant_app_user_id = ?1
       AND u.tenant_id = ?4
       AND (
         a.scope_type = 'tenant'
         OR (a.scope_type = 'workspace' AND a.scope_id = ?2)
         OR (a.scope_type = 'box' AND a.scope_id = ?3)
       )
     ORDER BY CASE a.scope_type WHEN 'box' THEN 0 WHEN 'workspace' THEN 1 ELSE 2 END
     LIMIT 1
  `).bind(tenantAppUserId, box.workspace_id, box.id, box.tenant_id).first()
  return row ? { allowed: true, role: row.role } : { allowed: false }
}

// --- Cookie ---

export function buildTenantAppSessionCookie(request, sessionId, env) {
  const domain = getCookieDomain(request, env)
  const parts = [
    `${TENANT_APP_SESSION_COOKIE}=${sessionId}`,
    `Max-Age=${SESSION_TTL_SECONDS}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (domain) parts.push(`Domain=${domain}`)
  if (shouldUseSecureCookie(request, env)) parts.push('Secure')
  return parts.join('; ')
}

export function buildTenantAppClearCookie(request, env) {
  const domain = getCookieDomain(request, env)
  const parts = [
    `${TENANT_APP_SESSION_COOKIE}=`,
    'Max-Age=0',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ]
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

// Export del nombre de cookie por si alguien lo necesita (no se usa hoy).
export const TENANT_APP_SESSION_COOKIE_NAME = TENANT_APP_SESSION_COOKIE