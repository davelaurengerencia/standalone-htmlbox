// src/lib/email.js — envío del magic link.
//
// Modos (HTMLBOX_EMAIL_MODE):
//   - dev  : no envía nada. Loguea el link por consola y lo devuelve en la
//            respuesta para acelerar el ciclo end-to-end.
//   - prod : Cloudflare Email Service (binding MAIL — wrangler email).
//   - cualquier otro valor : cae a dev.
//
// Dos funciones de envío:
//   - sendMagicLinkEmail: para login de plataforma (auth.js). El link apunta
//     al portal (el consume ocurre vía portal).
//   - sendAppMagicLinkEmail: para login de usuarios de la app (runtime/appAuth.js).
//     El link ya viene armado por runtime apuntando a sí mismo — esta función
//     solo renderiza y envía.

const FROM_ADDRESS_DEFAULT = 'no-reply@htmlbox.dev'
const FROM_NAME_DEFAULT = 'HTMLBox'

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

// Devuelve { sent, previewLink? }. previewLink SOLO en modo dev o si falla prod.
export async function sendMagicLinkEmail(env, request, { toEmail, tokenId, tenantName }) {
  const reqUrl = new URL(request.url)
  // Determinar el origen del magic link:
  //   - PROD: apunta al PORTAL. El consume ocurre via portal proxy al
  //     control-plane. La Set-Cookie usa Domain=.htmlbox.dev (cross-subdomain)
  //     y queda accesible desde cualquier *.htmlbox.dev, incluido el portal
  //     que la necesita para sus requests autenticados.
  //   - DEV (host-only cookies): apunta al CONTROL-PLANE mismo. Si
  //     apuntara al portal, la Set-Cookie del consume quedaría atada al
  //     host del portal (porque el browser recibe la response via portal
  //     proxy) y NO se vería cuando el user navega a /admin/ (otro host).
  //     Apuntando directo al control-plane, el consume corre en el origin
  //     correcto y la cookie queda atada a controlplane.localhost, que es
  //     exactamente donde la vamos a necesitar.
  // Detección de dev: el control-plane corre con --remote en dev (porque su
  // D1 está en Cloudflare), pero wrangler inyecta las vars de .dev.vars.
  // Cuando el portal origin tiene 'localhost' en la URL sabemos que estamos
  // en dev — prod usa 'htmlbox.dev'. El hostname del request (cuando
  // wrangler forward-ea al Worker remoto) es 'htmlbox-control-plane.sivocloud-
  // latam.workers.dev', que NO termina en '.localhost', así que NO podemos
  // detectar dev por hostname.
  //
  // En dev queremos que el magic link apunte al HOST DEL BROWSER (no al Worker
  // remoto) — el dev proxy de wrangler monta localmente un server en
  // 'controlplane.localhost:8781' y reenvía al Worker. El browser hace click
  // en el magic link esperando ir a 'controlplane.localhost:8781', no a
  // 'htmlbox-control-plane.sivocloud-latam.workers.dev'.
  //
  // Detección del host del browser (en orden de prioridad):
  //   1. X-Forwarded-Host: header estándar de proxy reverso. El dev proxy
  //      de wrangler NO lo inyecta automáticamente, pero si en algún momento
  //      lo hace, lo respetamos.
  //   2. Origin: el browser lo envía en requests cross-origin con
  //      credentials. La SPA del admin/portal llama con `credentials: include`
  //      en apiFetch, así que Origin debería estar presente. NO incluye
  //      path (solo `http://host:port`).
  //   3. Fallback: control-plane remoto (que en dev requiere que el user
  //      copie el link y reemplace el host manualmente — feo pero funcional).
  // En dev (control-plane con --remote) el Worker corre en
  // 'htmlbox-control-plane.sivocloud-latam.workers.dev'. El dev proxy de
  // wrangler monta localmente un server en 'controlplane.localhost:8781'
  // y reenvía. El browser hace click esperando ir a su host local,
  // no al Worker remoto.
  //
  // El host del browser se obtiene (en orden de prioridad):
  //   1. X-Forwarded-Host — header estándar de proxy reverso. El dev proxy
  //      de wrangler NO lo inyecta automáticamente, pero si en algún momento
  //      lo hace, lo respetamos. Acepta scheme incluido o solo host.
  //   2. Origin — header cross-origin. El browser lo envía en fetch()
  //      cross-origin con credentials. NO se envía en same-origin.
  //   3. Referer — el browser lo envía en fetch() desde una página. Same-
  //      origin SÍ lo incluye (con el path completo), por lo que es la
  //      fuente más confiable para el caso same-origin del admin SPA.
  //   4. Fallback: control-plane remoto. En dev el user tendrá que editar
  //      el host del link manualmente, pero al menos no rompe.
  //
  // El scheme se toma del header elegido (XFH/Origin/Referer) para que
  // coincida con el que el browser espera. Si el header no tiene scheme
  // (X-Forwarded-Host típico), usamos el de reqUrl como fallback.
  const portalOrigin = (env.HTMLBOX_PORTAL_ORIGIN || `${reqUrl.protocol}//${reqUrl.host}`).replace(/\/+$/, '')
  const isDev = portalOrigin.includes('localhost') || portalOrigin.includes('127.0.0.1')
  const reqProto = reqUrl.protocol.replace(':', '')

  let browserHost = ''
  let browserProto = ''
  const xfh = request.headers.get('X-Forwarded-Host') || ''
  const origin = request.headers.get('Origin') || ''
  const referer = request.headers.get('Referer') || ''
  if (xfh) {
    if (xfh.startsWith('http://') || xfh.startsWith('https://')) {
      browserHost = new URL(xfh).host
      browserProto = new URL(xfh).protocol.replace(':', '')
    } else {
      browserHost = xfh
      browserProto = reqProto
    }
  } else if (origin) {
    browserHost = new URL(origin).host
    browserProto = new URL(origin).protocol.replace(':', '')
  } else if (referer) {
    try {
      const u = new URL(referer)
      browserHost = u.host
      browserProto = u.protocol.replace(':', '')
    } catch { /* ignore */ }
  }

  const magicLinkOrigin = isDev && browserHost
    ? `${browserProto}://${browserHost}`
    : (isDev ? `${reqUrl.protocol}//${reqUrl.host}` : portalOrigin)
  const magicLink = `${magicLinkOrigin}/api/auth/verify?token=${tokenId}`
  return await deliver(env, renderMagicLinkEmail, { toEmail, magicLink, tenantName }, '[email][dev]')
}

