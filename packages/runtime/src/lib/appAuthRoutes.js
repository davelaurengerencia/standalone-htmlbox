// src/lib/appAuthRoutes.js — endpoints /api/app-auth/{boxId}/... del runtime.
//
// Endpoints públicos (auth de app-user):
//   POST   /api/app-auth/{boxId}/request    { email, returnPath? }  → pedir magic link (genérico)
//   GET    /api/app-auth/{boxId}/verify?token=...&return=...        → página HTML con botón de confirmar (anti-scanner)
//   POST   /api/app-auth/{boxId}/consume    { token }                → consume + crea sesión + setea cookie
//   GET    /api/app-auth/{boxId}/me                                 → sesión actual del app-user (o { appUser: null })
//   POST   /api/app-auth/{boxId}/logout                             → cierra sesión
//
// Endpoints admin (auth de plataforma, editor+):
//   GET    /api/app-auth/{boxId}/admin/users                         → lista usuarios de la app
//   POST   /api/app-auth/{boxId}/admin/users  { email, display_name? } → agrega usuario
//   POST   /api/app-auth/{boxId}/admin/users/{id}/disable           → deshabilita (disabled_at = now)
//   POST   /api/app-auth/{boxId}/admin/users/{id}/enable            → reactiva (disabled_at = NULL)
//   DELETE /api/app-auth/{boxId}/admin/users/{id}                   → borra (cascadea sus sesiones)
//
//   GET    /api/app-auth/{boxId}/admin/settings                     → { signup_mode }
//   POST   /api/app-auth/{boxId}/admin/settings { signup_mode }     → cambia modo ('invite_only' | 'open')
//
// Cookies:
//   - hbx_app_sid HttpOnly SameSite=Lax, Path scoped al box (cookiePathForBox).
//     Así dos boxes bajo el mismo subdominio no se pisan la cookie entre sí.

import { resolveBoxDb, getBoxClient } from './boxDb.js'
import { readSession, controlPlaneHeaders } from './auth.js'
import {
  applyAppUsersSchema, applyAppSettingsSchema,
  ensureTableScopeColumn, ensureOwnerColumn,
} from '@htmlbox/shared'
import {
  isRateLimited, createMagicLink, peekMagicLink, consumeMagicLink,
  findAppUserByEmail, createAppUser, createAppSession, deleteAppSession,
  validateAppSession,
  buildAppSessionCookie, buildAppClearCookie, getAppSessionIdFromRequest,
  shouldUseSecureCookie, cookiePathForBox,
  verifyConfirmHtml, verifyErrorHtml,
  getSignupMode, setSignupMode,
} from './appAuth.js'

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  })
}

// Evita open-redirect: solo se acepta un path relativo (empieza con "/",
// no empieza con "//" — eso sería protocol-relative a otro host), si no,
// cae al root "/".
function sanitizeReturnPath(raw) {
  const p = typeof raw === 'string' ? raw : ''
  if (p.startsWith('/') && !p.startsWith('//')) return p
  return '/'
}

// Llama al endpoint interno del control-plane (§4.2 del spec).
async function sendAppMagicLinkViaControlPlane(env, { toEmail, magicLink, boxName }) {
  const origin = env.HTMLBOX_CONTROL_PLANE_ORIGIN
  if (!origin) throw new Error('appAuth: HTMLBOX_CONTROL_PLANE_ORIGIN no configurado')
  const headers = { 'Content-Type': 'application/json' }
  if (env.HTMLBOX_INTERNAL_SECRET) headers['X-HTMLBox-Internal-Secret'] = env.HTMLBOX_INTERNAL_SECRET
  const res = await fetch(`${origin}/api/internal/send-app-magic-link`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ toEmail, magicLink, boxName }),
  })
  if (!res.ok) return null
  return await res.json()
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth: app-user con sesión de plataforma (rol editor+ sobre el box)
// Reusa el mismo patrón que dataApi.js — sesiones de plataforma, NO de app.
// ─────────────────────────────────────────────────────────────────────────────

