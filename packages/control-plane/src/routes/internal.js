// src/routes/internal.js — endpoints internos del control-plane consumidos por el runtime.
//
//   GET  /api/internal/boxes-by-share/:shareId        → lookup público
//   GET  /api/internal/boxes-by-slug/:tenant/:slug    → lookup privado
//   GET  /api/internal/boxes/:boxId/db                → credenciales Turso (runtime)
//   POST /api/internal/retry-schema/:boxId            → re-aplica el schema (diagnóstico desde el admin)
//
// Estos endpoints NO se exponen al browser (públicos con rate-limit) — solo
// se llaman desde el runtime worker con la cookie de sesión cuando aplica.

import { retrySchema } from './boxes.js'

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function handleInternal(request, env, ctx, path, method) {
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

  return json({ error: 'not_found' }, 404)
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
           t.slug AS tenant_slug, b.workspace_id
      FROM htmlbox_boxes b
      JOIN htmlbox_tenants t ON t.id = b.tenant_id
     WHERE b.id = ?1
  `).bind(boxId).first()
  if (!row || !row.turso_db_url || !row.turso_db_token) {
    return json({ box: null }, 404)
  }

  // Auth: platform_owner pasa. Resto: debe ser miembro del workspace.
  if (!sess.is_platform_owner) {
    if (sess.tenant_id !== row.workspace_id) {
      // (workspace_id del box != tenant_id del user) — verificar membresía.
      const m = await env.DB.prepare(`
        SELECT 1 FROM htmlbox_memberships WHERE user_id = ?1 AND workspace_id = ?2
      `).bind(sess.user_id, row.workspace_id).first()
      if (!m) return json({ box: null }, 403)
    }
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