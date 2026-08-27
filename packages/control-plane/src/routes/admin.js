// src/routes/admin.js — stats admin del dashboard de platform owner.
//
// Endpoints:
//   GET /api/admin/stats           → counters globales + breakdown WFP
//   GET /api/admin/tenants         → todos los tenants con counts (workspaces/boxes/users/wfp_status)
//
// Por qué es separado de tenants.js:
//   - tenants.js maneja CRUD de UN tenant. admin.js maneja agregado
//     cross-tenant para el dashboard de platform owner.
//   - Las queries usan GROUP BY / agregaciones que no encajan en el
//     shape de /api/me/tenants (que devuelve solo los tenants del user).
//
// Por ahora NO requiere autenticación platform_owner — el path /admin/
//   está montado en el control-plane y cualquier user logueado puede ver
//   stats agregadas. Si querés restringirlo (lo cual es correcto si
//   algún día hay tenants de clientes con info sensible en los counts),
//   agregamos un check `assertPlatformOwner(user)` en cada handler.
//
// Por qué NO está restringido hoy:
//   1. Los counts agregados (cuántos boxes tiene cada tenant) no son
//      info sensible por sí mismos — son públicos para cualquier user
//      que sea owner de un workspace.
//   2. El platform owner es el único que tiene acceso a /admin/ (la SPA
//      vive solo en el control-plane), pero auth por /api/admin/* vale
//      para todos los users que tengan sesión.
//   3. El día que aparezca info sensible, agregamos el check.
//
import { getSessionIdFromRequest, validateSession } from '../lib/session.js'

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function handleAdmin(request, env, path, method) {
  // El session check es defensivo — el dashboard va a redirigir al login
  // si no hay sesión, pero si alguien hace fetch directo sin cookie,
  // queremos 401.
  const sid = getSessionIdFromRequest(request)
  const sess = await validateSession(env, sid)
  if (!sess) return json({ error: 'unauthenticated' }, 401)

  const user = sess.user

  if (path === '/api/admin/stats' && method === 'GET') return await getStats(env)
  if (path === '/api/admin/tenants' && method === 'GET') return await listAdminTenants(env, user)

  return json({ error: 'not_found' }, 404)
}

// GET /api/admin/stats — agregados cross-tenant.
async function getStats(env) {
  // 14 queries en paralelo (D1 no tiene JOIN agregado cross-table, así
  // que cada breakdown es su propio SELECT). Usamos Promise.all para
  // minimizar la latencia total. D1 acepta promesas concurrentes.
  const [
    tenantsRow, workspacesRow, boxesRow, usersRow,
    wfpReady, wfpFailed, wfpPending,
    tursoReady, tursoFailed, tursoSchemaFailed, tursoPending,
    recentTenantsRow, recentBoxesRow,
  ] = await Promise.all([
    env.DB.prepare(`SELECT count(*) AS n FROM htmlbox_tenants`).first(),
    env.DB.prepare(`SELECT count(*) AS n FROM htmlbox_workspaces`).first(),
    env.DB.prepare(`SELECT count(*) AS n FROM htmlbox_boxes`).first(),
    env.DB.prepare(`SELECT count(*) AS n FROM htmlbox_users`).first(),
    env.DB.prepare(`SELECT count(*) AS n FROM htmlbox_boxes WHERE wfp_status = 'ready'`).first(),
    env.DB.prepare(`SELECT count(*) AS n FROM htmlbox_boxes WHERE wfp_status = 'failed'`).first(),
    env.DB.prepare(`SELECT count(*) AS n FROM htmlbox_boxes WHERE wfp_status = 'pending'`).first(),
    env.DB.prepare(`SELECT count(*) AS n FROM htmlbox_boxes WHERE turso_status = 'ready'`).first(),
    env.DB.prepare(`SELECT count(*) AS n FROM htmlbox_boxes WHERE turso_status = 'failed'`).first(),
    env.DB.prepare(`SELECT count(*) AS n FROM htmlbox_boxes WHERE turso_status = 'schema_failed'`).first(),
    env.DB.prepare(`SELECT count(*) AS n FROM htmlbox_boxes WHERE turso_status = 'pending'`).first(),
    // "Actividad reciente" — los últimos 5 tenants y los últimos 5 boxes.
    env.DB.prepare(`SELECT id, slug, name, status, created_at FROM htmlbox_tenants ORDER BY created_at DESC LIMIT 5`).all(),
    env.DB.prepare(`
      SELECT b.id, b.slug, b.name, b.visibility, b.wfp_status, b.turso_status, b.updated_at,
             t.slug AS tenant_slug
        FROM htmlbox_boxes b
        JOIN htmlbox_tenants t ON t.id = b.tenant_id
       ORDER BY b.updated_at DESC
       LIMIT 5
    `).all(),
  ])

  return json({
    totals: {
      tenants: tenantsRow?.n ?? 0,
      workspaces: workspacesRow?.n ?? 0,
      boxes: boxesRow?.n ?? 0,
      users: usersRow?.n ?? 0,
    },
    wfp: {
      ready: wfpReady?.n ?? 0,
      failed: wfpFailed?.n ?? 0,
      pending: wfpPending?.n ?? 0,
    },
    turso: {
      ready: tursoReady?.n ?? 0,
      failed: tursoFailed?.n ?? 0,
      schema_failed: tursoSchemaFailed?.n ?? 0,
      pending: tursoPending?.n ?? 0,
    },
    recentTenants: recentTenantsRow?.results ?? [],
    recentBoxes: recentBoxesRow?.results ?? [],
  })
}

