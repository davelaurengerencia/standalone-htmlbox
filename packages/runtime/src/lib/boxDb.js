// src/lib/boxDb.js — resuelve boxId → credenciales Turso y devuelve cliente.
//
// Usado por dataApi.js. Cache KV opcional con TTL corto.
// NO usar para servir HTML (eso va por htmlServer.js, que NO toca la DB).

import { connect } from '@tursodatabase/serverless'

const KV_TTL_SEC = 60

function k(boxId) {
  return `boxdb:${boxId}`
}

// Devuelve { url, token, visibility, tenantSlug, boxSlug } o null.
// Acepta `request` opcional para reenviar cookies (no usado en reads de tabla).
export async function resolveBoxDb(env, boxId, request) {
  if (!boxId || !/^[a-z0-9]{16}$/.test(boxId)) return null

  if (env.CACHE) {
    const cached = await env.CACHE.get(k(boxId))
    if (cached) {
      try { return JSON.parse(cached) } catch { /* ignore */ }
    }
  }

  const origin = env.HTMLBOX_CONTROL_PLANE_ORIGIN
  if (!origin) throw new Error('boxDb: HTMLBOX_CONTROL_PLANE_ORIGIN no configurado')
  const headers = new Headers()
  const cookie = request?.headers?.get?.('Cookie')
  if (cookie) headers.set('Cookie', cookie)
  if (env.HTMLBOX_INTERNAL_SECRET) {
    headers.set('X-HTMLBox-Internal-Secret', env.HTMLBOX_INTERNAL_SECRET)
  }

  const res = await fetch(`${origin}/api/internal/boxes/${encodeURIComponent(boxId)}/db`, { headers })
  if (!res.ok) return null
  const data = await res.json()
  if (!data.box || !data.box.turso_db_url || !data.box.turso_db_token) return null

  const out = {
    boxId: data.box.id,
    tenantSlug: data.box.tenant_slug,
    boxSlug: data.box.slug,
    visibility: data.box.visibility,
    url: data.box.turso_db_url,
    token: data.box.turso_db_token,
  }
  if (env.CACHE) {
    await env.CACHE.put(k(boxId), JSON.stringify(out), { expirationTtl: KV_TTL_SEC })
  }
  return out
}

// Devuelve cliente libsql conectado. El runtime NO cachea el cliente (cada
// request crea uno — cheap en HTTP).
export async function getBoxClient(env, boxInfo) {
  const client = connect({ url: boxInfo.url, authToken: boxInfo.token })

  // El paquete @tursodatabase/serverless v0.1.3 (instalado en runtime) tiene
  // una API distinta de la versión de control-plane (v1.x):
  //   v0.1.3: client.exec(sql) → no retorna rows; client.prepare(sql).all(args) → filas
  //   v0.1.3: client.prepare(sql).run(args) → INSERT/UPDATE/DELETE (sin rows)
  //   v1.x:   client.execute(sql, args) → filas (autodetecta)
  //
  // Adaptamos para que dataApi.js (que usa execute({ sql, args })) funcione
  // con la v0.1.3.
  client.execute = async (stmt, args2) => {
    // Acepta (sql, args) o ({ sql, args })
    let sqlText, bindArgs
    if (typeof stmt === 'string') {
      sqlText = stmt
      bindArgs = args2
    } else if (stmt && typeof stmt === 'object') {
      sqlText = stmt.sql ?? ''
      bindArgs = stmt.args
    } else {
      throw new Error('client.execute: primer arg must be string u objeto con sql')
    }
    bindArgs = bindArgs || []
    const stmtObj = client.prepare(sqlText)
    const isSelect = /^\s*(SELECT|PRAGMA)\b/i.test(sqlText)
    if (isSelect) {
      const rows = await stmtObj.all(bindArgs)
      return { rows, columns: [], rowsAffected: rows.length }
    } else {
      const result = await stmtObj.run(bindArgs)
      return { rows: [], columns: [], rowsAffected: result.changes || 0, lastInsertRowid: result.lastInsertRowid }
    }
  }
  return client
}

// Invalida cache del box (llamar al cambiar turso_db_token, etc.).
export async function invalidate(env, boxId) {
  if (env.CACHE) await env.CACHE.delete(k(boxId))
}

// Helper: ejecuta SELECT y devuelve array de objetos (parseando data_json).
export async function selectRows(client, tableName, opts = {}) {
  const { limit = 100, offset = 0, where = null } = opts
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100))
  const safeOffset = Math.max(0, Math.min(100000, Number(offset) || 0))

  let sql = `SELECT id, data_json, created_at, updated_at
               FROM ${tableName}
              WHERE deleted_at IS NULL`
  if (where) {
    // where es un objeto { campo: valor } — usamos data_json LIKE (simple).
    // Para v1: si where tiene 1 entrada, filtramos por data_json LIKE.
    // Production-grade: parsear SQL seguro. v1: mantener simple.
    const entries = Object.entries(where).slice(0, 5)
    if (entries.length > 0) {
      const conds = entries.map(([k]) =>
        `(data_json LIKE ? ESCAPE '\\')`,
      ).join(' AND ')
      sql += ` AND ${conds}`
      const binds = entries.map(([, v]) => {
        const s = String(v).replace(/[\\%_]/g, (c) => `\\${c}`)
        return `%"${s}"%`
      })
      sql += ` ORDER BY id ASC LIMIT ${safeLimit} OFFSET ${safeOffset}`
      const result = await client.execute({ sql, args: binds })
      return result.rows.map(rowToObject)
    }
  }
  sql += ` ORDER BY id ASC LIMIT ${safeLimit} OFFSET ${safeOffset}`
  const result = await client.execute(sql)
  return result.rows.map(rowToObject)
}

function rowToObject(r) {
  let data = {}
  try { data = JSON.parse(r.data_json || '{}') } catch { /* keep {} */ }
  return {
    id: r.id,
    ...data,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}