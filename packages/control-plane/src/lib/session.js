// src/lib/session.js — port de sivocloud/control-plane/auth.js, adaptado a HTMLBox.
//
// Convenciones:
//   - Cookie "sid" HttpOnly SameSite=Lax. Domain configurable por var
//     HTMLBOX_SESSION_DOMAIN (en prod ".htmlbox.dev", en dev "" host-only).
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

// Devuelve el valor del atributo Domain de la cookie. '' = host-only (dev).
//
// Reglas:
//   1. Si el request viene proxied desde un portal en un dominio que NO es
//      *.htmlbox.dev (ej: htmlbox-portal.sivocloud-latam.workers.dev), el
//      browser rechaza cookies con Domain que no matchea el origen del
//      response. Usamos host-only para que la cookie se guarde en el
//      origen actual del usuario.
//   2. Si el env var HTMLBOX_SESSION_DOMAIN está explícitamente set, gana.
//   3. Si el hostname del request es *.htmlbox.dev, usamos ".htmlbox.dev"
//      para compartir sesión entre subdomains.
//   4. Si nada matchea, host-only (dev).
function getCookieDomain(request, env) {
  const url = new URL(request.url)
  const origin = request.headers.get('Origin') || ''
  const referer = request.headers.get('Referer') || ''
  const userHost = extractHost(origin) || extractHost(referer)

  // (1) Portal en dominio no-htmlbox.dev → host-only
  if (userHost && !userHost.endsWith('.htmlbox.dev') && !userHost.endsWith('.localhost')) {
    return ''
  }

  // (2) Override por env var
  if (env.HTMLBOX_SESSION_DOMAIN) return env.HTMLBOX_SESSION_DOMAIN

  // (3) Producción *.htmlbox.dev
  if (url.hostname.endsWith('.htmlbox.dev')) return '.htmlbox.dev'

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

export async function createMagicLink(env, email) {
  const id = randomToken()
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS).toISOString().slice(0, 19).replace('T', ' ')
  await env.DB.prepare(
    `INSERT INTO htmlbox_magic_links (id, email, expires_at) VALUES (?1, ?2, ?3)`
  ).bind(id, email, expiresAt).run()
  return { id, email, expiresAt }
}

export async function peekMagicLink(env, tokenId) {
  if (!tokenId) return { ok: false, reason: 'missing_token' }
  const row = await env.DB.prepare(
    `SELECT id, email, expires_at, used_at FROM htmlbox_magic_links WHERE id = ?1`
  ).bind(tokenId).first()
  if (!row) return { ok: false, reason: 'invalid_token' }
  if (row.used_at) return { ok: false, reason: 'already_used' }
  const stillValid = await env.DB.prepare(
    `SELECT (datetime(?1) > datetime('now')) AS ok FROM (SELECT 1)`
  ).bind(row.expires_at).first()
  if (!stillValid?.ok) return { ok: false, reason: 'expired' }
  return { ok: true, email: row.email }
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
  const url = new URL(request.url)
  const parts = [
    `${SESSION_COOKIE}=${sessionId}`,
    `Max-Age=${SESSION_TTL_SECONDS}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (domain) parts.push(`Domain=${domain}`)
  if (url.protocol === 'https:') parts.push('Secure')
  return parts.join('; ')
}

export function buildClearCookie(request, env) {
  const domain = getCookieDomain(request, env)
  const url = new URL(request.url)
  const parts = [
    `${SESSION_COOKIE}=`,
    'Max-Age=0',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (domain) parts.push(`Domain=${domain}`)
  if (url.protocol === 'https:') parts.push('Secure')
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