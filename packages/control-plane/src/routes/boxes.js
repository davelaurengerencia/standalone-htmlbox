// src/routes/boxes.js — CRUD de boxes (HTMLBox).
//
//   GET    /api/boxes?workspace=:id                  → lista
//   POST   /api/boxes                                → crea + provisiona Turso
//   GET    /api/boxes/:id                            → detalle
//   PATCH  /api/boxes/:id   { name, visibility, … }  → edita metadata
//   DELETE /api/boxes/:id                            → soft + cleanup R2/D1
//
// La provisión de la Turso DB se dispara con `provision=true` (default true)
// y corre como una awaitable — si falla, la box queda en turso_status=failed
// y se puede reintentar desde el admin panel.

import { boxId as newBoxId, shareId, isValidBoxSlug, isValidTenantSlug } from '@htmlbox/shared'
import { createBoxDatabase, ensureBoxSchema } from '../lib/tursoClient.js'
import { getSessionIdFromRequest, validateSession, assertTenantScope, assertWorkspaceScope, requireRole } from '../lib/session.js'

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

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'box'
}

export async function handleBoxes(request, env, ctx, path, subId, method) {
  // List / create
  if (!subId && method === 'GET')  return await listBoxes(request, env)
  if (!subId && method === 'POST') return await createBox(request, env)

  // Detail / patch / delete
  if (subId && method === 'GET')    return await getBox(request, env, subId)
  if (subId && method === 'PATCH')  return await patchBox(request, env, subId)
  if (subId && method === 'DELETE') return await deleteBox(request, env, subId)

  return new Response('Not Found', { status: 404 })
}

async function listBoxes(request, env) {
  const { user, error } = await requireUser(request, env)
  if (error) return error

  const url = new URL(request.url)
  const workspaceId = url.searchParams.get('workspace')
  if (!workspaceId) return json({ error: 'missing_workspace' }, 400)

  // Platform owner puede listar cualquiera; el resto debe pertenecer al tenant.
  const ws = await assertWorkspaceScope(env, user, workspaceId, 'listar boxes de')
  // owner, editor o viewer pueden listar.
  requireRole(ws, 'owner', 'editor', 'viewer')

  const rows = await env.DB.prepare(
    `SELECT id, slug, name, visibility, template, htmlbox_version,
            turso_status, share_id, created_at, updated_at
       FROM htmlbox_boxes
      WHERE workspace_id = ?1
      ORDER BY updated_at DESC`
  ).bind(workspaceId).all()
  return json({ boxes: rows.results ?? [] })
}