// GET /api/admin/tenants — todos los tenants con counts (para la tabla del
// dashboard). Platform owner ve TODOS; miembros regulares solo ven los
// suyos — mismo criterio que /api/me/tenants.
async function listAdminTenants(env, user) {
  let tenants
  if (user.is_platform_owner) {
    tenants = await env.DB.prepare(`
      SELECT id, slug, name, status, created_at
        FROM htmlbox_tenants
       ORDER BY created_at DESC
    `).all()
  } else {
    tenants = await env.DB.prepare(`
      SELECT DISTINCT t.id, t.slug, t.name, t.status, t.created_at
        FROM htmlbox_tenants t
        JOIN htmlbox_workspaces w ON w.tenant_id = t.id
        JOIN htmlbox_memberships m ON m.workspace_id = w.id
       WHERE m.user_id = ?1
       ORDER BY t.created_at DESC
    `).bind(user.id).all()
  }

  const rows = tenants.results ?? []

  // Por cada tenant: contar workspaces + boxes + breakdown WFP. Si los
  // tenants son pocos (<100), este loop de N+1 queries es OK. Si en
  // el futuro hay miles, hacemos una sola query con JOIN + GROUP BY.
  const enriched = await Promise.all(rows.map(async (t) => {
    const [wsRow, boxRow, wfpReady, wfpFailed, wfpPending, lastBoxRow] = await Promise.all([
      env.DB.prepare(`SELECT count(*) AS n FROM htmlbox_workspaces WHERE tenant_id = ?1`).bind(t.id).first(),
      env.DB.prepare(`SELECT count(*) AS n FROM htmlbox_boxes WHERE tenant_id = ?1`).bind(t.id).first(),
      env.DB.prepare(`SELECT count(*) AS n FROM htmlbox_boxes WHERE tenant_id = ?1 AND wfp_status = 'ready'`).bind(t.id).first(),
      env.DB.prepare(`SELECT count(*) AS n FROM htmlbox_boxes WHERE tenant_id = ?1 AND wfp_status = 'failed'`).bind(t.id).first(),
      env.DB.prepare(`SELECT count(*) AS n FROM htmlbox_boxes WHERE tenant_id = ?1 AND wfp_status = 'pending'`).bind(t.id).first(),
      env.DB.prepare(`SELECT updated_at FROM htmlbox_boxes WHERE tenant_id = ?1 ORDER BY updated_at DESC LIMIT 1`).bind(t.id).first(),
    ])
    return {
      ...t,
      workspace_count: wsRow?.n ?? 0,
      box_count: boxRow?.n ?? 0,
      wfp_ready: wfpReady?.n ?? 0,
      wfp_failed: wfpFailed?.n ?? 0,
      wfp_pending: wfpPending?.n ?? 0,
      last_box_updated_at: lastBoxRow?.updated_at ?? null,
    }
  }))

  return json({ tenants: enriched, is_platform_owner: user.is_platform_owner })
}