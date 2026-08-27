// src/lib/appDataApi.js — endpoints /api/app-data/{boxId}/tables/{slug}/...
// del runtime. **Diferencia clave con dataApi.js**: la sesión es de app-user
// (cookie hbx_app_sid → app_users), no de plataforma. Toda lectura/escritura
// sobre una tabla `scope='private'` se filtra o estampa automáticamente con
// el id del app_user autenticado — nunca con un valor que venga del caller.
//
// Endpoints:
//   GET  /api/app-data/{boxId}/tables/{slug}/rows     → lee filas
//                                                       (propias si scope='private', todas si 'shared')
//   POST /api/app-data/{boxId}/tables/{slug}/upsert   → escribe filas
//                                                       (siempre estampadas con el id del app_user,
//                                                        si scope='private')
//
// v1: NO bulk-create, NO upload, NO columns. Crear tablas y definir columnas
// sigue siendo trabajo del tenant vía dataApi.js / portal. Un app_user
// (customer) solo lee/escribe filas en tablas que el tenant ya definió.
//
// v1: tablas con scope='shared' son SOLO LECTURA para app_users — escribir
// ahí sigue siendo trabajo del tenant (dataApi.js). Habilitar escritura de
// customers sobre datos compartidos implica resolver conflictos entre ellos
// editando lo mismo (problema aparte, no bloqueante — ver spec §4).

import { resolveBoxDb, getBoxClient } from './boxDb.js'
import { getAppSessionIdFromRequest, validateAppSession } from './appAuth.js'
import { getTenantAppSessionIdFromRequest } from './tenantAppAuth.js'
import { ensureColumn, ensureTableScopeColumn, ensureOwnerColumn } from '@htmlbox/shared'

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  })
}

// Resuelve al app-user autenticado. Primero intenta la sesión box-local
// (fase 1/2, hbx_app_sid); si falla, intenta el fallback de tenant-app-user
// (fase 3, hbx_tapp_sid) — alguien que el tenant dio de alta UNA vez y le
// otorgó acceso al box o a su workspace o al tenant entero.
async function requireAppUser(env, boxId, request) {
  const info = await resolveBoxDb(env, boxId, request)
  if (!info) return { error: 'box_not_found', status: 404 }
  const client = await getBoxClient(env, info)

  // 1) Sesión box-local (customer "real")
  const sid = getAppSessionIdFromRequest(request)
  const sess = await validateAppSession(client, sid)
  if (sess) {
    return { client, appUser: sess.appUser, info, isTenantWide: false }
  }

  // 2) Fallback: tenant-app-user (fase 3). Reusa el client (misma DB, misma
  // tabla física) — solo cambia la autorización.
  const tsid = getTenantAppSessionIdFromRequest(request)
  if (tsid) {
    const res = await fetch(`${env.HTMLBOX_CONTROL_PLANE_ORIGIN}/api/internal/tenant-app-auth/access`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `hbx_tapp_sid=${tsid}`,
        ...(env.HTMLBOX_INTERNAL_SECRET ? { 'X-HTMLBox-Internal-Secret': env.HTMLBOX_INTERNAL_SECRET } : {}),
      },
      body: JSON.stringify({ boxId }),
    })
    const data = await res.json().catch(() => ({ allowed: false }))
    if (data.allowed) {
      return {
        client,
        appUser: { id: data.tenantAppUser.id, email: data.tenantAppUser.email, display_name: data.tenantAppUser.display_name },
        info,
        isTenantWide: true,
      }
    }
  }

  return { error: 'unauthenticated', status: 401 }
}

async function getTableScope(client, slug) {
  // Asegurar que htmlbox_tables.scope exista — puede faltar si el box fue
  // provisionado antes de esta fase.
  await ensureTableScopeColumn(client)
  const result = await client.execute({
    sql: `SELECT scope FROM htmlbox_tables WHERE slug = ?1`,
    args: [slug],
  })
  return result.rows[0]?.scope || null // null = la tabla no existe
}

