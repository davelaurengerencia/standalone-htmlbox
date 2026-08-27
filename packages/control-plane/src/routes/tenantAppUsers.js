// src/routes/tenantAppUsers.js — admin de htmlbox_tenant_app_users (fase 3).
//
// Endpoints (consumidos por el portal, sesión de plataforma con rol owner/editor):
//   GET    /api/tenant-app-users                                → lista del tenant activo
//   POST   /api/tenant-app-users  { email, display_name? }      → alta de tenant_app_user
//   DELETE /api/tenant-app-users/{id}                          → baja (cascadea accesses + sessions)
//   POST   /api/tenant-app-users/{id}/access  { scope_type, scope_id? } → otorga acceso
//   DELETE /api/tenant-app-users/{id}/access/{accessId}        → revoca acceso
//
// El tenant activo se deduce de la membresía del user en el workspace (mismo
// patrón que el resto de endpoints admin del portal).

import { getSessionIdFromRequest, validateSession, assertTenantScope } from '../lib/session.js'

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  })
}

async function requireUser(request, env) {
  const sid = getSessionIdFromRequest(request)
  const v = await validateSession(env, sid)
  if (!v) return { error: json({ error: 'unauthenticated' }, 401) }
  return { user: v.user }
}

// Devuelve el tenant_id activo del user — si es platform_owner usa el query
// ?tenant_id=... o, si no, el primer tenant donde tenga membresía. Si no
// hay ninguno, error.
async function resolveTenantForUser(request, env, user) {
  if (user.is_platform_owner) {
    const url = new URL(request.url)
    const tidParam = url.searchParams.get('tenant_id')
    if (tidParam) {
      const exists = await env.DB.prepare(`SELECT id FROM htmlbox_tenants WHERE id = ?1`).bind(tidParam).first()
      if (!exists) return { error: json({ error: 'tenant_not_found' }, 404) }
      return { tenantId: tidParam }
    }
    // Sin query, devolvemos el primero
    const any = await env.DB.prepare(`SELECT id FROM htmlbox_tenants ORDER BY created_at LIMIT 1`).first()
    if (!any) return { error: json({ error: 'no_tenant' }, 400) }
    return { tenantId: any.id }
  }
  // Usuario regular — usar su tenant_id
  if (!user.tenant_id) return { error: json({ error: 'user_has_no_tenant' }, 400) }
  return { tenantId: user.tenant_id }
}

