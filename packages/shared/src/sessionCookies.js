// src/sessionCookies.js — helpers de cookie + crypto compartidos.
//
// Extraído de packages/control-plane/src/lib/session.js (donde vivían antes
// como helpers privados). Ahora son reusables desde el paquete `auth` y
// cualquier otro Worker que necesite armar cookies de sesión `sid`.
//
// Ver docs/htmlbox-spec-auth-centralizado.md §8.

import {
  SESSION_COOKIE_NAME, SESSION_COOKIE_DOMAIN,
  AUTH_SESSION_TTL_DAYS, AUTH_MAGICLINK_TTL_SEC,
} from './constants.js'

export const SESSION_COOKIE = SESSION_COOKIE_NAME
export const SESSION_TTL_SECONDS = AUTH_SESSION_TTL_DAYS * 24 * 60 * 60
export const MAGIC_LINK_TTL_MS = AUTH_MAGICLINK_TTL_SEC * 1000

// --- Crypto ---

export function randomToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// --- Cookie domain/secure detection ---

function extractHost(url) {
  if (!url) return ''
  try { return new URL(url).hostname } catch { return '' }
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
//   - Si el browser está en localhost (userHost extraído de Origin/Referer),
//     NO usar Secure — el browser habla HTTP, rechazaría Secure.
//   - Si no, deferir a request.url.protocol.
function shouldUseSecureCookie(request, env) {
  if (env.HTMLBOX_COOKIE_SECURE === 'true')  return true
  if (env.HTMLBOX_COOKIE_SECURE === 'false') return false
  const url = new URL(request.url)
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) return false
  const origin = request.headers.get('Origin') || ''
  const referer = request.headers.get('Referer') || ''
  const userHost = extractHost(origin) || extractHost(referer)
  if (userHost && (userHost === 'localhost' || userHost.endsWith('.localhost'))) return false
  return url.protocol === 'https:'
}

// Devuelve el valor del atributo Domain de la cookie. '' = host-only (dev).
//
// Reglas (en orden):
//   1. LOCAL dev gana siempre — sin importar qué diga HTMLBOX_SESSION_DOMAIN.
//      Con wrangler dev --remote, .dev.vars no carga y la var top-level
//      (HTMLBOX_SESSION_DOMAIN='.sivocloud.dev' de prod) es lo único que
//      llega al worker. Sin este guard, el Set-Cookie trae Domain=.sivocloud.dev
//      y el browser lo rechaza silenciosamente porque el request vino de
//      *.localhost, no de *.sivocloud.dev. El chequeo usa tanto
//      `url.hostname` (defensivo — si el dev corrió con wrangler dev --local)
//      como `userHost` (del Origin/Referer del browser — el caso común con
//      --remote, donde url es el edge URL pero el browser está en localhost).
//   2. Portal en dominio no-sivocloud.no-localhost → host-only
//      (ej: htmlbox-portal.sivocloud-latam.workers.dev — el browser rechaza
//      cookies con Domain que no matchea su origen).
//   3. Override por env var (treat '' explícito como host-only intencional).
//   4. Producción *.sivocloud.dev → '.sivocloud.dev' (cross-subdomain).
//   5. Default → host-only.
function getCookieDomain(request, env) {
  const url = new URL(request.url)
  const origin = request.headers.get('Origin') || ''
  const referer = request.headers.get('Referer') || ''
  const userHost = extractHost(origin) || extractHost(referer)

  const isLocalHost = (h) => h === 'localhost' || h.endsWith('.localhost')
  if (isLocalHost(url.hostname) || (userHost && isLocalHost(userHost))) return ''

  if (userHost && !userHost.endsWith('.sivocloud.dev') && !userHost.endsWith('.localhost')) {
    return ''
  }

  if (env.HTMLBOX_SESSION_DOMAIN !== undefined) return env.HTMLBOX_SESSION_DOMAIN || ''

  if (url.hostname.endsWith('.sivocloud.dev')) return '.sivocloud.dev'

  return ''
}

// --- Cookie builders ---

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

// Helpers genéricos (exportados para que session.js pueda construir cookies
// con nombre custom — ej. tenant-app usa `hbx_tapp_sid`, no `sid`).
export { getCookieDomain, shouldUseSecureCookie }

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