async function getRows(request, env, boxId, slug, url) {
  const auth = await requireAppUser(env, boxId, request)
  if (auth.error) return json({ error: auth.error }, auth.status)

  const scope = await getTableScope(auth.client, slug)
  if (!scope) return json({ error: 'table_not_found' }, 404)
  await ensureOwnerColumn(auth.client, slug)

  const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit')) || 100))
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)

  let sql = `SELECT id, data_json, owner_user_id, created_at, updated_at
               FROM htmlbox_${slug}
              WHERE deleted_at IS NULL`
  const args = []
  // scope === 'private' + box-local user → filtra por owner_user_id
  // scope === 'private' + tenant-wide user (fase 3) → ve TODO sin filtro
  // scope === 'shared' → sin filtro, todos ven lo mismo
  if (scope === 'private' && !auth.isTenantWide) {
    sql += ` AND owner_user_id = ?1`
    args.push(auth.appUser.id)
  }
  sql += ` ORDER BY id ASC LIMIT ${limit} OFFSET ${offset}`

  const result = await auth.client.execute({ sql, args })
  const rows = result.rows.map((r) => {
    let data = {}
    try { data = JSON.parse(r.data_json || '{}') } catch { /* keep {} */ }
    return {
      id: r.id,
      owner_user_id: r.owner_user_id,
      ...data,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }
  })
  return json({ rows, count: rows.length, limit, offset, scope })
}

async function postUpsert(request, env, boxId, slug) {
  const auth = await requireAppUser(env, boxId, request)
  if (auth.error) return json({ error: auth.error }, auth.status)

  // v1: tenant-wide users son SOLO LECTURA — escribir "a nombre de" un
  // tenant-app-user no tiene owner_user_id natural, depende de cómo se
  // diseñe el sistema de roles (§4 del spec). Devolvemos 403 explícito.
  if (auth.isTenantWide) {
    return json({ error: 'tenant_wide_users_are_read_only_in_v1' }, 403)
  }

  const scope = await getTableScope(auth.client, slug)
  if (!scope) return json({ error: 'table_not_found' }, 404)
  if (scope === 'shared') {
    // v1: tablas compartidas son solo-lectura para app_users.
    return json({ error: 'shared_table_read_only_for_app_users' }, 403)
  }

  await ensureOwnerColumn(auth.client, slug)

  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_body' }, 400) }
  const rows = Array.isArray(body?.rows) ? body.rows : null
  if (!rows || rows.length === 0) return json({ error: 'missing_rows' }, 400)

  let inserted = 0
  for (const r of rows) {
    if (typeof r !== 'object' || r === null) continue
    // owner_user_id NUNCA sale del body — siempre auth.appUser.id (sesión
    // validada server-side). Si el row trae "owner_user_id"/"user_id", se
    // ignora — no hay forma de que un customer escriba a nombre de otro.
    const {
      id: _i, created_at: _c, updated_at: _u,
      owner_user_id: _o, user_id: _uid,
      ...rest
    } = r
    await auth.client.execute({
      sql: `INSERT INTO htmlbox_${slug} (data_json, owner_user_id) VALUES (?1, ?2)`,
      args: [JSON.stringify(rest), auth.appUser.id],
    })
    inserted++
  }
  return json({ ok: true, inserted, scope })
}

// Router principal. Devuelve Response o null si la URL no matchea.
export async function handleAppDataApi(request, env, url) {
  const m = url.pathname.match(
    /^\/api\/app-data\/([a-z0-9]{16})\/tables\/([a-z][a-z0-9_]{0,40})\/(rows|upsert)$/,
  )
  if (!m) return null
  const [, boxId, slug, op] = m

  if (op === 'rows' && request.method === 'GET')    return await getRows(request, env, boxId, slug, url)
  if (op === 'upsert' && request.method === 'POST') return await postUpsert(request, env, boxId, slug)

  return json({ error: 'method_not_allowed' }, 405)
}