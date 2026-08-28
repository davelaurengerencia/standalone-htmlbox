// src/routes/internal.js — endpoints internos del control-plane consumidos por el runtime.
//
//   GET  /api/internal/boxes-by-share/:shareId        → lookup público
//   GET  /api/internal/boxes-by-slug/:tenant/:slug    → lookup privado
//   GET  /api/internal/boxes/:boxId/db                → credenciales Turso (runtime)
//   POST /api/internal/retry-schema/:boxId            → re-aplica el schema (diagnóstico desde el admin)
//   POST /api/internal/wfp/migrate-tags               → re-deploya per-box scripts con tags (one-off admin)
//   POST /api/internal/send-app-magic-link            → envío de magic link para usuarios de la app (runtime → control-plane)
//   POST /api/internal/tenant-app-auth/request        → magic link TENANT-app-user (fase 3)
//   POST /api/internal/tenant-app-auth/consume        → consume + crea sesión TENANT-app-user (fase 3)
//   POST /api/internal/tenant-app-auth/access         → chequea si tenant-app-user tiene acceso al box (fase 3)
//
//   GET/POST/DELETE /api/tenant-app-users/...         → admin portal de usuarios centralizados (fase 3)
//
// Estos endpoints NO se exponen al browser (públicos con rate-limit) — solo
// se llaman desde el runtime worker con la cookie de sesión cuando aplica.

