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
  // El magic link apunta al PORTAL (no al controlplane). Razón: el consume
  // ocurre vía fetch desde el browser, y queremos que la Set-Cookie quede
  // atada al origin del portal. En dev `*.localhost` no tiene dominio padre
  // registrable, así que `Domain=localhost` se trata como host-only — el
  // cookie sólo viaja si el origin del Set-Cookie coincide con el del consumer.
  // En prod sigue funcionando: HTMLBOX_PORTAL_ORIGIN = https://portal.htmlbox.dev,
  // y la cookie se setea con Domain=.htmlbox.dev (cross-subdomain real).
  const reqUrl = new URL(request.url)
  const portalOrigin = (env.HTMLBOX_PORTAL_ORIGIN || `${reqUrl.protocol}//${reqUrl.host}`).replace(/\/+$/, '')
  const magicLink = `${portalOrigin}/api/auth/verify?token=${tokenId}`
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