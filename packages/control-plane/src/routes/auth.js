// src/routes/auth.js — endpoints de auth.
//
//   POST /api/auth/request    { email }            → solicita magic link (respuesta genérica)
//   GET  /api/auth/verify?token=…  (devuelve HTML con auto-POST al consume — anti-scanner)
//   POST /api/auth/consume    { token }            → consume + crea sesión
//   GET  /api/auth/me                              → sesión actual (debug)
//   POST /api/auth/logout                          → cierra sesión

import {
  isRateLimited, createMagicLink, peekMagicLink, consumeMagicLink,
  createSession, deleteSession, validateSession,
  buildSessionCookie, buildClearCookie,
  getSessionIdFromRequest,
} from '../lib/session.js'
import { sendMagicLinkEmail } from '../lib/email.js'

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  })
}

// Respuesta SIEMPRE genérica al user (anti-enumeración).
const GENERIC_RESPONSE = { ok: true, message: 'Si el email está registrado, recibirás un link.' }

export async function handleAuth(request, env, ctx, path) {
  if (path === '/api/auth/request' && request.method === 'POST') return await postRequest(request, env)
  if (path === '/api/auth/verify'  && request.method === 'GET')  return await getVerify(request, env)
  if (path === '/api/auth/consume' && request.method === 'POST') return await postConsume(request, env)
  if (path === '/api/auth/me'      && request.method === 'GET')  return await getMe(request, env)
  if (path === '/api/auth/logout'  && request.method === 'POST') return await postLogout(request, env)
  return new Response('Not Found', { status: 404 })
}

async function postRequest(request, env) {
  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const email = (body?.email || '').trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    // Misma respuesta genérica — no leak de validación.
    return json(GENERIC_RESPONSE)
  }

  if (await isRateLimited(env, email)) {
    // No creamos link adicional. Logueamos y devolvemos la misma respuesta.
    console.log(`[auth] rate-limited email=${email}`)
    return json(GENERIC_RESPONSE)
  }

  const { id } = await createMagicLink(env, email)
  const emailResult = await sendMagicLinkEmail(env, request, { toEmail: email, tokenId: id })
  // Devolvemos previewLink si:
  //   - modo dev, o
  //   - modo prod pero el envío falló (DNS/SPF/DKIM del dominio aún no
  //     configurados) — para no bloquear al usuario mientras se termina
  //     el setup. Una vez que los records DNS estén OK, removemos esta
  //     rama y devolvemos GENERIC_RESPONSE en prod estricto.
  const includePreview = emailResult?.previewLink != null
  if (includePreview) {
    return json({ ...GENERIC_RESPONSE, _dev_preview: emailResult.previewLink, _email_mode: emailResult.mode })
  }
  return json(GENERIC_RESPONSE)
}

// GET /api/auth/verify?token=…
// Página HTML que auto-POSTea al consume (anti-scanner de correo).
async function getVerify(request, env) {
  const url = new URL(request.url)
  const token = url.searchParams.get('token')
  const peek = await peekMagicLink(env, token)
  if (!peek.ok) {
    return new Response(loginErrorHtml(peek.reason), {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }
  // HTML que hace fetch JSON al consume — un submit de form HTML nativo manda
  // x-www-form-urlencoded y rompía el parseo (A1).
  return new Response(loginConfirmHtml(token, env.HTMLBOX_PORTAL_ORIGIN || ''), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

async function postConsume(request, env) {
  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const token = body?.token
  if (!token) return json({ error: 'missing_token' }, 400)

  const email = await consumeMagicLink(env, token)
  if (!email) return json({ error: 'invalid_or_expired_token' }, 400)

  // Buscar o crear el user.
  let user = await env.DB.prepare(
    `SELECT id, email, display_name, tenant_id, is_platform_owner FROM htmlbox_users WHERE email = ?1`
  ).bind(email).first()

  if (!user) {
    // Auto-provisionar user. tenant_id queda NULL (no sabemos a qué tenant pertenece todavía);
    // el platform owner tiene tenant_id NULL por diseño.
    const newId = `user_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
    await env.DB.prepare(
      `INSERT INTO htmlbox_users (id, email) VALUES (?1, ?2)`
    ).bind(newId, email).run()
    user = { id: newId, email, display_name: null, tenant_id: null, is_platform_owner: 0 }
  }

  // Crear sesión
  const sess = await createSession(env, user.id)
  const cookie = buildSessionCookie(request, sess.id, env)
  return json({ ok: true, user }, 200, { 'Set-Cookie': cookie })
}

async function getMe(request, env) {
  const sid = getSessionIdFromRequest(request)
  const v = await validateSession(env, sid)
  if (!v) return json({ user: null })
  return json({ user: v.user })
}

async function postLogout(request, env) {
  const sid = getSessionIdFromRequest(request)
  await deleteSession(env, sid)
  return json({ ok: true }, 200, { 'Set-Cookie': buildClearCookie(request, env) })
}

function loginConfirmHtml(token, portalOrigin) {
  // JSON.stringify evita reabrir XSS si el token (hoy hex) trajera chars raros.
  const safeToken = JSON.stringify(token)
  const safeOrigin = JSON.stringify(portalOrigin || '')
  return `<!doctype html><html><head><meta charset="utf-8"><title>Verificando…</title></head>
<body style="font-family:-apple-system,sans-serif;max-width:480px;margin:60px auto;padding:0 20px;text-align:center;color:#1f2637">
  <h2 style="color:#6366f1">Verificando tu link</h2>
  <p id="status">Un momento…</p>
  <script>
    (async () => {
      try {
        const res = await fetch('/api/auth/consume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: ${safeToken} }),
        })
        const data = await res.json()
        if (res.ok && data.ok) {
          document.getElementById('status').textContent = 'Listo — ya podés cerrar esta pestaña o ir al portal.'
          const portalOrigin = ${safeOrigin}
          if (portalOrigin) setTimeout(() => { window.location.href = portalOrigin }, 1200)
        } else {
          document.getElementById('status').textContent = 'Error: ' + (data.error || res.status)
        }
      } catch (err) {
        document.getElementById('status').textContent = 'Error: ' + err.message
      }
    })()
  </script>
</body></html>`
}

function loginErrorHtml(reason) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Link no válido</title></head>
<body style="font-family:-apple-system,sans-serif;max-width:480px;margin:60px auto;padding:0 20px;text-align:center;color:#1f2637">
  <h2 style="color:#dc2626">Link no válido</h2>
  <p>Este link ya fue usado o expiró. Pedí uno nuevo desde el portal.</p>
  <p style="color:#666;font-size:12px">Motivo: ${escape(reason)}</p>
</body></html>`
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}