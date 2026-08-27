// src/routes/uploads.js — uploads de HTML versionado.
//
//   POST   /api/boxes/:id/upload-url   { size, contentType } → presigned R2 PUT URL
//   POST   /api/boxes/:id/html        { r2Key, summary, source?, agentName? }
//                                                  → confirma upload + crea versión N
//   GET    /api/boxes/:id/versions                       → historial
//   GET    /api/boxes/:id/versions/:n                    → contenido de una versión
//   POST   /api/boxes/:id/rollback/:n                    → copia como nueva versión
//   GET    /api/boxes/:id/html                           → contenido activo (para servir desde runtime)
//
// Reglas:
//   - El cliente SOLO puede subir a la URL prefirmada por control-plane.
//   - El key SIEMPRE empieza por `tenants/{slug}/boxes/{id}/...`.
//   - Cada push genera una versión. Si > 5, se purga la más antigua (R2 + D1).

import {
  boxVersionKey, ALLOWED_HTML_CONTENT_TYPES, MAX_HTML_BYTES,
  VERSION_SOURCE_PORTAL,
} from '@htmlbox/shared'
import {
  bumpVersion, recordVersion, listVersions, readVersion, purgeIfOverLimit, rollbackTo,
} from '@htmlbox/shared'
import { getSessionIdFromRequest, validateSession, assertWorkspaceScope, requireRole } from '../lib/session.js'

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

// Devuelve el box + su tenant.slug y role del user en el workspace.
// Devuelve null si no existe / no hay permiso.
async function resolveBoxWithScope(env, user, boxId) {
  const row = await env.DB.prepare(`
    SELECT b.id, b.workspace_id, b.tenant_id, b.htmlbox_version, b.turso_status,
           b.turso_db_url, b.turso_db_token,
           t.slug AS tenant_slug
      FROM htmlbox_boxes b
      JOIN htmlbox_tenants t ON t.id = b.tenant_id
     WHERE b.id = ?1
  `).bind(boxId).first()
  if (!row) return null
  const ws = await assertWorkspaceScope(env, user, row.workspace_id, 'acceder al box')
  return { ...row, role: ws.role }
}

export async function handleUploads(request, env, ctx, path, boxId, rest, method) {
  // Presigned URL para subir HTML
  if (rest === '/upload-url' && method === 'POST') {
    return await postUploadUrl(request, env, boxId)
  }

  // Confirmar upload (HTML) → crea versión
  if (rest === '/html' && method === 'POST') {
    return await postPushHtml(request, env, boxId)
  }

  // Listar versiones
  if (rest === '/versions' && method === 'GET') {
    return await getVersions(request, env, boxId)
  }

  // Contenido de una versión específica
  const versionMatch = rest.match(/^\/versions\/(\d+)$/)
  if (versionMatch && method === 'GET') {
    return await getVersionContent(request, env, boxId, Number(versionMatch[1]))
  }

  // Rollback
  const rbMatch = rest.match(/^\/rollback\/(\d+)$/)
  if (rbMatch && method === 'POST') {
    return await postRollback(request, env, boxId, Number(rbMatch[1]))
  }

  // Para el runtime: GET contenido activo (con headers correctos).
  if (rest === '/active-html' && method === 'GET') {
    return await getActiveHtml(request, env, boxId)
  }

  return new Response('Not Found', { status: 404 })
}

