// src/lib/dataApi.js — endpoints /api/data/{boxId}/... del runtime.
//
// Endpoints:
//   GET    /api/data/{boxId}/tables                       → lista tablas
//   GET    /api/data/{boxId}/tables/{slug}/rows          → lee filas
//   GET    /api/data/{boxId}/tables/{slug}/columns       → esquema
//   POST   /api/data/{boxId}/tables/{slug}/upsert        → escribe filas (auth editor+)
//   POST   /api/data/{boxId}/tables/{slug}/upload        → recibe CSV/JSON, ejecuta strategy
//   POST   /api/data/{boxId}/tables/bulk-create          → crea N tablas con sample_rows (auth editor+)
//
// Auth:
//   - Público (visibility=public): GET funciona con sesión válida del tenant.
//     POST requiere editor+.
//   - Privado (visibility=private): GET requiere viewer+, POST requiere editor+.
//   - TODO(fase 3+): token read-only embebido al servir HTML para públicos sin sesión.

import { resolveBoxDb, getBoxClient } from './boxDb.js'
import { parseCsv } from './csv.js'
import { controlPlaneHeaders, readSession, checkMembership } from './auth.js'

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  })
}

// controlPlaneHeaders, readSession, checkMembership ahora viven en ./auth.js
// (extraído para reuso con debugPanel.js — ver htmlbox-spec-debug-panel.md).

// Auth + resolve combinado: chequea sesión PRIMERO (fail-fast 401 sin
// llamadas innecesarias), luego resuelve credenciales del box, luego membresía.
// Devuelve { info, auth } o { error, status }.
async function requireBox(env, boxId, request) {
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

// POST /api/data/{boxId}/tables/{slug}/scope  body: { scope: 'private'|'shared' }
// Cambia el scope de una tabla existente. PELIGRO: cambiar el scope de una
// tabla con filas existentes puede dejar filas inaccesibles (las 'shared'
// no tienen owner, las 'private' filtran por owner). Spec §4: "operación
// manual por ahora".
async function postScope(request, env, boxId, slug) {
  const box = await requireBox(env, boxId, request)
  if (box.error) return json({ error: box.error }, box.status)
  if (!['owner', 'editor'].includes(box.auth.role)) return json({ error: 'forbidden_role' }, 403)

  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const scope = body?.scope
  if (scope !== 'private' && scope !== 'shared') return json({ error: 'invalid_scope' }, 400)

  const client = await getBoxClient(env, box.info)
  const { ensureTableScopeColumn } = await import('@htmlbox/shared')
  await ensureTableScopeColumn(client)
  const exists = await client.execute({
    sql: 'SELECT slug FROM htmlbox_tables WHERE slug = ?',
    args: [slug],
  })
  if (!exists.rows.length) return json({ error: 'table_not_found' }, 404)

  await client.execute({
    sql: `UPDATE htmlbox_tables SET scope = ?1, updated_at = datetime('now') WHERE slug = ?2`,
    args: [scope, slug],
  })
  return json({ ok: true, scope })
}

// POST /api/data/{boxId}/tables/{slug}  body: { name?, scope?, columns? }
// Crea SOLO la metadata de la tabla (sin filas). Útil para que el tenant
// pueda registrar una tabla con su scope antes de subirle datos — antes
// el único flujo era upload (que asumía tabla nueva implícita).
async function postCreateMeta(request, env, boxId, slug) {
  const box = await requireBox(env, boxId, request)
  if (box.error) return json({ error: box.error }, box.status)
  if (!['owner', 'editor'].includes(box.auth.role)) return json({ error: 'forbidden_role' }, 403)

  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(slug)) return json({ error: 'invalid_slug' }, 400)

  const scope = body?.scope === 'shared' ? 'shared' : 'private'
  const columns = Array.isArray(body?.columns) ? body.columns.map(c => c.name || c) : []
  const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : slug

  const client = await getBoxClient(env, box.info)
  await ensureTable(client, slug, columns, { scope })

  // Si pasan un display name distinto al slug, actualizar.
  if (name !== slug) {
    await client.execute({
      sql: `UPDATE htmlbox_tables SET name = ?1, updated_at = datetime('now') WHERE slug = ?2`,
      args: [name, slug],
    })
  }
  return json({ ok: true, slug, name, scope })
}

// Router principal. Devuelve Response o null si la URL no matchea.
export async function handleDataApi(request, env, url) {
  // bulk-create: ruta plana (sin slug) — la validamos antes del router general.
  const bulkM = url.pathname.match(/^\/api\/data\/([a-z0-9]{16})\/tables\/bulk-create$/)
  if (bulkM) {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
    return await postBulkCreate(request, env, bulkM[1])
  }

  const m = url.pathname.match(/^\/api\/data\/([a-z0-9]{16})\/tables(?:\/([a-z][a-z0-9_]{0,40}))?(?:\/(rows|columns|upsert|upload|scope))?$/)
  if (!m) return null

  const [, boxId, slug, op] = m
  const method = request.method

  // Sin slug ni op → listar tablas
  if (!slug && !op) {
    if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405)
    return await listTables(request, env, boxId)
  }

  // /tables/{slug}  POST → crear metadata (con scope)
  if (slug && !op) {
    if (method === 'POST') return await postCreateMeta(request, env, boxId, slug)
    return json({ error: 'method_not_allowed' }, 405)
  }

  if (!slug || !op) return json({ error: 'invalid_path' }, 400)

  if (op === 'rows' && method === 'GET')    return await getRows(request, env, boxId, slug, url)
  if (op === 'columns' && method === 'GET') return await getColumns(request, env, boxId, slug)
  if (op === 'upsert' && method === 'POST') return await postUpsert(request, env, boxId, slug)
  if (op === 'upload' && method === 'POST') return await postUpload(request, env, boxId, slug)
  if (op === 'scope'  && method === 'POST') return await postScope(request, env, boxId, slug)

  return json({ error: 'method_not_allowed' }, 405)
}

