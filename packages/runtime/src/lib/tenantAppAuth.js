// src/lib/tenantAppAuth.js — rutas /api/tenant-app-auth/{boxId}/... del runtime.
//
// A diferencia de app-auth (fase 1/2, sesiones POR BOX en Turso DB del box),
// estas sesiones viven en D1 (control-plane) y Domain-scoped — un solo login
// alcanza todas las apps del tenant a las que el user tenga acceso.
//
// Patrón: runtime expone los endpoints públicos (para que el browser del
// visitante del box no tenga que hacer cross-origin a control-plane); por
// debajo, runtime proxy-ea a control-plane, que es donde vive la lógica
// real (D1 + binding MAIL).
//
// Endpoints:
//   POST   /api/tenant-app-auth/{boxId}/request  { email, returnPath? }  → pedir magic link
//   GET    /api/tenant-app-auth/{boxId}/verify?token=...&return=...      → página HTML con botón (anti-scanner)
//   POST   /api/tenant-app-auth/{boxId}/consume  { token }                → consume + setea cookie hbx_tapp_sid
//   GET    /api/tenant-app-auth/{boxId}/me                                → { tenantAppUser } | null
//   POST   /api/tenant-app-auth/{boxId}/logout                            → limpia cookie
//
// Cookie: hbx_tapp_sid, Domain=.sivocloud.dev en prod, host-only en dev.
// Control-plane arma el Set-Cookie string y runtime lo reenvía en su
// respuesta — porque el response que llega al browser lo arma runtime.

import { resolveBoxDb } from './boxDb.js'

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  })
}

// Evita open-redirect: solo se acepta un path relativo.
function sanitizeReturnPath(raw) {
  const p = typeof raw === 'string' ? raw : ''
  if (p.startsWith('/') && !p.startsWith('//')) return p
  return '/'
}

function cpHeaders(env) {
  const h = { 'Content-Type': 'application/json' }
  if (env.HTMLBOX_INTERNAL_SECRET) h['X-HTMLBox-Internal-Secret'] = env.HTMLBOX_INTERNAL_SECRET
  return h
}

// ─────────────────────────────────────────────────────────────────────────────
// Rutas
// ─────────────────────────────────────────────────────────────────────────────

async function postRequest(request, env, boxId) {
  const boxInfo = await resolveBoxDb(env, boxId, request)
  if (!boxInfo) return json({ error: 'box_not_found' }, 404)
  if (!boxInfo.tenantId) return json({ error: 'box_missing_tenant_id' }, 500)

  let body
  try { body = await request.json() } catch { return json({ ok: true }) }
  const url = new URL(request.url)
  const returnPath = sanitizeReturnPath(body?.returnPath)
  const magicLinkBase = `${url.origin}/api/tenant-app-auth/${boxId}/verify?return=${encodeURIComponent(returnPath)}&token=`

  const res = await fetch(`${env.HTMLBOX_CONTROL_PLANE_ORIGIN}/api/internal/tenant-app-auth/request`, {
    method: 'POST',
    headers: cpHeaders(env),
    body: JSON.stringify({ tenantId: boxInfo.tenantId, email: body?.email, magicLinkBase }),
  })
  const data = await res.json().catch(() => ({ ok: true }))
  // Strip _dev_preview en producción (mismo criterio que fase 1)
  if (env.HTMLBOX_ENV === 'production') delete data._dev_preview
  return json(data)
}