async function postUploadUrl(request, env, boxId) {
  const { user, error } = await requireUser(request, env)
  if (error) return error
  const row = await resolveBoxWithScope(env, user, boxId)
  if (!row) return json({ error: 'not_found' }, 404)
  requireRole(row, 'owner', 'editor')

  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const size = Number(body?.size)
  const contentType = String(body?.contentType || '')
  if (!Number.isFinite(size) || size <= 0 || size > MAX_HTML_BYTES) {
    return json({ error: 'invalid_size', max: MAX_HTML_BYTES }, 400)
  }
  if (!ALLOWED_HTML_CONTENT_TYPES.includes(contentType)) {
    return json({ error: 'invalid_content_type', allowed: ALLOWED_HTML_CONTENT_TYPES }, 400)
  }

  // Calculamos la key con la siguiente versión (N+1) — evitamos carrera porque
  // el caller la confirmará con un POST /html.
  const nextVersion = (row.htmlbox_version ?? 0) + 1
  const key = boxVersionKey(row.tenant_slug, boxId, nextVersion)

  // Estrategia de upload en producción: HMAC-signed URL contra el endpoint
  // /api/_local/upload del control-plane (que escribe al R2 vía binding).
  // En dev se usa la misma ruta con HTMLBOX_R2_MODE=local-fake (sin HMAC).
  //
  // Por qué HMAC en lugar de presigned R2 directo: el binding R2 del Worker
  // NO expone createPresignedUrl() en producción (solo en wrangler dev), y
  // los tokens S3 de R2 requieren creación vía dashboard (no vía OAuth CLI).
  // HMAC usa el HTMLBOX_SESSION_SECRET que ya es secret.
  const controlPlaneOrigin = env.HTMLBOX_PUBLIC_ORIGIN || new URL(request.url).origin
  const expiresAt = Math.floor(Date.now() / 1000) + 600 // 10 min
  const sig = await hmacSignHex(env.HTMLBOX_SESSION_SECRET, `${key}\n${expiresAt}`)
  const signedUrl = `${controlPlaneOrigin}/api/_local/upload?key=${encodeURIComponent(key)}&exp=${expiresAt}&sig=${sig}`
  return json({ uploadUrl: signedUrl, key, version: nextVersion, mode: 'hmac-signed' })
}

async function hmacSignHex(secret, message) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function postPushHtml(request, env, boxId) {
  const { user, error } = await requireUser(request, env)
  if (error) return error
  const row = await resolveBoxWithScope(env, user, boxId)
  if (!row) return json({ error: 'not_found' }, 404)
  requireRole(row, 'owner', 'editor')

  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const r2Key = String(body?.r2Key || '')
  const summary = String(body?.summary || '').trim()
  const source = String(body?.source || VERSION_SOURCE_PORTAL)
  const agentName = body?.agentName ? String(body.agentName) : null

  if (!r2Key) return json({ error: 'missing_r2Key' }, 400)
  if (!summary) return json({ error: 'missing_summary' }, 400)

  // Defend: la key DEBE empezar por `tenants/{slug}/boxes/{boxId}/versions/`.
  const expectedPrefix = `tenants/${row.tenant_slug}/boxes/${boxId}/versions/`
  if (!r2Key.startsWith(expectedPrefix) || !r2Key.endsWith('.html')) {
    return json({ error: 'r2Key_out_of_namespace' }, 400)
  }

  // Validar que el objeto realmente existe en R2 y respeta tamaño.
  const obj = await env.BUCKET.get(r2Key)
  if (!obj) return json({ error: 'r2_object_missing' }, 400)
  const len = Number(obj.size)
  if (!Number.isFinite(len) || len <= 0 || len > MAX_HTML_BYTES) {
    await env.BUCKET.delete(r2Key) // limpiamos
    return json({ error: 'invalid_size', max: MAX_HTML_BYTES }, 400)
  }

  // La versión implícita del key debe coincidir con la siguiente.
  const expectedVersion = (row.htmlbox_version ?? 0) + 1
  const m = r2Key.match(/\/versions\/v(\d+)\.html$/)
  if (!m || Number(m[1]) !== expectedVersion) {
    return json({ error: 'version_mismatch', expected: expectedVersion }, 400)
  }

  await recordVersion({
    db: env.DB, boxId, version: expectedVersion,
    source, agentName, summary, userId: user.id,
  })
  await env.DB.prepare(
    `UPDATE htmlbox_boxes SET htmlbox_version = ?1, updated_at = datetime('now') WHERE id = ?2`
  ).bind(expectedVersion, boxId).run()

  // Purgar versiones antiguas si > 5
  await purgeIfOverLimit({
    db: env.DB, bucket: env.BUCKET,
    tenantSlug: row.tenant_slug, boxId,
  })

  return json({ version: expectedVersion, summary, source, agentName })
}

