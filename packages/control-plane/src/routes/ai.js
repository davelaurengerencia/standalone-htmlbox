// src/routes/ai.js — endpoints AI-asistidos para generación de schema.
//
//   POST /api/ai/analyze-html          { boxId, html } → analysisId + tables + candidates
//   GET  /api/ai/analyses?boxId=...    → historial (últimas 10)
//   POST /api/ai/analyses/:id/apply    { html } → crea tablas, inserta TODAS las filas,
//                                                  reescribe el HTML, guarda nueva versión
//
// Auth: editor+ para analyze/apply; viewer+ para list.
//
// Cambios en esta versión (htmlbox-spec-ai-apply-schema.md):
//   - analyzeHtmlRoute corre extractArrayCandidates() sobre el HTML ANTES de
//     llamar a Gemini, y le pasa los candidatos al provider.
//   - analyzeHtmlRoute guarda `candidates_json` en la fila D1 (esencial para
//     que apply NO tenga que re-extraer del HTML viejo — y para el caso de
//     apply con el HTML ACTUAL, lo re-extrae igual por seguridad).
//   - applyAnalysis hace el trabajo real: crear tablas físicas, insertar
//     TODAS las filas del candidato (no las sample_rows), reescribir el
//     HTML agregando type="module" al <script> y reemplazando cada `const X = [...]`
//     por `const X = await HTMLBox.table('slug').rows({ limit: 1000 })`,
//     guardar como nueva versión en R2, marcar applied=1.