async function listTables(request, env, boxId) {
  const box = await requireBox(env, boxId, request)
  if (box.error) return json({ error: box.error }, box.status)
  const client = await getBoxClient(env, box.info)
  // scope puede faltar en tablas viejas — usamos COALESCE para default 'private'.
  const result = await client.execute(
    `SELECT slug, name, mode, flow_id, columns_json,
            COALESCE(scope, 'private') AS scope,
            created_at, updated_at
       FROM htmlbox_tables
      ORDER BY created_at ASC`,
  )
  return json({ tables: result.rows.map(r => ({
    slug: r.slug,
    name: r.name,
    mode: r.mode,
    flow_id: r.flow_id,
    scope: r.scope || 'private',
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
  let bodyScope = null
  if (contentType.includes('application/json')) {
    let body
    try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
    if (!Array.isArray(body?.rows)) return json({ error: 'missing_rows' }, 400)
    parsedRows = body.rows
    if (typeof body.filename === 'string') filename = body.filename
    if (body.scope === 'shared' || body.scope === 'private') bodyScope = body.scope
  } else {
    // text/csv, text/plain, application/octet-stream
    const text = await request.text()
    const parsed = parseCsv(text)
    if (parsed.error) return json({ error: parsed.error }, 400)
    parsedRows = parsed.rows
    if (parsedRows.length === 0) return json({ error: 'empty_csv' }, 400)
  }

  const client = await getBoxClient(env, box.info)
  // scope: ?scope=private|shared en el query (csv) o body.scope (json)
  const queryScope = url.searchParams.get('scope')
  const scope = bodyScope || (queryScope === 'shared' ? 'shared' : 'private')
  await ensureTable(client, slug, inferColumns(parsedRows), { scope })

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

async function postBulkCreate(request, env, boxId) {
  const box = await requireBox(env, boxId, request)
  if (box.error) return json({ error: box.error }, box.status)
  if (!['owner', 'editor'].includes(box.auth.role)) return json({ error: 'forbidden_role' }, 403)

  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const tables = Array.isArray(body?.tables) ? body.tables : null
  if (!tables) return json({ error: 'missing_tables' }, 400)
  if (tables.length === 0) return json({ ok: true, created: [], errors: [] })
  if (tables.length > 20) return json({ error: 'too_many_tables' }, 400)

  for (const t of tables) {
    if (!t || typeof t.slug !== 'string' || !/^[a-z][a-z0-9_]{0,40}$/.test(t.slug)) {
      return json({ error: 'invalid_slug', slug: t?.slug }, 400)
    }
    if (!Array.isArray(t.columns) || t.columns.length > 50) {
      return json({ error: 'invalid_columns', slug: t.slug }, 400)
    }
    if (!Array.isArray(t.sample_rows) || t.sample_rows.length > 1000) {
      return json({ error: 'invalid_sample_rows', slug: t.slug }, 400)
    }
  }

  const client = await getBoxClient(env, box.info)
  const created = []
  const errors = []

  for (const t of tables) {
    try {
      const tScope = t.scope === 'shared' ? 'shared' : 'private'
      await ensureTable(client, t.slug, t.columns.map(c => c.name), { scope: tScope })

      const tableName = `htmlbox_${t.slug}`
      let inserted = 0
      for (const r of t.sample_rows) {
        if (typeof r !== 'object' || r === null) continue
        await client.execute({
          sql: `INSERT INTO ${tableName} (data_json) VALUES (?)`,
          args: [JSON.stringify(r)],
        })
        inserted++
      }

      try {
        const fileId = cryptoRandom()
        await client.execute({
          sql: 'INSERT INTO htmlbox_files (id, table_slug, filename, kind, rows, strategy, r2_key, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          args: [fileId, t.slug, 'bulk-create', 'json', inserted, 'replace', `bulk://${fileId}`, box.auth.userId || 'unknown'],
        })
      } catch (err) {
        console.error('[dataApi] htmlbox_files insert failed:', err)
      }

      created.push({ slug: t.slug, inserted, columns: t.columns.length })
    } catch (err) {
      errors.push({ slug: t.slug, error: err?.message || 'unknown' })
    }
  }

  return json({ ok: errors.length === 0, created, errors }, errors.length === 0 ? 200 : 207)
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

async function ensureTable(client, slug, columns, opts = {}) {
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
  // 2) asegurar columna scope (fase 2 — htmlbox-spec-app-customers.md §1)
  const { ensureTableScopeColumn } = await import('@htmlbox/shared')
  await ensureTableScopeColumn(client)

  // 3) upsert metadata
  const cols = (columns || []).map((c) => ({
    name: c, type: typeof ({}),
  }))
  // Si la fila ya existe, name puede estar vacío; lo conservamos.
  const exists = await client.execute({
    sql: 'SELECT name, scope FROM htmlbox_tables WHERE slug = ?',
    args: [slug],
  })
  const existingName = exists.rows?.[0]?.name
  const existingScope = exists.rows?.[0]?.scope
  const finalName = existingName || slug
  // Si ya existe la fila, respetamos su scope (no pisamos). Si es nueva,
  // usamos el del caller (default 'private').
  const scope = opts.scope || existingScope || 'private'
  await client.execute({
    sql: `INSERT INTO htmlbox_tables (slug, name, columns_json, mode, scope)
          VALUES (?, ?, ?, 'manual', ?)
          ON CONFLICT(slug) DO UPDATE SET
            columns_json = excluded.columns_json,
            updated_at = datetime('now')`,
    args: [slug, finalName, JSON.stringify(cols), scope],
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