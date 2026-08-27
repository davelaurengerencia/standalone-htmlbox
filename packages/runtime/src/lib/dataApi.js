// src/lib/dataApi.js — endpoints /api/data/{boxId}/... del runtime.
//
// Endpoints:
//   GET    /api/data/{boxId}/tables                       → lista tablas
//   GET    /api/data/{boxId}/tables/{slug}/rows          → lee filas
//   GET    /api/data/{boxId}/tables/{slug}/columns       → esquema
//   POST   /api/data/{boxId}/tables/{slug}/upsert        → escribe filas (auth editor+)
//   POST   /api/data/{boxId}/tables/{slug}/upload        → recibe CSV/JSON, ejecuta strategy
//
// Auth:
//   - Público (visibility=public): GET funciona con sesión válida del tenant.
//     POST requiere editor+.
//   - Privado (visibility=private): GET requiere viewer+, POST requiere editor+.
//   - TODO(fase 3+): token read-only embebido al servir HTML para públicos sin sesión.

import { resolveBoxDb, getBoxClient } from './boxDb.js'
import { parseCsv } from './csv.js'

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  })
}

// Lee la sesión desde cookie de control-plane. Devuelve { userId, tenantId, isPlatformOwner, role } o null.
async function readSession(env, request) {
  const origin = env.HTMLBOX_CONTROL_PLANE_ORIGIN
  if (!origin) return null
  const headers = new Headers()
  const cookie = request.headers.get('Cookie')
  if (cookie) headers.set('Cookie', cookie)
  const res = await fetch(`${origin}/api/internal/whoami`, { headers })
  if (!res.ok) return null
  return await res.json()
}

// Devuelve { ok, role: 'owner'|'editor'|'viewer'|null, error? }.
async function checkMembership(env, request, boxInfo) {
  const sess = await readSession(env, request)
  if (!sess) return { ok: false, error: 'unauthenticated' }
  if (sess.isPlatformOwner) return { ok: true, role: 'owner', userId: sess.userId }

  const origin = env.HTMLBOX_CONTROL_PLANE_ORIGIN
  const headers = new Headers()
  const cookie = request.headers.get('Cookie')
  if (cookie) headers.set('Cookie', cookie)
  const res = await fetch(`${origin}/api/internal/boxes/${encodeURIComponent(boxInfo.boxId)}/membership`, { headers })
  if (!res.ok) return { ok: false, error: 'forbidden' }
  const data = await res.json()
  if (!data.membership) return { ok: false, error: 'forbidden' }
  return { ok: true, role: data.membership.role, userId: sess.userId }
}

// Auth + resolve combinado: chequea sesión PRIMERO (fail-fast 401 sin
// llamadas innecesarias), luego resuelve credenciales del box, luego membresía.
// Devuelve { info, auth } o { error, status }.
async function requireBox(env, boxId, request) {
  const sess = await readSession(env, request)
  if (!sess) return { error: 'unauthenticated', status: 401 }

  const origin = env.HTMLBOX_CONTROL_PLANE_ORIGIN
  const headers = new Headers()
  const cookie = request.headers.get('Cookie')
  if (cookie) headers.set('Cookie', cookie)

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

// Router principal. Devuelve Response o null si la URL no matchea.
export async function handleDataApi(request, env, url) {
  const m = url.pathname.match(/^\/api\/data\/([a-z0-9]{16})\/tables(?:\/([a-z][a-z0-9_]{0,40}))?(?:\/(rows|columns|upsert|upload))?$/)
  if (!m) return null

  const [, boxId, slug, op] = m
  const method = request.method

  // Sin slug ni op → listar tablas
  if (!slug && !op) {
    if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405)
    return await listTables(request, env, boxId)
  }
  if (!slug || !op) return json({ error: 'invalid_path' }, 400)

  if (op === 'rows' && method === 'GET')    return await getRows(request, env, boxId, slug, url)
  if (op === 'columns' && method === 'GET') return await getColumns(request, env, boxId, slug)
  if (op === 'upsert' && method === 'POST') return await postUpsert(request, env, boxId, slug)
  if (op === 'upload' && method === 'POST') return await postUpload(request, env, boxId, slug)

  return json({ error: 'method_not_allowed' }, 405)
}