import { retrySchema } from './boxes.js'
import { sendAppMagicLinkEmail } from '../lib/email.js'
import { deployBoxWorker } from '../lib/wfpDeployer.js'
import {
  isTenantAppRateLimited, createTenantAppMagicLink, consumeTenantAppMagicLink,
  findTenantAppUserByEmail, createTenantAppSession, validateTenantAppSession,
  checkTenantAppAccess, buildTenantAppSessionCookie,
  buildTenantAppClearCookie, getTenantAppSessionIdFromRequest,
  requireRole, assertTenantScope,
} from '../lib/session.js'

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function handleInternal(request, env, ctx, path, method) {
  // Gate de secreto compartido con el runtime Worker. Los endpoints bajo
  // /api/internal/boxes/* y /api/internal/whoami devuelven credenciales
  // sensibles (Turso DB token) o gobiernan permisos, así que NO pueden
  // ser llamados directo desde un browser con solo la cookie sid — eso
  // habilitaría un bypass de rol (cualquier viewer podría obtener el
  // token completo de Turso).
  //
  // boxes-by-share y boxes-by-slug quedan exentos: son lookups públicos
  // (resolución shareId/tenant+slug → boxId) que el runtime hace ANTES
  // de tener credenciales para agregar headers.
  const requiresInternalSecret =
    path.startsWith('/api/internal/boxes/') ||
    path === '/api/internal/whoami' ||
    path === '/api/internal/send-app-magic-link' ||
    path.startsWith('/api/internal/tenant-app-auth/') ||
    path.startsWith('/api/internal/wfp/')

  if (requiresInternalSecret) {
    const provided = request.headers.get('X-HTMLBox-Internal-Secret') || ''
    if (!env.HTMLBOX_INTERNAL_SECRET || provided !== env.HTMLBOX_INTERNAL_SECRET) {
      return json({ error: 'forbidden' }, 403)
    }
  }

  // /api/internal/whoami
  if (path === '/api/internal/whoami' && method === 'GET') {
    return await whoami(env, request)
  }

  // /api/internal/boxes-by-share/{shareId}
  const shareMatch = path.match(/^\/api\/internal\/boxes-by-share\/([a-z0-9]+)$/)
  if (shareMatch && method === 'GET') {
    return await getByShare(env, shareMatch[1])
  }

  // /api/internal/boxes-by-slug/{tenant}/{slug}
  const slugMatch = path.match(/^\/api\/internal\/boxes-by-slug\/([a-z0-9-]+)\/([a-z0-9_-]+)$/)
  if (slugMatch && method === 'GET') {
    return await getByTenantSlug(env, slugMatch[1], slugMatch[2], request)
  }

  // /api/internal/boxes/{boxId}/db  — devuelve credenciales Turso al runtime
  const dbMatch = path.match(/^\/api\/internal\/boxes\/([a-z0-9]+)\/db$/)
  if (dbMatch && method === 'GET') {
    return await getBoxDb(env, dbMatch[1], request)
  }

  // /api/internal/boxes/{boxId}/membership  — rol del user en el box
  const memberMatch = path.match(/^\/api\/internal\/boxes\/([a-z0-9]+)\/membership$/)
  if (memberMatch && method === 'GET') {
    return await getBoxMembership(env, memberMatch[1], request)
  }

  // POST /api/internal/retry-schema/{boxId}  — diagnóstico admin
  const retryMatch = path.match(/^\/api\/internal\/retry-schema\/([a-z0-9]+)$/)
  if (retryMatch && method === 'POST') {
    const result = await retrySchema(env, retryMatch[1])
    return json(result, result.ok ? 200 : 500)
  }

  // POST /api/internal/wfp/migrate-tags  — one-off admin: re-deploya los
  // per-box scripts ya existentes en WFP, agregándoles los tags legibles
  // (tenant, box, visibility, template). El bundle no cambia — solo el
  // metadata. Best-effort: si falla uno, sigue con el siguiente.
  if (path === '/api/internal/wfp/migrate-tags' && method === 'POST') {
    return await postWfpMigrateTags(env)
  }

  // POST /api/internal/send-app-magic-link  — runtime delega el envío al
  // control-plane (que tiene binding MAIL). El body trae el magic link YA
  // ARMADO apuntando a runtime — esta función solo renderiza y envía.
  if (path === '/api/internal/send-app-magic-link' && method === 'POST') {
    return await postSendAppMagicLink(request, env)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Fase 3 — htmlbox-spec-app-users-centralized.md
  // ─────────────────────────────────────────────────────────────────────────

  if (path === '/api/internal/tenant-app-auth/request' && method === 'POST') {
    return await postTenantAppRequest(request, env)
  }
  if (path === '/api/internal/tenant-app-auth/consume' && method === 'POST') {
    return await postTenantAppConsume(request, env)
  }
  if (path === '/api/internal/tenant-app-auth/access' && method === 'POST') {
    return await postTenantAppAccessCheck(request, env)
  }

  return json({ error: 'not_found' }, 404)
}

// POST /api/internal/tenant-app-auth/request
// Body: { tenantId, email, magicLinkBase }
// Devuelve { ok, _dev_preview?, _email_mode? }. Genera magic link en D1,
// delega el envío a control-plane (binding MAIL). El magicLink lo arma
// runtime (sabe su origin); control-plane solo le agrega el token al final.
async function postTenantAppRequest(request, env) {
  let body
  try { body = await request.json() } catch { return json({ ok: true }) }
  const { tenantId, email: rawEmail } = body || {}
  const email = (rawEmail || '').trim().toLowerCase()
  const GENERIC = { ok: true }
  if (!tenantId || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(GENERIC)

  const appUser = await findTenantAppUserByEmail(env, tenantId, email)
  if (!appUser || appUser.disabled_at) return json(GENERIC) // invite_only siempre acá

  if (await isTenantAppRateLimited(env, email, tenantId)) return json(GENERIC)

  const { id: tokenId } = await createTenantAppMagicLink(env, email, tenantId)
  const magicLinkBase = body.magicLinkBase
  if (!magicLinkBase) return json({ error: 'missing_magic_link_base' }, 400)
  const magicLink = `${magicLinkBase}${tokenId}`

  const tenant = await env.DB.prepare(`SELECT name FROM htmlbox_tenants WHERE id = ?1`).bind(tenantId).first()
  const emailResult = await sendAppMagicLinkEmail(env, { toEmail: email, magicLink, boxName: tenant?.name || null })
  return json({ ...GENERIC, _dev_preview: emailResult?.previewLink, _email_mode: emailResult?.mode })
}

// POST /api/internal/tenant-app-auth/consume
// Body: { token }
// Devuelve { ok, tenantAppUser, cookie }. Runtime reenvía el cookie tal cual
// en su respuesta (control-plane no puede setear cookies en el browser del
// visitante del box — el response que llega al browser lo arma runtime).
async function postTenantAppConsume(request, env) {
  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const token = body?.token
  if (!token) return json({ error: 'missing_token' }, 400)

  const consumed = await consumeTenantAppMagicLink(env, token)
  if (!consumed) return json({ error: 'invalid_or_expired_token' }, 400)

  const appUser = await findTenantAppUserByEmail(env, consumed.tenant_id, consumed.email)
  if (!appUser || appUser.disabled_at) return json({ error: 'user_not_found_or_disabled' }, 403)

  const sess = await createTenantAppSession(env, appUser.id)
  const cookie = buildTenantAppSessionCookie(request, sess.id, env)
  return json({
    ok: true,
    tenantAppUser: { id: appUser.id, email: appUser.email, display_name: appUser.display_name },
    cookie,
  })
}

// POST /api/internal/tenant-app-auth/access
// Body: { boxId } + cookie hbx_tapp_sid reenviada por runtime
// Devuelve { allowed, role?, tenantAppUser? }
async function postTenantAppAccessCheck(request, env) {
  let body
  try { body = await request.json() } catch { return json({ allowed: false }) }
  const boxId = body?.boxId
  if (!boxId) return json({ allowed: false })

  const sid = getTenantAppSessionIdFromRequest(request)
  const v = await validateTenantAppSession(env, sid)
  if (!v) return json({ allowed: false })

  const box = await env.DB.prepare(
    `SELECT id, tenant_id, workspace_id FROM htmlbox_boxes WHERE id = ?1`
  ).bind(boxId).first()
  if (!box || box.tenant_id !== v.tenantAppUser.tenant_id) return json({ allowed: false })

  const access = await checkTenantAppAccess(env, v.tenantAppUser.id, box)
  if (!access.allowed) return json({ allowed: false })
  return json({ allowed: true, role: access.role, tenantAppUser: v.tenantAppUser })
}

// POST /api/internal/send-app-magic-link
// Body: { toEmail, magicLink, boxName }
// Devuelve el mismo shape que sendAppMagicLinkEmail: { sent, previewLink?, mode, error? }
async function postSendAppMagicLink(request, env) {
  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const toEmail = (body?.toEmail || '').trim().toLowerCase()
  const magicLink = body?.magicLink || ''
  const boxName = body?.boxName || null
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(toEmail) || !magicLink) {
    return json({ error: 'invalid_body' }, 400)
  }
  const result = await sendAppMagicLinkEmail(env, { toEmail, magicLink, boxName })
  return json(result)
}

async function getByShare(env, shareId) {
  const row = await env.DB.prepare(`
    SELECT b.id, b.slug, b.visibility, b.turso_status, b.htmlbox_version,
           t.slug AS tenant_slug
      FROM htmlbox_boxes b
      JOIN htmlbox_tenants t ON t.id = b.tenant_id
     WHERE b.share_id = ?1
       AND b.visibility = 'public'
  `).bind(shareId).first()
  if (!row) return json({ box: null }, 404)
  return json({ box: row })
}

async function getByTenantSlug(env, tenantSlug, boxSlug, request) {
  const tenant = await env.DB.prepare(
    `SELECT id FROM htmlbox_tenants WHERE slug = ?1`
  ).bind(tenantSlug).first()
  if (!tenant) return json({ box: null }, 404)

  const row = await env.DB.prepare(`
    SELECT b.id, b.slug, b.visibility, b.turso_status, b.htmlbox_version, b.tenant_id,
           t.slug AS tenant_slug
      FROM htmlbox_boxes b
      JOIN htmlbox_tenants t ON t.id = b.tenant_id
     WHERE t.id = ?1 AND b.slug = ?2
  `).bind(tenant.id, boxSlug).first()
  if (!row) return json({ box: null }, 404)

  // Si es privado, validamos que el request trae sesión con permiso.
  if (row.visibility === 'private') {
    const sid = readCookie(request, 'sid')
    if (!sid) return json({ box: null }, 403)

    const sess = await env.DB.prepare(`
      SELECT u.id AS user_id, u.tenant_id, u.is_platform_owner
        FROM htmlbox_sessions s JOIN htmlbox_users u ON u.id = s.user_id
       WHERE s.id = ?1 AND datetime(s.expires_at) > datetime('now')
    `).bind(sid).first()
    if (!sess) return json({ box: null }, 403)
    if (!sess.is_platform_owner && sess.tenant_id !== tenant.id) {
      return json({ box: null }, 403)
    }
    const m = await env.DB.prepare(
      `SELECT 1 FROM htmlbox_memberships WHERE user_id = ?1 AND workspace_id = ?2`,
    ).bind(sess.user_id, row.tenant_id).first()
    if (!m) return json({ box: null }, 403)
  }

  return json({ box: row })
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

// GET /api/internal/whoami — sesión del request (sin path params)
async function whoami(env, request) {
  const sid = readCookie(request, 'sid')
  if (!sid) return json({ error: 'unauthenticated' }, 401)
  const sess = await env.DB.prepare(`
    SELECT u.id AS user_id, u.email, u.tenant_id, u.is_platform_owner
      FROM htmlbox_sessions s JOIN htmlbox_users u ON u.id = s.user_id
     WHERE s.id = ?1 AND datetime(s.expires_at) > datetime('now')
  `).bind(sid).first()
  if (!sess) return json({ error: 'unauthenticated' }, 401)
  return json({
    userId: sess.user_id,
    email: sess.email,
    tenantId: sess.tenant_id,
    isPlatformOwner: !!sess.is_platform_owner,
  })
}

// GET /api/internal/boxes/{boxId}/db
// Devuelve { box: { id, slug, visibility, tenant_slug, turso_db_url, turso_db_token } }
// o { box: null } si no existe / no tiene DB lista / no autorizado.
// Auth: reenvía cookie de sesión; valida que el usuario sea miembro del tenant.
//   - Boxes públicos: cualquier petición autenticada con sesión válida en el
//     tenant puede leer credenciales (el runtime las usa solo para servir
//     datos a quien ya pasó auth).
//   - Boxes privados: idem (mismo check).
async function getBoxDb(env, boxId, request) {
  const sid = readCookie(request, 'sid')
  if (!sid) return json({ box: null }, 403)

  const sess = await env.DB.prepare(`
    SELECT u.id AS user_id, u.tenant_id, u.is_platform_owner
      FROM htmlbox_sessions s JOIN htmlbox_users u ON u.id = s.user_id
     WHERE s.id = ?1 AND datetime(s.expires_at) > datetime('now')
  `).bind(sid).first()
  if (!sess) return json({ box: null }, 403)

  const row = await env.DB.prepare(`
    SELECT b.id, b.slug, b.visibility, b.turso_status, b.turso_db_url, b.turso_db_token,
           t.slug AS tenant_slug, b.workspace_id, b.tenant_id
      FROM htmlbox_boxes b
      JOIN htmlbox_tenants t ON t.id = b.tenant_id
     WHERE b.id = ?1
  `).bind(boxId).first()
  if (!row || !row.turso_db_url || !row.turso_db_token) {
    return json({ box: null }, 404)
  }

  // Auth: platform_owner pasa. Resto: debe ser del mismo tenant Y miembro del workspace.
  if (!sess.is_platform_owner) {
    if (sess.tenant_id !== row.tenant_id) {
      // ni siquiera es del mismo tenant — cortar acá
      return json({ box: null }, 403)
    }
    const m = await env.DB.prepare(`
      SELECT 1 FROM htmlbox_memberships WHERE user_id = ?1 AND workspace_id = ?2
    `).bind(sess.user_id, row.workspace_id).first()
    if (!m) return json({ box: null }, 403)
  }
  return json({ box: row })
}

// GET /api/internal/boxes/{boxId}/membership → { membership: { role } } | { membership: null }
async function getBoxMembership(env, boxId, request) {
  const sid = readCookie(request, 'sid')
  if (!sid) return json({ membership: null }, 401)
  const sess = await env.DB.prepare(`
    SELECT u.id AS user_id, u.is_platform_owner
      FROM htmlbox_sessions s JOIN htmlbox_users u ON u.id = s.user_id
     WHERE s.id = ?1 AND datetime(s.expires_at) > datetime('now')
  `).bind(sid).first()
  if (!sess) return json({ membership: null }, 401)
  if (sess.is_platform_owner) return json({ membership: { role: 'owner' } })

  const row = await env.DB.prepare(`
    SELECT b.workspace_id FROM htmlbox_boxes b WHERE b.id = ?1
  `).bind(boxId).first()
  if (!row) return json({ membership: null }, 404)
  const m = await env.DB.prepare(`
    SELECT role FROM htmlbox_memberships WHERE user_id = ?1 AND workspace_id = ?2
  `).bind(sess.user_id, row.workspace_id).first()
  if (!m) return json({ membership: null }, 403)
  return json({ membership: { role: m.role } })
}

// POST /api/internal/wfp/migrate-tags
// One-off admin: re-deploya TODOS los per-box scripts existentes en WFP
// con los tags legibles (tenant / box / visibility / template). Útil para
// poblar tags en boxes creados antes de que se implementara este feature.
//
// Respuesta: { total, succeeded, failed: [{ boxId, error }] }
// - total: cantidad de boxes ready que se intentó re-deployar
// - succeeded: cantidad que respondió 200 OK
// - failed: array con boxId + mensaje de error por cada fallo (best-effort)
//
// No es idempotente en sentido estricto: el PUT a Cloudflare es idempotente
// (mismo bundle + mismas tags), pero la query a D1 NO se filtra por
// wfp_status='ready' — si hay un box 'failed' en WFP, lo intenta igual.
// Si querés solo los ready, filtrar en el SQL antes del loop.
async function postWfpMigrateTags(env) {
  const accountId = env.HTMLBOX_CLOUDFLARE_ACCOUNT_ID
  const namespace = env.HTMLBOX_WFP_NAMESPACE || 'htmlbox-boxes'
  if (!env.WFP_DEPLOY_TOKEN || !accountId) {
    return json({ error: 'wfp_not_configured', detail: !env.WFP_DEPLOY_TOKEN ? 'WFP_DEPLOY_TOKEN faltante' : 'HTMLBOX_CLOUDFLARE_ACCOUNT_ID faltante' }, 503)
  }

  // Solo boxes con wfp_status='ready' — los 'failed' no tienen script en
  // WFP para re-deployar (o lo tienen en estado roto). El operador puede
  // usar el botón "retry" en el admin panel para esos casos.
  const rows = await env.DB.prepare(`
    SELECT b.id, b.slug, b.visibility, b.template,
           t.id AS tenant_id, t.slug AS tenant_slug
      FROM htmlbox_boxes b
      JOIN htmlbox_tenants t ON t.id = b.tenant_id
     WHERE b.wfp_status = 'ready'
     ORDER BY b.created_at ASC
  `).all()
  const boxes = rows.results ?? []

  let succeeded = 0
  const failed = []
  for (const box of boxes) {
    const tags = [
      `tenant:${box.tenant_slug}`,
      `box:${box.slug}`,
      `tenant-id:${box.tenant_id}`,
      `box-id:${box.id}`,
      `visibility:${box.visibility}`,
      `template:${box.template || 'empty'}`,
    ]
    try {
      await deployBoxWorker(env, accountId, namespace, box.id, { tags })
      succeeded++
    } catch (err) {
      console.error(`[wfp/migrate-tags] failed for box ${box.id}:`, err)
      failed.push({ boxId: box.id, error: String(err?.message || err).slice(0, 500) })
    }
  }

  return json({ total: boxes.length, succeeded, failed })
}