import { analyzeHtml } from '../lib/aiProvider.js'
import { extractArrayCandidates } from '../lib/dataExtractor.js'
import { connectToBox } from '../lib/tursoClient.js'
import { physicalTableSqlFor, recordVersion, purgeIfOverLimit, boxVersionKey } from '@htmlbox/shared'
import { findSingleInlineScript } from '../lib/dataExtractor.js'
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

  // Paso 1 del spec: extracción determinística de candidatos de arrays
  // embebidos en el HTML (regex + JSON.parse, nunca eval()). Si no hay un
  // único <script> inline, no hay candidatos — la IA trabaja igual que
  // antes (propone schema) pero ninguna tabla tendrá source_var.
  const candidates = extractArrayCandidates(html)

  let result
  try {
    result = await analyzeHtml(html, env, { candidates })
  } catch (err) {
    return json({ error: 'ai_failed', detail: err?.message || 'unknown' }, 502)
  }

  const id = analysisId()
  await env.DB.prepare(
    `INSERT INTO htmlbox_ai_analyses
       (id, box_id, user_id, prompt_html_size, proposal_json, candidates_json, model, tokens_used, applied)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0)`,
  ).bind(
    id,
    boxId,
    user.id,
    html.length,
    JSON.stringify({ tables: result.tables }),
    JSON.stringify(candidates),  // guardamos para que apply NO tenga que re-extraer del HTML viejo
    result.model,
    result.tokensUsed,
  ).run()

  return json({
    analysisId: id,
    model: result.model,
    tokensUsed: result.tokensUsed,
    tables: result.tables,
    candidates,
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

// ─────────────────────────────────────────────────────────────────────────────
// applyAnalysis (reescrito — htmlbox-spec-ai-apply-schema.md §4)
// ─────────────────────────────────────────────────────────────────────────────

async function applyAnalysis(request, env, analysisIdStr) {
  const { user, error } = await requireUser(request, env)
  if (error) return error

  const analysisRow = await env.DB.prepare(
    `SELECT id, box_id, proposal_json, candidates_json, applied
       FROM htmlbox_ai_analyses WHERE id = ?1`,
  ).bind(analysisIdStr).first()
  if (!analysisRow) return json({ error: 'not_found' }, 404)
  if (analysisRow.applied) return json({ error: 'already_applied' }, 409)

  const box = await resolveBox(env, user, analysisRow.box_id)
  if (!box) return json({ error: 'not_found' }, 404)
  try {
    requireRole(box, 'owner', 'editor')
  } catch (err) {
    return json({ error: 'forbidden', detail: err?.message }, 403)
  }

  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const currentHtml = typeof body?.html === 'string' ? body.html : ''
  if (!currentHtml) return json({ error: 'missing_current_html' }, 400)

  const proposal = JSON.parse(analysisRow.proposal_json)
  const tables = (proposal.tables || []).filter((t) => t.source_var)
  if (tables.length === 0) {
    return json({
      error: 'nothing_to_apply',
      detail: 'ninguna tabla propuesta tiene source_var',
    }, 400)
  }

  // Re-correr el extractor SOBRE EL HTML ACTUAL — no confiar en lo que había
  // cuando se hizo el análisis, puede haber cambiado. Si el candidato no está
  // más en el HTML actual, esa tabla queda en skipped.
  const freshCandidates = extractArrayCandidates(currentHtml)
  const byVarName = new Map(freshCandidates.map((c) => [c.varName, c]))

  const boxRow = await env.DB.prepare(
    `SELECT b.turso_db_url, b.turso_db_token, t.slug AS tenant_slug
       FROM htmlbox_boxes b JOIN htmlbox_tenants t ON t.id = b.tenant_id
      WHERE b.id = ?1`
  ).bind(box.id).first()
  if (!boxRow?.turso_db_url) return json({ error: 'box_db_not_ready' }, 409)
  const client = await connectToBox(env, boxRow.turso_db_url, boxRow.turso_db_token)

  // Pre-clasificar: aplicables vs skipped (candidato desapareció).
  const skipped = []
  const toApply = []
  for (const table of tables) {
    const candidate = byVarName.get(table.source_var)
    if (!candidate) {
      skipped.push({ slug: table.slug, source_var: table.source_var, reason: 'candidate_no_longer_present' })
    } else {
      toApply.push({ table, candidate })
    }
  }

  if (toApply.length === 0) {
    return json({ error: 'nothing_applied', skipped }, 409)
  }

  // Ordenar por posición DESCENDENTE antes de hacer los splice — reemplazar
  // de atrás para adelante evita que los offsets de los reemplazos previos
  // invaliden los índices de los siguientes.
  toApply.sort((a, b) => b.candidate.declStart - a.candidate.declStart)

  const applied = []
  let html = currentHtml

  for (const { table, candidate } of toApply) {
    // 1) Crear la tabla física + índice (mismo SQL que usan las tablas del box)
    await client.execute(physicalTableSqlFor(table.slug))
    // 2) Meta en htmlbox_tables — igual formato que ensureTable() de dataApi.js
    await client.execute({
      sql: `INSERT INTO htmlbox_tables (slug, name, columns_json, mode) VALUES (?1, ?2, ?3, 'manual')
            ON CONFLICT(slug) DO UPDATE SET columns_json = excluded.columns_json, updated_at = datetime('now')`,
      args: [table.slug, table.name, JSON.stringify(table.columns || [])],
    })
    // 3) TODAS las filas reales del candidato (no las 2-3 sample_rows de la IA).
    for (const row of candidate.rows) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
      await client.execute({
        sql: `INSERT INTO htmlbox_${table.slug} (data_json) VALUES (?1)`,
        args: [JSON.stringify(row)],
      })
    }
    // 4) Reemplazar la declaración en el HTML por la llamada a la Data API.
    const replacement = `const ${candidate.varName} = await HTMLBox.table('${table.slug}').rows({ limit: 1000 })`
    html = html.slice(0, candidate.declStart) + replacement + html.slice(candidate.declEnd)
    applied.push({ slug: table.slug, source_var: candidate.varName, rowsInserted: candidate.rows.length })
  }

  // Convertir <script> → <script type="module"> — necesario para que el
  // await de arriba funcione. Solo si no lo era ya. Se hace DESPUÉS de los
  // reemplazos para no invalidar offsets (el <script> está antes de los
  // declStart, así que cambiar sus atributos no mueve nada).
  // Re-extraemos del html YA modificado para tener índices correctos.
  const script = findSingleInlineScript(html)
  if (script && !/\btype\s*=\s*["']module["']/i.test(script.attrs)) {
    const openTagEnd = script.start + '<script'.length + script.attrs.length
    // Reemplazar solo el final del tag de apertura: insertar type="module" antes del >.
    html = html.slice(0, openTagEnd) + ' type="module"' + html.slice(openTagEnd)
  }

  // Guardar como nueva versión (mismo patrón que postPushHtml pero
  // escribiendo directo a R2 — quien escribe es el Worker, no el browser).
  const versionRow = await env.DB.prepare(
    `SELECT htmlbox_version FROM htmlbox_boxes WHERE id = ?1`
  ).bind(box.id).first()
  const nextVersion = (versionRow?.htmlbox_version ?? 0) + 1
  const r2Key = boxVersionKey(boxRow.tenant_slug, box.id, nextVersion)
  await env.BUCKET.put(r2Key, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } })

  await recordVersion({
    db: env.DB, boxId: box.id, version: nextVersion,
    source: 'agent', agentName: 'ai-schema-apply',
    summary: `Aplicado análisis IA: ${applied.map((a) => a.slug).join(', ')}`,
    userId: user.id,
  })
  await env.DB.prepare(
    `UPDATE htmlbox_boxes SET htmlbox_version = ?1, updated_at = datetime('now') WHERE id = ?2`
  ).bind(nextVersion, box.id).run()
  await purgeIfOverLimit({
    db: env.DB, bucket: env.BUCKET,
    tenantSlug: boxRow.tenant_slug, boxId: box.id,
  })

  await env.DB.prepare(
    `UPDATE htmlbox_ai_analyses SET applied = 1 WHERE id = ?1`
  ).bind(analysisIdStr).run()

  return json({
    ok: true,
    id: analysisIdStr,
    applied: 1,
    tables: applied,
    skipped,
    newVersion: nextVersion,
  })
}

// Export for tests
export { resetRateLimits }

// Export for tests of the dataExtractor helpers
export { extractArrayCandidates, findSingleInlineScript }