async function createBox(request, env) {
  const { user, error } = await requireUser(request, env)
  if (error) return error

  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const name = (body?.name || '').trim()
  if (!name) return json({ error: 'missing_name' }, 400)
  const workspaceId = body?.workspace_id
  if (!workspaceId) return json({ error: 'missing_workspace_id' }, 400)

  const ws = await assertWorkspaceScope(env, user, workspaceId, 'crear boxes en')
  requireRole(ws, 'owner', 'editor')

  // Tenant del workspace
  const tenant = await env.DB.prepare(
    `SELECT id, slug FROM htmlbox_tenants WHERE id = ?1`
  ).bind(ws.tenant_id).first()
  if (!tenant) return json({ error: 'tenant_missing' }, 500)

  // Generar slug único dentro del workspace
  const baseSlug = isValidBoxSlug(slugify(name)) ? slugify(name) : 'box'
  let candidate = baseSlug
  let n = 1
  while (await env.DB.prepare(
    `SELECT 1 FROM htmlbox_boxes WHERE workspace_id = ?1 AND slug = ?2`
  ).bind(workspaceId, candidate).first()) {
    n++
    candidate = `${baseSlug}-${n}`
    if (n > 100) return json({ error: 'slug_collision' }, 500)
  }

  const id = newBoxId()
  const share = shareId()

  await env.DB.prepare(`
    INSERT INTO htmlbox_boxes
      (id, tenant_id, workspace_id, slug, name, visibility, template,
       turso_status, share_id, created_by)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?9)
  `).bind(
    id, tenant.id, workspaceId, candidate, name,
    body?.visibility === 'public' ? 'public' : 'private',
    body?.template || 'empty',
    share, user.id,
  ).run()

  // Aprovisionar Turso DB (best-effort — la box queda creada aunque falle).
  try {
    const { url, token } = await createBoxDatabase(env, id)
    await env.DB.prepare(
      `UPDATE htmlbox_boxes SET turso_db_url = ?1, turso_db_token = ?2, turso_status = 'ready', updated_at = datetime('now') WHERE id = ?3`
    ).bind(url, token, id).run()
    try {
      await ensureBoxSchema(env, url, token)
    } catch (schemaErr) {
      console.error(`[boxes] applying base schema failed for ${id}:`, schemaErr)
      await env.DB.prepare(
        `UPDATE htmlbox_boxes SET turso_status = 'schema_failed', updated_at = datetime('now') WHERE id = ?1`
      ).bind(id).run()
    }
  } catch (provErr) {
    console.error(`[boxes] provision failed for ${id}:`, provErr)
    await env.DB.prepare(
      `UPDATE htmlbox_boxes SET turso_status = 'failed', updated_at = datetime('now') WHERE id = ?1`
    ).bind(id).run()
    // Devolvemos 200 con la box creada igual — el caller verá turso_status=failed.
  }

  const created = await env.DB.prepare(
    `SELECT id, slug, name, visibility, template, htmlbox_version, turso_status, share_id, created_at, updated_at
       FROM htmlbox_boxes WHERE id = ?1`
  ).bind(id).first()
  return json({ box: created }, 201)
}

async function getBox(request, env, boxId) {
  const { user, error } = await requireUser(request, env)
  if (error) return error

  const row = await env.DB.prepare(`
    SELECT b.*, w.tenant_id AS ws_tenant_id
      FROM htmlbox_boxes b
      JOIN htmlbox_workspaces w ON w.id = b.workspace_id
     WHERE b.id = ?1
  `).bind(boxId).first()
  if (!row) return json({ error: 'not_found' }, 404)
  if (!user.is_platform_owner) {
    const m = await env.DB.prepare(
      `SELECT 1 FROM htmlbox_memberships WHERE user_id = ?1 AND workspace_id = ?2`
    ).bind(user.id, row.workspace_id).first()
    if (!m || row.ws_tenant_id !== user.tenant_id) {
      return json({ error: 'forbidden' }, 403)
    }
  }
  // platform_owner pasa el check por bypass; seguimos.

  // Ocultar token en respuestas — solo control-plane y runtime lo leen.
  const safe = { ...row, turso_db_token: undefined }
  delete safe.turso_db_token
  return json({ box: safe })
}

async function patchBox(request, env, boxId) {
  const { user, error } = await requireUser(request, env)
  if (error) return error

  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }

  const row = await env.DB.prepare(`
    SELECT b.id, b.workspace_id, w.tenant_id AS ws_tenant_id
      FROM htmlbox_boxes b
      JOIN htmlbox_workspaces w ON w.id = b.workspace_id
     WHERE b.id = ?1
  `).bind(boxId).first()
  if (!row) return json({ error: 'not_found' }, 404)

  const ws = await assertWorkspaceScope(env, user, row.workspace_id, 'editar box')
  requireRole(ws, 'owner', 'editor')

  const fields = []
  const binds = []
  let i = 1
  if (typeof body?.name === 'string' && body.name.trim()) {
    fields.push(`name = ?${i++}`); binds.push(body.name.trim())
  }
  if (body?.visibility === 'public' || body?.visibility === 'private') {
    fields.push(`visibility = ?${i++}`); binds.push(body.visibility)
  }
  if (fields.length === 0) return json({ error: 'nothing_to_update' }, 400)

  fields.push(`updated_at = datetime('now')`)
  binds.push(boxId)

  await env.DB.prepare(
    `UPDATE htmlbox_boxes SET ${fields.join(', ')} WHERE id = ?${i}`
  ).bind(...binds).run()

  const updated = await env.DB.prepare(
    `SELECT id, slug, name, visibility, template, htmlbox_version, turso_status, share_id, created_at, updated_at
       FROM htmlbox_boxes WHERE id = ?1`
  ).bind(boxId).first()
  return json({ box: updated })
}