async function listTables(request, env, boxId) {
  const box = await requireBox(env, boxId, request)
  if (box.error) return json({ error: box.error }, box.status)
  const client = await getBoxClient(env, box.info)
  const result = await client.execute(
    'SELECT slug, name, mode, flow_id, columns_json, created_at, updated_at FROM htmlbox_tables ORDER BY created_at ASC',
  )
  return json({ tables: result.rows.map(r => ({
    slug: r.slug,
    name: r.name,
    mode: r.mode,
    flow_id: r.flow_id,
    columns: safeJson(r.columns_json, []),
    created_at: r.created_at,
    updated_at: r.updated_at,
  })) })
}

async function getRows(request, env, boxId, slug, url) {
  const box = await requireBox(env, boxId, request)
  if (box.error) return json({ error: box.error }, box.status)

  const limit  = Number(url.searchParams.get('limit'))  || 100
  const offset = Number(url.searchParams.get('offset')) || 0
  const whereRaw = url.searchParams.get('where')
  let where = null
  if (whereRaw) {
    try { where = JSON.parse(whereRaw) } catch { return json({ error: 'invalid_where_json' }, 400) }
    if (typeof where !== 'object' || Array.isArray(where) || where === null) {
      return json({ error: 'where_must_be_object' }, 400)
    }
  }

  const client = await getBoxClient(env, box.info)
  const tableName = `htmlbox_${slug}`
  const { sql, args } = buildSelectSql(tableName, limit, offset, where)
  const result = await client.execute({ sql, args })
  const rows = result.rows.map((r) => {
    let data = {}
    try { data = JSON.parse(r.data_json || '{}') } catch { /* keep */ }
    return { id: r.id, ...data, created_at: r.created_at, updated_at: r.updated_at }
  })
  return json({ rows, count: rows.length, limit, offset })
}

async function getColumns(request, env, boxId, slug) {
  const box = await requireBox(env, boxId, request)
  if (box.error) return json({ error: box.error }, box.status)

  const client = await getBoxClient(env, box.info)
  const meta = await client.execute({
    sql: 'SELECT slug, name, columns_json, mode FROM htmlbox_tables WHERE slug = ?',
    args: [slug],
  })
  if (meta.rows.length === 0) return json({ error: 'table_not_found' }, 404)
  const r = meta.rows[0]
  return json({
    slug: r.slug,
    name: r.name,
    mode: r.mode,
    columns: safeJson(r.columns_json, []),
  })
}

async function postUpsert(request, env, boxId, slug) {
  const box = await requireBox(env, boxId, request)
  if (box.error) return json({ error: box.error }, box.status)
  if (!['owner', 'editor'].includes(box.auth.role)) return json({ error: 'forbidden_role' }, 403)

  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const rows = Array.isArray(body?.rows) ? body.rows : null
  if (!rows) return json({ error: 'missing_rows' }, 400)
  if (rows.length === 0) return json({ ok: true, inserted: 0 })

  const client = await getBoxClient(env, box.info)
  await ensureTable(client, slug, inferColumns(rows))
  const tableName = `htmlbox_${slug}`
  let inserted = 0
  for (const r of rows) {
    if (typeof r !== 'object' || r === null) continue
    const { id: _ignored, created_at: _c, updated_at: _u, ...rest } = r
    await client.execute({
      sql: `INSERT INTO ${tableName} (data_json) VALUES (?)`,
      args: [JSON.stringify(rest)],
    })
    inserted++
  }
  return json({ ok: true, inserted })
}

