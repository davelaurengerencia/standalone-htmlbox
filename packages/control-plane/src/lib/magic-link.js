// src/lib/magic-link.js — envío de magic link de TENANT-APP-USER via flow-engine.
//
// Históricamente este archivo también tenía `sendMagicLinkViaFlow` (magic
// link de plataforma) + los builders de URL (`buildMagicLinkUrl`,
// `resolveDevAwareOrigin`, etc.). Todo eso se eliminó cuando el envío de
// magic link de plataforma se migró al paquete `auth` (ver
// docs/htmlbox-spec-auth-centralizado.md §8).
//
// Lo único que queda acá es `sendAppMagicLinkViaFlow` — usado por
// routes/internal.js#postSendAppMagicLink para que runtime delegue el
// envío del magic link de tenant-app-users a control-plane (que tiene el
// binding EMAIL). El flow vive en `flows/app-magic-link.flow.json`.
//
// Ver docs/htmlbox-spec-app-users-centralized.md.

import { runFlow } from './flows.js'

// ----------------------------------------------------------------------------
// Templates
// ----------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderAppMagicLinkEmail({ toEmail, magicLink, boxName }) {
  const label = boxName ? `"${boxName}"` : 'la app'
  const subject = `Tu link de ingreso a ${label}`

  const textBody = `Hola,\n\nRecibimos un pedido de acceso para ${toEmail} a ${label}.\n\nClick acá para ingresar (válido por 15 minutos):\n${magicLink}\n\nSi no pediste este link, ignorá este mail.`

  const htmlBody = `<!doctype html><html><body style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 40px auto; padding: 0 20px; color: #1f2637;"><p>Hola,</p><p>Recibimos un pedido de acceso para <strong>${escapeHtml(toEmail)}</strong> a ${escapeHtml(label)}.</p><p style="margin: 28px 0;"><a href="${escapeHtml(magicLink)}" style="background: #6366f1; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Ingresar</a></p><p style="color: #666; font-size: 13px;">O copiá y pegá este link en tu navegador (válido por 15 minutos):<br><br><code style="background: #f4f6fb; padding: 6px 10px; border-radius: 4px; word-break: break-all;">${escapeHtml(magicLink)}</code></p><hr style="border: none; border-top: 1px solid #eee; margin: 28px 0;"><p style="color: #999; font-size: 12px;">Si no pediste este link, ignorá este mail.</p></body></html>`

  return { subject, textBody, htmlBody }
}

// ----------------------------------------------------------------------------
// Entry point
// ----------------------------------------------------------------------------

/**
 * Envía un magic link de TENANT-APP-USER via flow-engine.
 *
 * Política (igual que el magic link de plataforma, ver AGENTS.md §9):
 *   - SIEMPRE intenta enviar via flow-engine (no gate interno).
 *   - El flow-engine lee `HTMLBOX_EMAIL_MODE` (en el nodo `cloudflare-email`)
 *     para decidir si invoca el binding `EMAIL` o solo loguea.
 *   - El gate Fix 3 vive en routes/internal.js — en prod
 *     (`HTMLBOX_ENV === 'production'`) NO se devuelve `_dev_preview`.
 *
 * Devuelve:
 *   - { sent, messageId, sentTo, previewLink, mode } si runFlow OK
 *   - { sent: false, previewLink, mode, error } si el flow-engine falló
 */
export async function sendAppMagicLinkViaFlow(env, { toEmail, magicLink, boxName }) {
  const { subject, textBody, htmlBody } = renderAppMagicLinkEmail({ toEmail, magicLink, boxName })

  const isProd = env.HTMLBOX_ENV === 'production'
  const previewLink = isProd ? undefined : magicLink

  let result
  try {
    result = await runFlow(
      'app-magic-link',
      { to: toEmail, subject, text: textBody, html: htmlBody },
      env,
      undefined,
    )
  } catch (err) {
    console.error('[app-magic-link] runFlow falló:', err?.message || err)
    return { sent: false, previewLink, mode: 'error', error: err?.message || 'send_failed' }
  }
  return {
    sent: !!result.emailMessageId,
    messageId: result.emailMessageId,
    sentTo: result.emailSentTo,
    previewLink,
    mode: isProd ? 'prod' : 'dev',
  }
}