// Devuelve { sent, previewLink? } — mismo shape que sendMagicLinkEmail, para
// que el caller (routes/internal.js) lo pueda tratar igual.
//
// A diferencia de sendMagicLinkEmail, acá el magicLink llega YA ARMADO
// (runtime lo construye apuntando a sí mismo) — esta función solo
// renderiza y envía, no decide el link.
export async function sendAppMagicLinkEmail(env, { toEmail, magicLink, boxName }) {
  return await deliver(env, renderAppMagicLinkEmail, { toEmail, magicLink, boxName }, '[email][app-user]')
}

// Helper compartido por sendMagicLinkEmail y sendAppMagicLinkEmail.
async function deliver(env, renderFn, args, devLogTag) {
  const { toEmail, magicLink, tenantName, boxName } = args
  const mode = (env.HTMLBOX_EMAIL_MODE || 'dev').toLowerCase()
  const fromAddress = env.HTMLBOX_EMAIL_FROM_ADDRESS || FROM_ADDRESS_DEFAULT
  const fromName = env.HTMLBOX_EMAIL_FROM_NAME || FROM_NAME_DEFAULT

  const { subject, textBody, htmlBody } = renderFn({ toEmail, magicLink, tenantName, boxName })

  if (mode === 'dev') {
    console.log(`${devLogTag} Magic link NO enviado. Pegá esto en el browser:`)
    console.log(`  → ${magicLink}`)
    return { sent: false, previewLink: magicLink, mode: 'dev' }
  }

  if (mode === 'prod') {
    if (!env.MAIL || typeof env.MAIL.send !== 'function') {
      console.error(`${devLogTag.replace('[dev]', '[prod]')} HTMLBOX_EMAIL_MODE=prod pero no hay binding MAIL.`)
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
      console.error(`${devLogTag.replace('[dev]', '[prod]')} error enviando magic link:`, err?.message || err)
      return { sent: false, previewLink: magicLink, mode: 'prod-fallback', error: err?.message || 'send_failed' }
    }
  }

  console.warn(`${devLogTag} HTMLBOX_EMAIL_MODE="${mode}" desconocido — cayendo a dev.`)
  return { sent: false, previewLink: magicLink, mode: 'dev-fallback' }
}