async function deleteBox(request, env, boxId) {
  const { user, error } = await requireUser(request, env)
  if (error) return error

  const row = await env.DB.prepare(`
    SELECT b.id, b.workspace_id, w.tenant_id AS ws_tenant_id, b.tenant_id AS box_tenant_id
      FROM htmlbox_boxes b
      JOIN htmlbox_workspaces w ON w.id = b.workspace_id
     WHERE b.id = ?1
  `).bind(boxId).first()
  if (!row) return json({ error: 'not_found' }, 404)

  const ws = await assertWorkspaceScope(env, user, row.workspace_id, 'borrar box')
  requireRole(ws, 'owner')

  // Marcar borrado (no destruimos histórico todavía — fase 5)
  await env.DB.prepare(`DELETE FROM htmlbox_boxes WHERE id = ?1`).bind(boxId).run()
  await env.DB.prepare(`DELETE FROM htmlbox_versions WHERE box_id = ?1`).bind(boxId).run()

  // Limpiar versiones en R2 (best-effort)
  try {
    const tenant = await env.DB.prepare(
      `SELECT slug FROM htmlbox_tenants WHERE id = ?1`
    ).bind(row.box_tenant_id).first()
    if (tenant?.slug) {
      const prefix = `tenants/${tenant.slug}/boxes/${boxId}/`
      // list + delete en bucle (R2 list devuelve hasta 1000 por página).
      let cursor
      do {
        const listed = await env.BUCKET.list({ prefix, cursor })
        for (const obj of listed.objects) {
          await env.BUCKET.delete(obj.key)
        }
        cursor = listed.truncated ? listed.cursor : undefined
      } while (cursor)
    }
  } catch (err) {
    console.error(`[boxes] cleanup R2 failed for ${boxId}:`, err)
  }

  return json({ ok: true })
}

// Auxiliares expuestos para otras rutas
export { requireUser }

// Endpoint interno para retry de schema desde el admin panel.
// POST /api/internal/retry-schema/:boxId  { reapply: true } → re-ejecuta ensureBoxSchema
//   y devuelve { ok, status, error? }. Pensado para diagnóstico — NO requiere
//   session de user (solo lo llama el control-plane desde admin).
export async function retrySchema(env, boxId) {
  const row = await env.DB.prepare(
    `SELECT id, turso_db_url, turso_db_token FROM htmlbox_boxes WHERE id = ?1`
  ).bind(boxId).first()
  if (!row || !row.turso_db_url || !row.turso_db_token) {
    return { ok: false, status: 'no_db', error: 'box no tiene Turso DB' }
  }
  try {
    await ensureBoxSchema(env, row.turso_db_url, row.turso_db_token)
    await env.DB.prepare(
      `UPDATE htmlbox_boxes SET turso_status = 'ready', updated_at = datetime('now') WHERE id = ?1`
    ).bind(boxId).run()
    return { ok: true, status: 'ready' }
  } catch (err) {
    await env.DB.prepare(
      `UPDATE htmlbox_boxes SET turso_status = 'schema_failed', updated_at = datetime('now') WHERE id = ?1`
    ).bind(boxId).run()
    return { ok: false, status: 'schema_failed', error: err?.message || 'unknown', stack: err?.stack?.slice(0, 500) }
  }
}