async function getVersions(request, env, boxId) {
  const { user, error } = await requireUser(request, env)
  if (error) return error
  const row = await resolveBoxWithScope(env, user, boxId)
  if (!row) return json({ error: 'not_found' }, 404)

  const versions = await listVersions(env.DB, boxId)
  return json({ versions })
}

async function getVersionContent(request, env, boxId, version) {
  const { user, error } = await requireUser(request, env)
  if (error) return error
  const row = await resolveBoxWithScope(env, user, boxId)
  if (!row) return json({ error: 'not_found' }, 404)

  const html = await readVersion(env.BUCKET, row.tenant_slug, boxId, version)
  if (html === null) return json({ error: 'version_not_found' }, 404)
  return json({ version, html, size: html.length })
}

async function postRollback(request, env, boxId, targetVersion) {
  const { user, error } = await requireUser(request, env)
  if (error) return error
  const row = await resolveBoxWithScope(env, user, boxId)
  if (!row) return json({ error: 'not_found' }, 404)
  requireRole(row, 'owner', 'editor')

  try {
    const { version, html } = await rollbackTo({
      db: env.DB, bucket: env.BUCKET,
      tenantSlug: row.tenant_slug, boxId, targetVersion,
      userId: user.id,
    })
    return json({ version, size: html.length })
  } catch (err) {
    return json({ error: 'rollback_failed', detail: err?.message || 'unknown' }, 400)
  }
}

// Para el runtime: servir el HTML activo con la cabecera X-HTMLBox-Version.
// Devuelve un objeto { html, version } en JSON para que el runtime Worker
// lo entregue con las cabeceras que quiera. (El runtime NO está obligado a
// llamarlo — puede leer directamente de R2 con sus propias credenciales.)
async function getActiveHtml(request, env, boxId) {
  // Primero chequeamos la box para conocer su visibilidad — eso decide el
  // nivel de auth necesario. Un box público se sirve sin sesión.
  const box = await env.DB.prepare(`
    SELECT b.htmlbox_version, b.visibility, b.share_id, b.workspace_id, t.slug AS tenant_slug
      FROM htmlbox_boxes b JOIN htmlbox_tenants t ON t.id = b.tenant_id
     WHERE b.id = ?1
  `).bind(boxId).first()
  if (!box) return json({ error: 'not_found' }, 404)
  if (!box.htmlbox_version) return json({ error: 'no_published_version' }, 404)

  // Boxes públicos: no requieren auth (el lookup por shareId ya validó).
  if (box.visibility !== 'public') {
    // Privado: API key con scope=read, o sesión con rol viewer+.
    const auth = request.headers.get('authorization') || ''
    let authorized = false

    if (auth.startsWith('Bearer hbx_')) {
      const raw = auth.slice('Bearer '.length).trim()
      const hash = await sha256Hex(raw)
      const tok = await env.DB.prepare(`
        SELECT t.scope, t.revoked_at, t.expires_at
          FROM htmlbox_api_tokens t
         WHERE t.token_hash = ?1 AND t.box_id = ?2
      `).bind(hash, boxId).first()
      if (tok && !tok.revoked_at && (!tok.expires_at || new Date(tok.expires_at) > new Date())) {
        if ((tok.scope || '').split(',').map((s) => s.trim()).includes('read')) {
          authorized = true
          env.DB.prepare(`UPDATE htmlbox_api_tokens SET last_used_at = datetime('now') WHERE token_hash = ?1`).bind(hash).run().catch(() => {})
        }
      }
    }

    if (!authorized) {
      const sid = getSessionIdFromRequest(request)
      const v = await validateSession(env, sid)
      if (!v) return json({ error: 'unauthenticated' }, 401)
      const row = await resolveBoxWithScope(env, v.user, boxId)
      if (!row) return json({ error: 'not_found' }, 404)
      requireRole(row, 'owner', 'editor', 'viewer')
    }
  }

  const html = await readVersion(env.BUCKET, box.tenant_slug, boxId, box.htmlbox_version)
  if (html === null) return json({ error: 'version_not_found' }, 404)

  return json({
    version: box.htmlbox_version,
    html,
    visibility: box.visibility,
    share_id: box.share_id,
  })
}

async function sha256Hex(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}