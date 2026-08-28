// src/lib/magic-link.js — construcción del magic link URL + render del email
// + invocación al flow-engine para el envío.
//
// Reemplaza lo que antes vivía en `lib/email.js`. Toda la lógica de
// armado de email (subject, textBody, htmlBody, escape, dev preview) se
// quedó acá; el envío en sí se delega al flow-engine vía runFlow().
//
// Resto de la lógica que vivía en email.js:
//   - Detección de host (X-Forwarded-Host / Origin / Referer / reqUrl.host).
//   - Resolución del magic link origin (`isDev`, `isBrowserHostLocal`).
//   - Gate de prod (`env.HTMLBOX_ENV === 'production'` → no exponer
//     `previewLink` ni `_dev_preview`, ver Fix 3).
//
// Nota: el envío DE emails se hace via flow-engine. El role de este archivo
// termina cuando llama `runFlow()` y devuelve su resultado.

import { runFlow } from './flows.js'

// ----------------------------------------------------------------------------
// Constantes y templates
// ----------------------------------------------------------------------------

const DEFAULT_FROM_ADDRESS = 'no-reply@sivocloud.dev'
const DEFAULT_FROM_NAME = 'SivoCloud'

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderMagicLinkEmail({ toEmail, magicLink, tenantName }) {
  const subject = `Tu link de ingreso a HTMLBox${tenantName ? ` — ${tenantName}` : ''}`

  const textBody = `Hola,

Recibimos un pedido de magic link para ${toEmail}.

Click acá para ingresar (válido por 15 minutos):
${magicLink}

Si no pediste este link, ignorá este mail.

— HTMLBox`

  const htmlBody = `<!doctype html>
<html><body style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 40px auto; padding: 0 20px; color: #1f2637;">
  <h2 style="color: #6366f1; margin: 0 0 20px;">HTMLBox</h2>
  <p>Hola,</p>
  <p>Recibimos un pedido de magic link para <strong>${escapeHtml(toEmail)}</strong>.</p>
  <p style="margin: 28px 0;">
    <a href="${escapeHtml(magicLink)}" style="background: #6366f1; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Ingresar a HTMLBox</a>
  </p>
  <p style="color: #666; font-size: 13px;">O copiá y pegá este link en tu navegador (válido por 15 minutos):<br><br><code style="background: #f4f6fb; padding: 6px 10px; border-radius: 4px; word-break: break-all;">${escapeHtml(magicLink)}</code></p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 28px 0;">
  <p style="color: #999; font-size: 12px;">Si no pediste este link, ignorá este mail.</p>
</body></html>`

  return { subject, textBody, htmlBody }
}

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

// ----------------------------------------------------------------------------
// Magic link URL
// ----------------------------------------------------------------------------

/**
 * Resuelve el host del browser desde los headers en orden de prioridad:
 *   1. X-Forwarded-Host (con o sin scheme) — proxy reverso estándar.
 *   2. Origin (sin path) — browser cross-origin con credentials.
 *   3. Referer (con path) — browser same-origin o navegación completa.
 *   4. Fallback al host del request (reqUrl.host) — caso server-to-server.
 *
 * @returns {{ host: string, proto: string }} ó { host: '', proto: '' } si no se pudo determinar.
 */
function getBrowserHost(request) {
  const reqUrl = new URL(request.url)
  const reqProto = reqUrl.protocol.replace(':', '')
  const xfh = request.headers.get('X-Forwarded-Host') || ''
  const origin = request.headers.get('Origin') || ''
  const referer = request.headers.get('Referer') || ''
  if (xfh) {
    if (xfh.startsWith('http://') || xfh.startsWith('https://')) {
      try {
        const u = new URL(xfh)
        return { host: u.host, proto: u.protocol.replace(':', '') }
      } catch { /* fallthrough */ }
    }
    return { host: xfh, proto: reqProto }
  }
  if (origin) {
    try {
      const u = new URL(origin)
      return { host: u.host, proto: u.protocol.replace(':', '') }
    } catch { /* fallthrough */ }
  }
  if (referer) {
    try {
      const u = new URL(referer)
      return { host: u.host, proto: u.protocol.replace(':', '') }
    } catch { /* ignore */ }
  }
  return { host: '', proto: '' }
}

function isHostLocalhost(host) {
  if (!host) return false
  const hostname = host.split(':')[0]
  return hostname === 'localhost' || hostname.endsWith('.localhost')
}

/**
 * Construye el magic link URL.
 *
 * Reglas:
 *   1. browser host es localhost → usar ese (browser REALMENTE en localhost).
 *   2. isDev (portal OR reqUrl contiene localhost) && browser host → usar browser.
 *   3. isDev && !browser host → fallback a reqUrl.host.
 *   4. !isDev (prod) → usar portalOrigin (siempre el portal hardcodeado).
 *
 * Limitación documentada en AGENTS.md §2: si wrangler 4 --remote strip-ea
 * los headers entre workers del service binding, podemos caer al portalOrigin
 * prod aunque el browser esté en localhost — workaround conocido.
 */
