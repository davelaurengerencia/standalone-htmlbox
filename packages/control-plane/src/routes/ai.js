// src/routes/ai.js — endpoints AI-asistidos para generación de schema.
//
//   POST /api/ai/analyze-html          { boxId, html } → analysisId + tables
//   GET  /api/ai/analyses?boxId=...    → historial (últimas 10)
//   POST /api/ai/analyses/:id/apply    → marca applied=1
//
// Auth: editor+ para analyze/apply; viewer+ para list.

import { analyzeHtml } from '../lib/aiProvider.js'
import { customAlphabet } from 'nanoid'
import { getSessionIdFromRequest, validateSession, assertWorkspaceScope, requireRole } from '../lib/session.js'

const analysisId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 16)

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function requireUser(request, env) {
  const sid = getSessionIdFromRequest(request)
  const v = await validateSession(env, sid)
  if (!v) return { error: json({ error: 'unauthenticated' }, 401) }
  return { user: v.user }
}

async function resolveBox(env, user, boxId) {
  const row = await env.DB.prepare(`
    SELECT b.id, b.workspace_id, w.tenant_id AS ws_tenant_id
      FROM htmlbox_boxes b
      JOIN htmlbox_workspaces w ON w.id = b.workspace_id
     WHERE b.id = ?1
  `).bind(boxId).first()
  if (!row) return null
  const ws = await assertWorkspaceScope(env, user, row.workspace_id, 'acceder al box')
  return { ...row, role: ws.role }
}

const RATE_BUCKETS = new Map()
function rateLimitOk(userId, limit = 5, windowMs = 60_000) {
  const now = Date.now()
  const bucket = (RATE_BUCKETS.get(userId) || []).filter((t) => now - t < windowMs)
  if (bucket.length >= limit) return false
  bucket.push(now)
  RATE_BUCKETS.set(userId, bucket)
  return true
}

// Rate-limit distribuido vía D1 (A7). Cuenta los análisis del usuario en la
// ventana. Es ligeramente distinto del in-memory: solo cuenta intentos
// exitosos (los que llegan a insertar la fila en htmlbox_ai_analyses). En
// la práctica eso no cambia el comportamiento — un user con sesión válida
// que ya hizo 5 análisis en 60s sigue bloqueado en el 6to.
async function rateLimitOkD1(env, userId, limit = 5, windowMs = 60_000) {
  const windowSec = Math.max(1, Math.floor(windowMs / 1000))
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM htmlbox_ai_analyses
      WHERE user_id = ?1 AND created_at > datetime('now', '-${windowSec} seconds')`
  ).bind(userId).first()
  return (row?.n ?? 0) < limit
}

function resetRateLimits() {
  RATE_BUCKETS.clear()
}

export async function handleAi(request, env, ctx, path, method) {
  if (path === '/api/ai/analyze-html' && method === 'POST') {
    return await analyzeHtmlRoute(request, env)
  }

  if (path === '/api/ai/analyses' && method === 'GET') {
    return await listAnalyses(request, env)
  }

  const applyMatch = path.match(/^\/api\/ai\/analyses\/([a-z0-9]+)\/apply$/)
  if (applyMatch && method === 'POST') {
    return await applyAnalysis(request, env, applyMatch[1])
  }

  return json({ error: 'not_found' }, 404)
}

async function analyzeHtmlRoute(request, env) {
  const { user, error } = await requireUser(request, env)
  if (error) return error

  if (!await rateLimitOkD1(env, user.id)) return json({ error: 'rate_limited' }, 429)

  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const boxId = String(body?.boxId || '')
  const html = typeof body?.html === 'string' ? body.html : ''
  if (!boxId) return json({ error: 'missing_boxId' }, 400)
  if (!html) return json({ error: 'missing_html' }, 400)

  const row = await resolveBox(env, user, boxId)
  if (!row) return json({ error: 'not_found' }, 404)
  try {
    requireRole(row, 'owner', 'editor')
  } catch (err) {
    return json({ error: 'forbidden', detail: err?.message }, 403)
  }

  let result
  try {
    result = await analyzeHtml(html, env)
  } catch (err) {
    return json({ error: 'ai_failed', detail: err?.message || 'unknown' }, 502)
  }

  const id = analysisId()
  await env.DB.prepare(
    `INSERT INTO htmlbox_ai_analyses
       (id, box_id, user_id, prompt_html_size, proposal_json, model, tokens_used, applied)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)`,
  ).bind(
    id,
    boxId,
    user.id,
    html.length,
    JSON.stringify({ tables: result.tables }),
    result.model,
    result.tokensUsed,
  ).run()

  return json({
    analysisId: id,
    model: result.model,
    tokensUsed: result.tokensUsed,
    tables: result.tables,
  })
}

async function listAnalyses(request, env) {
  const { user, error } = await requireUser(request, env)
  if (error) return error

  const url = new URL(request.url)
  const boxId = url.searchParams.get('boxId')
  if (!boxId) return json({ error: 'missing_boxId' }, 400)

  const row = await resolveBox(env, user, boxId)
  if (!row) return json({ error: 'not_found' }, 404)
  try {
    requireRole(row, 'owner', 'editor', 'viewer')
  } catch (err) {
    return json({ error: 'forbidden', detail: err?.message }, 403)
  }

  const rows = await env.DB.prepare(
    `SELECT id, box_id, user_id, prompt_html_size, model, tokens_used, applied, created_at
       FROM htmlbox_ai_analyses
      WHERE box_id = ?1
      ORDER BY created_at DESC
      LIMIT 10`,
  ).bind(boxId).all()

  return json({ analyses: rows.results ?? [] })
}

async function applyAnalysis(request, env, analysisIdStr) {
  const { user, error } = await requireUser(request, env)
  if (error) return error

  const row = await env.DB.prepare(
    `SELECT id, box_id, applied FROM htmlbox_ai_analyses WHERE id = ?1`,
  ).bind(analysisIdStr).first()
  if (!row) return json({ error: 'not_found' }, 404)

  const box = await resolveBox(env, user, row.box_id)
  if (!box) return json({ error: 'not_found' }, 404)
  try {
    requireRole(box, 'owner', 'editor')
  } catch (err) {
    return json({ error: 'forbidden', detail: err?.message }, 403)
  }

  await env.DB.prepare(
    `UPDATE htmlbox_ai_analyses SET applied = 1 WHERE id = ?1`,
  ).bind(analysisIdStr).run()

  return json({ ok: true, id: analysisIdStr, applied: 1 })
}

// Export for tests
export { resetRateLimits }