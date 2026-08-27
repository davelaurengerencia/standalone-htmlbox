// src/routes/tenants.js — CRUD de tenants + workspaces + memberships.
//
// Para que el portal pueda arrancar en frío: el primer user que pide un
// magic-link y no pertenece a ningún tenant (es el platform owner) puede
// crear su tenant inicial desde aquí. El resto, vía admin.

import { getSessionIdFromRequest, validateSession, requireRole, assertTenantScope } from '../lib/session.js'
import { isValidTenantSlug } from '@htmlbox/shared'

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

export async function handleTenants(request, env, ctx, path, sub, method) {
  // /api/me/tenants — lista los tenants del user actual
  if (path === '/api/me/tenants' && method === 'GET') return await listMyTenants(request, env)

  // /api/tenants — crear tenant (platform owner only)
  if (path === '/api/tenants' && method === 'POST') return await createTenant(request, env)

  // /api/tenants/:id/workspaces
  if (path.startsWith('/api/tenants/') && path.endsWith('/workspaces') && method === 'GET') {
    const id = sub
    return await listWorkspaces(request, env, id)
  }
  if (path.startsWith('/api/tenants/') && path.endsWith('/workspaces') && method === 'POST') {
    const id = sub
    return await createWorkspace(request, env, id)
  }

  return new Response('Not Found', { status: 404 })
}

async function listMyTenants(request, env) {
  const { user, error } = await requireUser(request, env)
  if (error) return error

  if (user.is_platform_owner) {
    const rows = await env.DB.prepare(`SELECT id, slug, name, status FROM htmlbox_tenants ORDER BY created_at`).all()
    return json({ tenants: rows.results ?? [], is_platform_owner: true })
  }

  const rows = await env.DB.prepare(`
    SELECT DISTINCT t.id, t.slug, t.name, t.status
      FROM htmlbox_tenants t
      JOIN htmlbox_workspaces w ON w.tenant_id = t.id
      JOIN htmlbox_memberships m ON m.workspace_id = w.id
     WHERE m.user_id = ?1
     ORDER BY t.created_at
  `).bind(user.id).all()
  return json({ tenants: rows.results ?? [] })
}

async function createTenant(request, env) {
  const { user, error } = await requireUser(request, env)
  if (error) return error
  if (!user.is_platform_owner) return json({ error: 'platform_owner_only' }, 403)

  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const slug = (body?.slug || '').trim().toLowerCase()
  const name = (body?.name || '').trim()
  if (!isValidTenantSlug(slug)) return json({ error: 'invalid_slug' }, 400)
  if (!name) return json({ error: 'missing_name' }, 400)

  const exists = await env.DB.prepare(`SELECT 1 FROM htmlbox_tenants WHERE slug = ?1`).bind(slug).first()
  if (exists) return json({ error: 'slug_taken' }, 409)

  const tenantId = `tenant_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
  await env.DB.prepare(
    `INSERT INTO htmlbox_tenants (id, slug, name) VALUES (?1, ?2, ?3)`
  ).bind(tenantId, slug, name).run()

  // Crear workspace "Default"
  const wsId = `ws_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
  await env.DB.prepare(
    `INSERT INTO htmlbox_workspaces (id, tenant_id, name) VALUES (?1, ?2, 'Default')`
  ).bind(wsId, tenantId).run()

  // Owner del workspace = platform owner
  await env.DB.prepare(
    `INSERT INTO htmlbox_memberships (user_id, workspace_id, role) VALUES (?1, ?2, 'owner')`
  ).bind(user.id, wsId).run()

  return json({ tenant: { id: tenantId, slug, name } }, 201)
}

async function listWorkspaces(request, env, tenantId) {
  const { user, error } = await requireUser(request, env)
  if (error) return error
  assertTenantScope(user, tenantId, 'listar workspaces')

  const rows = await env.DB.prepare(`
    SELECT w.id, w.name, w.created_at,
           (SELECT COUNT(*) FROM htmlbox_boxes b WHERE b.workspace_id = w.id) AS box_count
      FROM htmlbox_workspaces w
     WHERE w.tenant_id = ?1
     ORDER BY w.created_at
  `).bind(tenantId).all()
  return json({ workspaces: rows.results ?? [] })
}

async function createWorkspace(request, env, tenantId) {
  const { user, error } = await requireUser(request, env)
  if (error) return error
  assertTenantScope(user, tenantId, 'crear workspaces')

  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const name = (body?.name || '').trim()
  if (!name) return json({ error: 'missing_name' }, 400)

  const wsId = `ws_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
  await env.DB.prepare(
    `INSERT INTO htmlbox_workspaces (id, tenant_id, name) VALUES (?1, ?2, ?3)`
  ).bind(wsId, tenantId, name).run()
  await env.DB.prepare(
    `INSERT INTO htmlbox_memberships (user_id, workspace_id, role) VALUES (?1, ?2, 'owner')`
  ).bind(user.id, wsId).run()

  return json({ workspace: { id: wsId, name, tenant_id: tenantId } }, 201)
}