async function postUpload(request, env, boxId, slug) {
  const box = await requireBox(env, boxId, request)
  if (box.error) return json({ error: box.error }, box.status)
  if (!['owner', 'editor'].includes(box.auth.role)) return json({ error: 'forbidden_role' }, 403)

  const url = new URL(request.url)
  const strategy = url.searchParams.get('strategy') || 'replace'
  if (!['replace', 'upsert'].includes(strategy)) return json({ error: 'invalid_strategy' }, 400)
  const contentType = request.headers.get('Content-Type') || ''

  let parsedRows = null
  let filename = 'upload.csv'
  if (contentType.includes('application/json')) {
    let body
    try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
    if (!Array.isArray(body?.rows)) return json({ error: 'missing_rows' }, 400)
    parsedRows = body.rows
    if (typeof body.filename === 'string') filename = body.filename
  } else {
    // text/csv, text/plain, application/octet-stream
    const text = await request.text()
    const parsed = parseCsv(text)
    if (parsed.error) return json({ error: parsed.error }, 400)
    parsedRows = parsed.rows
    if (parsedRows.length === 0) return json({ error: 'empty_csv' }, 400)
  }

  const client = await getBoxClient(env, box.info)
  await ensureTable(client, slug, inferColumns(parsedRows))

  // replace: borramos todo lo viejo (soft delete) e insertamos lo nuevo
  // upsert: insertamos filas nuevas con un id derivado del key (data_json)
  const tableName = `htmlbox_${slug}`
  let inserted = 0
  if (strategy === 'replace') {
    await client.execute(
      `UPDATE ${tableName} SET deleted_at = datetime('now') WHERE deleted_at IS NULL`,
    )
  }
  for (const r of parsedRows) {
    await client.execute({
      sql: `INSERT INTO ${tableName} (data_json) VALUES (?)`,
      args: [JSON.stringify(r)],
    })
    inserted++
  }

  // Log en htmlbox_files (best-effort)
  try {
    const fileId = cryptoRandom()
    await client.execute({
      sql: 'INSERT INTO htmlbox_files (id, table_slug, filename, kind, rows, strategy, r2_key, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      args: [fileId, slug, filename, 'csv', inserted, strategy, `pending://upload/${fileId}`, box.auth.userId || 'unknown'],
    })
  } catch (err) {
    console.error('[dataApi] htmlbox_files insert failed:', err)
  }

  return json({ ok: true, inserted, strategy, filename })
}

// ---- helpers --------------------------------------------------------------

function safeJson(text, fallback) {
  try { return JSON.parse(text || '[]') } catch { return fallback }
}

function inferColumns(rows) {
  // Toma la unión de claves del primer row + un par más.
  const cols = new Set()
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    if (rows[i] && typeof rows[i] === 'object') {
      for (const k of Object.keys(rows[i])) cols.add(k)
    }
  }
  return Array.from(cols)
}

async function ensureTable(client, slug, columns) {
  // 1) crear tabla física si no existe
  const create = `
    CREATE TABLE IF NOT EXISTS htmlbox_${slug} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_htmlbox_${slug}_deleted ON htmlbox_${slug}(deleted_at);
  `
  for (const stmt of create.split(/;\s*$/m).map(s => s.trim()).filter(Boolean)) {
    await client.execute(stmt)
  }
  // 2) upsert metadata
  const cols = (columns || []).map((c) => ({
    name: c, type: typeof ({}),
  }))
  // Si la fila ya existe, name puede estar vacío; lo conservamos.
  const exists = await client.execute({
    sql: 'SELECT name FROM htmlbox_tables WHERE slug = ?',
    args: [slug],
  })
  const existingName = exists.rows?.[0]?.name
  const finalName = existingName || slug
  await client.execute({
    sql: `INSERT INTO htmlbox_tables (slug, name, columns_json, mode)
          VALUES (?, ?, ?, 'manual')
          ON CONFLICT(slug) DO UPDATE SET
            columns_json = excluded.columns_json,
            updated_at = datetime('now')`,
    args: [slug, finalName, JSON.stringify(cols)],
  })
}

function buildSelectSql(tableName, limit, offset, where) {
  const safeLimit = Math.max(1, Math.min(1000, limit))
  const safeOffset = Math.max(0, Math.min(100000, offset))
  let sql = `SELECT id, data_json, created_at, updated_at FROM ${tableName} WHERE deleted_at IS NULL`
  const args = []
  if (where && typeof where === 'object') {
    const entries = Object.entries(where).slice(0, 5)
    if (entries.length > 0) {
      const conds = entries.map(() => `(data_json LIKE ?)`).join(' AND ')
      sql += ` AND ${conds}`
      for (const [, v] of entries) {
        args.push(`%"${String(v).replace(/[%_\\]/g, (c) => `\\${c}`)}"%`)
      }
    }
  }
  sql += ` ORDER BY id ASC LIMIT ${safeLimit} OFFSET ${safeOffset}`
  return { sql, args }
}

function cryptoRandom() {
  // Worker / Node 19+ tienen crypto.randomUUID.
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return 'id-' + Math.random().toString(36).slice(2, 14)
}