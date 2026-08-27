// src/lib/email.js — envío del magic link.
//
// Modos (HTMLBOX_EMAIL_MODE):
//   - dev  : no envía nada. Loguea el link por consola y lo devuelve en la
//            respuesta para acelerar el ciclo end-to-end.
//   - prod : Cloudflare Email Service (binding MAIL — wrangler email).
//   - cualquier otro valor : cae a dev.

const FROM_ADDRESS_DEFAULT = 'no-reply@htmlbox.dev'
const FROM_NAME_DEFAULT = 'HTMLBox'

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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Devuelve { sent, previewLink? }. previewLink SOLO en modo dev o si falla prod.
export async function sendMagicLinkEmail(env, request, { toEmail, tokenId, tenantName }) {
  const url = new URL(request.url)
  // Apuntamos al control-plane porque es donde se hace el POST de consume.
  const magicLink = `${url.protocol}//${url.host}/api/auth/verify?token=${tokenId}`
  const mode = (env.HTMLBOX_EMAIL_MODE || 'dev').toLowerCase()
  const fromAddress = env.HTMLBOX_EMAIL_FROM_ADDRESS || FROM_ADDRESS_DEFAULT
  const fromName = env.HTMLBOX_EMAIL_FROM_NAME || FROM_NAME_DEFAULT

  const { subject, textBody, htmlBody } = renderMagicLinkEmail({ toEmail, magicLink, tenantName })

  if (mode === 'dev') {
    console.log('[email][dev] Magic link NO enviado. Pegá esto en el browser:')
    console.log(`  → ${magicLink}`)
    return { sent: false, previewLink: magicLink, mode: 'dev' }
  }

  if (mode === 'prod') {
    if (!env.MAIL || typeof env.MAIL.send !== 'function') {
      console.error('[email][prod] HTMLBOX_EMAIL_MODE=prod pero no hay binding MAIL.')
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
      console.error('[email][prod] error enviando magic link:', err?.message || err)
      // Fallback: devolver previewLink para que el usuario no quede bloqueado
      // mientras se termina de configurar DNS/SPF/DKIM del dominio de envío.
      return { sent: false, previewLink: magicLink, mode: 'prod-fallback', error: err?.message || 'send_failed' }
    }
  }

  console.warn(`[email] HTMLBOX_EMAIL_MODE="${mode}" desconocido — cayendo a dev.`)
  return { sent: false, previewLink: magicLink, mode: 'dev-fallback' }
}