async function requireBoxAsPlatformUser(env, boxId, request) {
  const sess = await readSession(env, request)
  if (!sess) return { error: 'unauthenticated', status: 401 }

  const origin = env.HTMLBOX_CONTROL_PLANE_ORIGIN
  const headers = controlPlaneHeaders(env, request)

  let role = null
  if (sess.isPlatformOwner) {
    role = 'owner'
  } else {
    const res = await fetch(`${origin}/api/internal/boxes/${encodeURIComponent(boxId)}/membership`, { headers })
    if (!res.ok) return { error: 'forbidden', status: 403 }
    const data = await res.json()
    if (!data.membership) return { error: 'forbidden', status: 403 }
    role = data.membership.role
  }

  const info = await resolveBoxDb(env, boxId, request)
  if (!info) return { error: 'box_not_found', status: 404 }
  return { info, auth: { role, userId: sess.userId } }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rutas públicas — /api/app-auth/{boxId}/request|verify|consume|me|logout
// ─────────────────────────────────────────────────────────────────────────────

async function postRequest(request, env, boxId) {
  let payload
  try { payload = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const email = (payload?.email || '').trim().toLowerCase()
  const GENERIC = { ok: true, message: 'Si el email está habilitado, recibirás un link.' }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(GENERIC)

  const boxInfo = await resolveBoxDb(env, boxId, request)
  if (!boxInfo) return json({ error: 'box_not_found' }, 404)
  const client = await getBoxClient(env, boxInfo)

  // Asegurar que las 3 tablas existen (idempotente).
  await applyAppUsersSchema(client)
  await applyAppSettingsSchema(client)

  // Fase 1 (invite_only, default): solo mandamos magic link a emails que el
  // tenant YA agregó como usuario de la app. Esto evita que cualquiera se
  // "auto-registre" solo por pedir un link.
  //
  // Fase 2 (signup_mode='open'): si no existe, lo creamos al toque (modo
  // ecommerce — ver htmlbox-spec-app-customers.md §3).
  let appUser = await findAppUserByEmail(client, email)
  if (!appUser) {
    const signupMode = await getSignupMode(client)
    if (signupMode !== 'open') return json(GENERIC)
    appUser = await createAppUser(client, email)
  }
  if (appUser.disabled_at) return json(GENERIC)

  if (await isRateLimited(client, email)) {
    console.log(`[app-auth] rate-limited box=${boxId} email=${email}`)
    return json(GENERIC)
  }

  const { id: tokenId } = await createMagicLink(client, email)
  const url = new URL(request.url)
  const returnPath = sanitizeReturnPath(payload?.returnPath)
  const verifyUrl = `${url.origin}/api/app-auth/${boxId}/verify?token=${tokenId}&return=${encodeURIComponent(returnPath)}`

  const emailResult = await sendAppMagicLinkViaControlPlane(env, {
    toEmail: email, magicLink: verifyUrl, boxName: boxInfo.boxSlug,
  })

  // En dev (o si prod falló) devolvemos el preview link para no bloquear
  // el desarrollo/QA. Gateado por HTMLBOX_ENV del propio runtime, NUNCA en
  // base a lo que devuelva el control-plane a ciegas — así una prod mal
  // configurada no empieza a leakear links reales a cualquier browser.
  if (env.HTMLBOX_ENV !== 'production' && emailResult?.previewLink) {
    return json({ ...GENERIC, _dev_preview: emailResult.previewLink })
  }
  return json(GENERIC)
}

async function getVerify(request, env, boxId) {
  const url = new URL(request.url)
  const token = url.searchParams.get('token')
  const returnPath = sanitizeReturnPath(url.searchParams.get('return'))

  const boxInfo = await resolveBoxDb(env, boxId, request)
  if (!boxInfo) return new Response('Box no encontrado', { status: 404 })
  const client = await getBoxClient(env, boxInfo)

  // Asegurar tablas — la primera vez que alguien cliquea un link de un box
  // recién activado, puede que no estén creadas todavía.
  await applyAppUsersSchema(client)

  const peek = await peekMagicLink(client, token)
  if (!peek.ok) {
    return new Response(verifyErrorHtml(peek.reason), {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }
  return new Response(verifyConfirmHtml(boxId, token, returnPath), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

async function postConsume(request, env, boxId) {
  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const token = body?.token
  if (!token) return json({ error: 'missing_token' }, 400)

  const boxInfo = await resolveBoxDb(env, boxId, request)
  if (!boxInfo) return json({ error: 'box_not_found' }, 404)
  const client = await getBoxClient(env, boxInfo)

  const email = await consumeMagicLink(client, token)
  if (!email) return json({ error: 'invalid_or_expired_token' }, 400)

  const appUser = await findAppUserByEmail(client, email)
  // Si en el ratísimo margen entre request→consume el tenant borró/deshabilitó
  // al usuario, cortamos.
  if (!appUser || appUser.disabled_at) return json({ error: 'user_not_found_or_disabled' }, 403)

  const sess = await createAppSession(client, appUser.id)
  const cookiePath = cookiePathForBox(boxInfo, boxId, request)
  const secure = shouldUseSecureCookie(request, env)
  const cookie = buildAppSessionCookie(sess.id, cookiePath, secure)
  return json(
    { ok: true, appUser: { id: appUser.id, email: appUser.email, display_name: appUser.display_name } },
    200,
    { 'Set-Cookie': cookie },
  )
}

async function getMe(request, env, boxId) {
  const boxInfo = await resolveBoxDb(env, boxId, request)
  if (!boxInfo) return json({ error: 'box_not_found' }, 404)
  const client = await getBoxClient(env, boxInfo)
  const sid = getAppSessionIdFromRequest(request)
  const v = await validateAppSession(client, sid)
  if (!v) return json({ appUser: null })
  return json({ appUser: v.appUser })
}

async function postLogout(request, env, boxId) {
  const boxInfo = await resolveBoxDb(env, boxId, request)
  if (!boxInfo) return json({ error: 'box_not_found' }, 404)
  const client = await getBoxClient(env, boxInfo)
  const sid = getAppSessionIdFromRequest(request)
  await deleteAppSession(client, sid)
  const cookiePath = cookiePathForBox(boxInfo, boxId, request)
  const secure = shouldUseSecureCookie(request, env)
  return json({ ok: true }, 200, { 'Set-Cookie': buildAppClearCookie(cookiePath, secure) })
}

// ─────────────────────────────────────────────────────────────────────────────
// Rutas admin — /api/app-auth/{boxId}/admin/*
// ─────────────────────────────────────────────────────────────────────────────

async function getAdminUsers(request, env, boxId) {
  const auth = await requireBoxAsPlatformUser(env, boxId, request)
  if (auth.error) return json({ error: auth.error }, auth.status)
  // Solo GET: viewer NO debe poder listar emails de app_users del box.
  // Mismo criterio que las mutaciones postAdmin* (líneas 254/284/299/314).
  if (auth.auth.role === 'viewer') return json({ error: 'forbidden' }, 403)

  const client = await getBoxClient(env, auth.info)
  await applyAppUsersSchema(client)
  const result = await client.execute(
    `SELECT id, email, display_name, role, created_at, disabled_at
       FROM htmlbox_app_users
       ORDER BY created_at DESC`,
  )
  return json({ users: result.rows })
}

async function postAdminAddUser(request, env, boxId) {
  const auth = await requireBoxAsPlatformUser(env, boxId, request)
  if (auth.error) return json({ error: auth.error }, auth.status)
  if (auth.auth.role === 'viewer') return json({ error: 'forbidden' }, 403)

  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const email = (body?.email || '').trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'invalid_email' }, 400)

  const client = await getBoxClient(env, auth.info)
  // La primera vez que se usa esta tab en un box, las tablas pueden no
  // existir todavía — aplicar el schema es idempotente.
  await applyAppUsersSchema(client)
  await applyAppSettingsSchema(client)

  const existing = await client.execute({
    sql: `SELECT id FROM htmlbox_app_users WHERE email = ?1`,
    args: [email],
  })
  if (existing.rows.length) return json({ error: 'already_exists' }, 409)

  const id = `au_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
  await client.execute({
    sql: `INSERT INTO htmlbox_app_users (id, email, display_name) VALUES (?1, ?2, ?3)`,
    args: [id, email, body?.display_name || null],
  })
  return json({ ok: true, user: { id, email, display_name: body?.display_name || null } })
}

async function postAdminDisableUser(request, env, boxId, userId) {
  const auth = await requireBoxAsPlatformUser(env, boxId, request)
  if (auth.error) return json({ error: auth.error }, auth.status)
  if (auth.auth.role === 'viewer') return json({ error: 'forbidden' }, 403)

  const client = await getBoxClient(env, auth.info)
  await applyAppUsersSchema(client)
  await client.execute({
    sql: `UPDATE htmlbox_app_users SET disabled_at = datetime('now'), updated_at = datetime('now')
           WHERE id = ?1 AND disabled_at IS NULL`,
    args: [userId],
  })
  return json({ ok: true })
}

async function postAdminEnableUser(request, env, boxId, userId) {
  const auth = await requireBoxAsPlatformUser(env, boxId, request)
  if (auth.error) return json({ error: auth.error }, auth.status)
  if (auth.auth.role === 'viewer') return json({ error: 'forbidden' }, 403)

  const client = await getBoxClient(env, auth.info)
  await applyAppUsersSchema(client)
  await client.execute({
    sql: `UPDATE htmlbox_app_users SET disabled_at = NULL, updated_at = datetime('now')
           WHERE id = ?1`,
    args: [userId],
  })
  return json({ ok: true })
}

async function deleteAdminUser(request, env, boxId, userId) {
  const auth = await requireBoxAsPlatformUser(env, boxId, request)
  if (auth.error) return json({ error: auth.error }, auth.status)
  if (auth.auth.role === 'viewer') return json({ error: 'forbidden' }, 403)

  const client = await getBoxClient(env, auth.info)
  await applyAppUsersSchema(client)
  // ON DELETE CASCADE en htmlbox_app_sessions borra las sesiones del user.
  await client.execute({
    sql: `DELETE FROM htmlbox_app_users WHERE id = ?1`,
    args: [userId],
  })
  return json({ ok: true })
}

async function getAdminSettings(request, env, boxId) {
  const auth = await requireBoxAsPlatformUser(env, boxId, request)
  if (auth.error) return json({ error: auth.error }, auth.status)
  // Solo GET: viewer NO debe poder ver el signup_mode configurado del box.
  // Mismo criterio que postAdminSettings (línea 339).
  if (auth.auth.role === 'viewer') return json({ error: 'forbidden' }, 403)

  const client = await getBoxClient(env, auth.info)
  await applyAppSettingsSchema(client)
  const mode = await getSignupMode(client)
  return json({ signup_mode: mode })
}

async function postAdminSettings(request, env, boxId) {
  const auth = await requireBoxAsPlatformUser(env, boxId, request)
  if (auth.error) return json({ error: auth.error }, auth.status)
  if (auth.auth.role === 'viewer') return json({ error: 'forbidden' }, 403)

  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const mode = body?.signup_mode
  if (!['invite_only', 'open'].includes(mode)) {
    return json({ error: 'invalid_signup_mode' }, 400)
  }

  const client = await getBoxClient(env, auth.info)
  await applyAppSettingsSchema(client)
  const result = await setSignupMode(client, mode)
  return json(result)
}

// ─────────────────────────────────────────────────────────────────────────────
// Router principal. Devuelve Response o null si la URL no matchea.
// ─────────────────────────────────────────────────────────────────────────────

const BOX_ID = String.raw`([a-z0-9]{16})`
const USER_ID = String.raw`([a-z][a-z0-9_-]{0,40})`

export async function handleAppAuth(request, env, url) {
  // /api/app-auth/{boxId}/admin/users/{id}/disable|enable
  const userActionM = url.pathname.match(
    new RegExp(`^/api/app-auth/${BOX_ID}/admin/users/${USER_ID}/(disable|enable)$`),
  )
  if (userActionM) {
    const [, boxId, userId, action] = userActionM
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
    return action === 'disable'
      ? await postAdminDisableUser(request, env, boxId, userId)
      : await postAdminEnableUser(request, env, boxId, userId)
  }

  // /api/app-auth/{boxId}/admin/users/{id}  (DELETE)
  const userDeleteM = url.pathname.match(
    new RegExp(`^/api/app-auth/${BOX_ID}/admin/users/${USER_ID}$`),
  )
  if (userDeleteM) {
    const [, boxId, userId] = userDeleteM
    if (request.method !== 'DELETE') return json({ error: 'method_not_allowed' }, 405)
    return await deleteAdminUser(request, env, boxId, userId)
  }

  // /api/app-auth/{boxId}/admin/users  (GET | POST)
  const usersM = url.pathname.match(
    new RegExp(`^/api/app-auth/${BOX_ID}/admin/users$`),
  )
  if (usersM) {
    const [, boxId] = usersM
    if (request.method === 'GET')  return await getAdminUsers(request, env, boxId)
    if (request.method === 'POST') return await postAdminAddUser(request, env, boxId)
    return json({ error: 'method_not_allowed' }, 405)
  }

  // /api/app-auth/{boxId}/admin/settings  (GET | POST)
  const settingsM = url.pathname.match(
    new RegExp(`^/api/app-auth/${BOX_ID}/admin/settings$`),
  )
  if (settingsM) {
    const [, boxId] = settingsM
    if (request.method === 'GET')  return await getAdminSettings(request, env, boxId)
    if (request.method === 'POST') return await postAdminSettings(request, env, boxId)
    return json({ error: 'method_not_allowed' }, 405)
  }

  // /api/app-auth/{boxId}/request|verify|consume|me|logout
  const opM = url.pathname.match(
    new RegExp(`^/api/app-auth/${BOX_ID}/(request|verify|consume|me|logout)$`),
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