export async function handleTenantAppUsers(request, env, ctx, path, method) {
  // ─── /api/tenant-app-users ────────────────────────────────────────────────
  if (path === '/api/tenant-app-users' || path === '/api/tenant-app-users/') {
    const { user, error } = await requireUser(request, env)
    if (error) return error
    const tenant = await resolveTenantForUser(request, env, user)
    if (tenant.error) return tenant.error

    if (method === 'GET') return await listTenantAppUsers(request, env, tenant.tenantId)
    if (method === 'POST') return await createTenantAppUser(request, env, tenant.tenantId)
    return json({ error: 'method_not_allowed' }, 405)
  }

  // ─── /api/tenant-app-users/{id}/access ────────────────────────────────────
  const accessM = path.match(/^\/api\/tenant-app-users\/([a-z0-9_]{4,40})\/access$/)
  if (accessM && method === 'POST') {
    const { user, error } = await requireUser(request, env)
    if (error) return error
    const tenant = await resolveTenantForUser(request, env, user)
    if (tenant.error) return tenant.error
    return await grantAccess(request, env, tenant.tenantId, accessM[1])
  }

  // ─── /api/tenant-app-users/{id}/access/{accessId} ────────────────────────
  const revokeM = path.match(/^\/api\/tenant-app-users\/([a-z0-9_]{4,40})\/access\/([a-z0-9_]{4,40})$/)
  if (revokeM && method === 'DELETE') {
    const { user, error } = await requireUser(request, env)
    if (error) return error
    const tenant = await resolveTenantForUser(request, env, user)
    if (tenant.error) return tenant.error
    return await revokeAccess(request, env, tenant.tenantId, revokeM[1], revokeM[2])
  }

  // ─── /api/tenant-app-users/{id}  DELETE ───────────────────────────────────
  const userM = path.match(/^\/api\/tenant-app-users\/([a-z0-9_]{4,40})$/)
  if (userM && method === 'DELETE') {
    const { user, error } = await requireUser(request, env)
    if (error) return error
    const tenant = await resolveTenantForUser(request, env, user)
    if (tenant.error) return tenant.error
    return await deleteTenantAppUser(request, env, tenant.tenantId, userM[1])
  }

  return json({ error: 'not_found' }, 404)
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function listTenantAppUsers(request, env, tenantId) {
  const users = await env.DB.prepare(
    `SELECT id, email, display_name, created_at, disabled_at
       FROM htmlbox_tenant_app_users
      WHERE tenant_id = ?1
      ORDER BY created_at DESC`
  ).bind(tenantId).all()
  const userRows = users.results || []
  if (userRows.length === 0) return json({ users: [] })

  // Adjuntar los accesos de cada user (1 query batch).
  const ids = userRows.map(u => u.id)
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(',')
  const accesses = await env.DB.prepare(
    `SELECT id, tenant_app_user_id, scope_type, scope_id, role, created_at
       FROM htmlbox_tenant_app_access
      WHERE tenant_app_user_id IN (${placeholders})`
  ).bind(...ids).all()
  const accessRows = accesses.results || []
  const byUser = new Map()
  for (const a of accessRows) {
    if (!byUser.has(a.tenant_app_user_id)) byUser.set(a.tenant_app_user_id, [])
    byUser.get(a.tenant_app_user_id).push(a)
  }
  return json({
    users: userRows.map(u => ({
      ...u,
      accesses: byUser.get(u.id) || [],
    })),
  })
}

async function createTenantAppUser(request, env, tenantId) {
  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const email = (body?.email || '').trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'invalid_email' }, 400)
  const displayName = body?.display_name || null

  const existing = await env.DB.prepare(
    `SELECT id FROM htmlbox_tenant_app_users WHERE tenant_id = ?1 AND email = ?2`
  ).bind(tenantId, email).first()
  if (existing) return json({ error: 'already_exists' }, 409)

  const id = `tu_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
  await env.DB.prepare(
    `INSERT INTO htmlbox_tenant_app_users (id, tenant_id, email, display_name) VALUES (?1, ?2, ?3, ?4)`
  ).bind(id, tenantId, email, displayName).run()
  return json({ ok: true, user: { id, email, display_name: displayName, accesses: [] } })
}

async function deleteTenantAppUser(request, env, tenantId, userId) {
  const exists = await env.DB.prepare(
    `SELECT id FROM htmlbox_tenant_app_users WHERE id = ?1 AND tenant_id = ?2`
  ).bind(userId, tenantId).first()
  if (!exists) return json({ error: 'not_found' }, 404)
  // ON DELETE CASCADE borra accesses + sessions automáticamente.
  await env.DB.prepare(`DELETE FROM htmlbox_tenant_app_users WHERE id = ?1`).bind(userId).run()
  return json({ ok: true })
}

async function grantAccess(request, env, tenantId, userId) {
  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const scopeType = body?.scope_type
  const scopeId = body?.scope_id || null

  if (!['tenant', 'workspace', 'box'].includes(scopeType)) {
    return json({ error: 'invalid_scope_type' }, 400)
  }
  if (scopeType !== 'tenant' && !scopeId) {
    return json({ error: 'missing_scope_id' }, 400)
  }

  // Verificar que el user pertenece al tenant
  const exists = await env.DB.prepare(
    `SELECT id FROM htmlbox_tenant_app_users WHERE id = ?1 AND tenant_id = ?2`
  ).bind(userId, tenantId).first()
  if (!exists) return json({ error: 'user_not_found' }, 404)

  // Validar scope_id según tipo
  if (scopeType === 'workspace') {
    const ws = await env.DB.prepare(
      `SELECT id FROM htmlbox_workspaces WHERE id = ?1 AND tenant_id = ?2`
    ).bind(scopeId, tenantId).first()
    if (!ws) return json({ error: 'workspace_not_found' }, 404)
  } else if (scopeType === 'box') {
    const box = await env.DB.prepare(
      `SELECT id FROM htmlbox_boxes WHERE id = ?1 AND tenant_id = ?2`
    ).bind(scopeId, tenantId).first()
    if (!box) return json({ error: 'box_not_found' }, 404)
  }

  const accessId = `ta_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
  const role = body?.role || 'full'
  await env.DB.prepare(
    `INSERT INTO htmlbox_tenant_app_access (id, tenant_app_user_id, scope_type, scope_id, role)
      VALUES (?1, ?2, ?3, ?4, ?5)`
  ).bind(accessId, userId, scopeType, scopeId, role).run()
  return json({
    ok: true,
    access: { id: accessId, tenant_app_user_id: userId, scope_type: scopeType, scope_id: scopeId, role },
  })
}

async function revokeAccess(request, env, tenantId, userId, accessId) {
  // Validar que el access pertenece a un user del tenant
  const row = await env.DB.prepare(
    `SELECT a.id FROM htmlbox_tenant_app_access a
       JOIN htmlbox_tenant_app_users u ON u.id = a.tenant_app_user_id
      WHERE a.id = ?1 AND a.tenant_app_user_id = ?2 AND u.tenant_id = ?3`
  ).bind(accessId, userId, tenantId).first()
  if (!row) return json({ error: 'not_found' }, 404)
  await env.DB.prepare(`DELETE FROM htmlbox_tenant_app_access WHERE id = ?1`).bind(accessId).run()
  return json({ ok: true })
}