async function postConsume(request, env, boxId) {
  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }

  const res = await fetch(`${env.HTMLBOX_CONTROL_PLANE_ORIGIN}/api/internal/tenant-app-auth/consume`, {
    method: 'POST',
    headers: cpHeaders(env),
    body: JSON.stringify({ token: body?.token }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    return json({ error: data.error || 'consume_failed' }, res.status || 400)
  }
  // El cookie ya viene armado por control-plane — runtime lo reenvía en su respuesta.
  return json({ ok: true, tenantAppUser: data.tenantAppUser }, 200, { 'Set-Cookie': data.cookie })
}

async function getVerify(request, env, boxId) {
  const url = new URL(request.url)
  const token = url.searchParams.get('token')
  const returnPath = sanitizeReturnPath(url.searchParams.get('return'))
  const boxInfo = await resolveBoxDb(env, boxId, request)
  if (!boxInfo) return new Response('Box no encontrado', { status: 404 })

  // Renderizar la página HTML con auto-POST al consume. Reusamos el helper de
  // appAuth.js (mismo shape; acá consume endpoint es distinto).
  return renderVerifyConfirm(boxId, token, returnPath)
}

function renderVerifyConfirm(boxId, token, returnPath) {
  const safeReturn = String(returnPath || '/').replace(/[<>"]/g, '')
  const safeBox = String(boxId).replace(/[^a-z0-9]/g, '')
  const safeToken = String(token || '').replace(/[^a-f0-9]/g, '')
  return new Response(`<!doctype html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ingresar al tenant</title>
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
    <h1>Confirmar ingreso al tenant</h1>
    <p>Tocá el botón para entrar. Esta página vence en 15 minutos y te va a dejar entrar a cualquier app del tenant a la que tengas acceso.</p>
    <button id="go">Ingresar</button>
    <div class="err" id="err"></div>
  </div>
  <script>
    document.getElementById('go').addEventListener('click', async () => {
      const btn = document.getElementById('go')
      btn.disabled = true
      btn.textContent = 'Ingresando…'
      try {
        const res = await fetch('/api/tenant-app-auth/${safeBox}/consume', {
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
</html>`, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

async function getMe(request, env, boxId) {
  const tsid = readCookie(request, 'hbx_tapp_sid')
  if (!tsid) return json({ tenantAppUser: null })

  // Chequear acceso al box actual
  const res = await fetch(`${env.HTMLBOX_CONTROL_PLANE_ORIGIN}/api/internal/tenant-app-auth/access`, {
    method: 'POST',
    headers: { ...cpHeaders(env), 'Cookie': `hbx_tapp_sid=${tsid}` },
    body: JSON.stringify({ boxId }),
  })
  const data = await res.json().catch(() => ({ allowed: false }))
  if (!data.allowed) return json({ tenantAppUser: null })
  return json({ tenantAppUser: data.tenantAppUser || null, role: data.role })
}

async function postLogout(request, env, boxId) {
  // Limpiamos la cookie localmente (control-plane no puede setear un Max-Age=0
  // en el browser del visitante del box — runtime es quien arma la respuesta).
  // El delete real de la sesión en D1 lo hace control-plane desde su propio
  // endpoint (no expuesto acá todavía; en v1 la sesión muere sola al expirar).
  const clearCookie = `hbx_tapp_sid=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie })
}

function readCookie(request, name) {
  const cookieHeader = request.headers.get('Cookie') || request.headers.get('cookie') || ''
  for (const part of cookieHeader.split(/;\s*/)) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Router principal. Devuelve Response o null si la URL no matchea.
// ─────────────────────────────────────────────────────────────────────────────

const BOX_ID = String.raw`([a-z0-9]{16})`

export async function handleTenantAppAuth(request, env, url) {
  const opM = url.pathname.match(
    new RegExp(`^/api/tenant-app-auth/${BOX_ID}/(request|verify|consume|me|logout)$`),
  )
  if (!opM) return null
  const [, boxId, op] = opM

  if (op === 'request' && request.method === 'POST') return await postRequest(request, env, boxId)
  if (op === 'verify'  && request.method === 'GET')  return await getVerify(request, env, boxId)
  if (op === 'consume' && request.method === 'POST') return await postConsume(request, env, boxId)
  if (op === 'me'      && request.method === 'GET')  return await getMe(request, env, boxId)
  if (op === 'logout'  && request.method === 'POST') return await postLogout(request, env, boxId)

  return json({ error: 'method_not_allowed' }, 405)
}

// Reexport para que appDataApi.js pueda leer el session id de la cookie sin
// importar session.js directamente (control-plane). Mismo shape que
// getSessionIdFromRequest de session.js.
export function getTenantAppSessionIdFromRequest(request) {
  return readCookie(request, 'hbx_tapp_sid')
}