export function buildMagicLinkUrl(request, env, tokenId, { origin = 'portal' } = {}) {
  const reqUrl = new URL(request.url)
  const portalOrigin = (env.HTMLBOX_PORTAL_ORIGIN || `${reqUrl.protocol}//${reqUrl.host}`).replace(/\/+$/, '')
  const adminOrigin = (env.HTMLBOX_PUBLIC_ORIGIN || `${reqUrl.protocol}//${reqUrl.host}`).replace(/\/+$/, '')

  const isDev =
    portalOrigin.includes('localhost') ||
    portalOrigin.includes('127.0.0.1') ||
    reqUrl.host.includes('localhost') ||
    reqUrl.host.includes('127.0.0.1')

  const { host: browserHost, proto: browserProto } = getBrowserHost(request)

  let magicLinkOrigin
  if (isHostLocalhost(browserHost)) {
    magicLinkOrigin = `${browserProto}://${browserHost}`
  } else if (isDev && browserHost) {
    magicLinkOrigin = `${browserProto}://${browserHost}`
  } else if (isDev) {
    magicLinkOrigin = `${reqUrl.protocol}//${reqUrl.host}`
  } else {
    magicLinkOrigin = origin === 'admin' ? adminOrigin : portalOrigin
  }

  return `${magicLinkOrigin}/api/auth/verify?token=${tokenId}`
}

// ----------------------------------------------------------------------------
// Entradas principales (reemplazan sendMagicLinkEmail y sendAppMagicLinkEmail)
// ----------------------------------------------------------------------------

/**
 * Envía un magic link de PLATAFORMA via flow-engine.
 *
 * Devuelve:
 *   - { sent: true,  messageId, sentTo, mode: 'prod' } si se envió OK
 *   - { sent: false, previewLink, mode: 'dev' } si HTMLBOX_ENV !== 'production'
 *     (preview para que la SPA muestre el link sin abrir la terminal)
 *   - { sent: false, previewLink: undefined, mode: 'prod-fallback', error }
 *     si el flow-engine falló (no debería pasar con el binding bien configurado)
 *
 * GATE DE SEGURIDAD (Fix 3): cuando env.HTMLBOX_ENV === 'production' el
 * previewLink es undefined — NUNCA se filtra el token en la respuesta. La
 * lógica del gate vive acá para que cualquier caller (routes/auth.js,
 * tests, futuros) reciba un objeto seguro.
 */
export async function sendMagicLinkViaFlow(env, request, { toEmail, tokenId, tenantName }) {
  const isProd = env.HTMLBOX_ENV === 'production'
  const magicLink = buildMagicLinkUrl(request, env, tokenId)
  const { subject, textBody, htmlBody } = renderMagicLinkEmail({ toEmail, magicLink, tenantName })

  if (isProd) {
    // Capturamos errores del flow-engine (binding faltante, timeout, etc.)
    // y devolvemos shape seguro: sent=false, previewLink undefined. Fix 3
    // cierra el leak de magic links en respuestas de error prod.
    let result
    try {
      result = await runFlow(
        'magic-link',
        { to: toEmail, subject, text: textBody, html: htmlBody },
        env,
        undefined,
      )
    } catch (err) {
      console.error('[magic-link] runFlow magic-link falló:', err?.message || err)
      return { sent: false, previewLink: undefined, mode: 'prod', error: err?.message || 'send_failed' }
    }
    return {
      sent: !!result.emailMessageId,
      messageId: result.emailMessageId,
      sentTo: result.emailSentTo,
      mode: 'prod',
    }
  }

  // Modo dev: NO se envía email — el caller usa previewLink para mostrar
  // el link en la SPA. Fix 3 mantiene el gate acá.
  return { sent: false, previewLink: magicLink, mode: 'dev' }
}

/**
 * Envía un magic link de APP-USER via flow-engine. El `magicLink` ya viene
 * armado desde runtime (apunta a sí mismo).
 *
 * Mismo shape de respuesta que sendMagicLinkViaFlow.
 */
export async function sendAppMagicLinkViaFlow(env, { toEmail, magicLink, boxName }) {
  const isProd = env.HTMLBOX_ENV === 'production'
  const { subject, textBody, htmlBody } = renderAppMagicLinkEmail({ toEmail, magicLink, boxName })

  if (isProd) {
    let result
    try {
      result = await runFlow(
        'app-magic-link',
        { to: toEmail, subject, text: textBody, html: htmlBody },
        env,
        undefined,
      )
    } catch (err) {
      console.error('[magic-link] runFlow app-magic-link falló:', err?.message || err)
      return { sent: false, previewLink: undefined, mode: 'prod', error: err?.message || 'send_failed' }
    }
    return {
      sent: !!result.emailMessageId,
      messageId: result.emailMessageId,
      sentTo: result.emailSentTo,
      mode: 'prod',
    }
  }

  // Modo dev: NO se envía email.
  return { sent: false, previewLink: magicLink, mode: 'dev' }
}
