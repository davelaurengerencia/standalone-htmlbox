// __tests__/e2e.test.js — tests E2E del ciclo HTMLBox contra el worker real.
//
// Usa vitest + @cloudflare/vitest-plugin: el worker de control-plane corre en
// proceso (miniflare) con bindings D1, R2 y KV. Las migrations se aplican
// automáticamente desde ./migrations (config en vitest.config.js).
//
// Convenciones:
//   - `SELF.fetch()` = al propio worker (mismo origin).
//   - Las cookies se extraen de Set-Cookie.
//   - Cuando un test necesita Turso real, sqld debe estar corriendo en :8080.

import { test, expect, beforeAll } from 'vitest'
import { env, SELF, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'

// Migrations embebidas como strings (el worker del pool no tiene acceso al
// filesystem). Mantener sincronizadas con ./migrations/*.sql.
const MIGRATIONS = [
  // 0001_control_plane.sql
  `CREATE TABLE IF NOT EXISTS htmlbox_tenants (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS htmlbox_users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    display_name TEXT,
    tenant_id TEXT REFERENCES htmlbox_tenants(id),
    is_platform_owner INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS htmlbox_workspaces (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES htmlbox_tenants(id),
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS htmlbox_memberships (
    user_id TEXT NOT NULL REFERENCES htmlbox_users(id),
    workspace_id TEXT NOT NULL REFERENCES htmlbox_workspaces(id),
    role TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, workspace_id)
  );
  CREATE INDEX IF NOT EXISTS idx_htmlbox_workspaces_tenant ON htmlbox_workspaces(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_htmlbox_memberships_user ON htmlbox_memberships(user_id);
  CREATE INDEX IF NOT EXISTS idx_htmlbox_memberships_workspace ON htmlbox_memberships(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_htmlbox_users_tenant ON htmlbox_users(tenant_id);`,

  // 0002_auth.sql
  `CREATE TABLE IF NOT EXISTS htmlbox_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES htmlbox_users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS htmlbox_magic_links (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_htmlbox_sessions_user ON htmlbox_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_htmlbox_sessions_expires ON htmlbox_sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_htmlbox_magic_links_email_created ON htmlbox_magic_links(email, created_at);
  CREATE INDEX IF NOT EXISTS idx_htmlbox_magic_links_expires ON htmlbox_magic_links(expires_at);`,

  // 0003_boxes.sql
  `CREATE TABLE IF NOT EXISTS htmlbox_boxes (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES htmlbox_tenants(id),
    workspace_id TEXT NOT NULL REFERENCES htmlbox_workspaces(id),
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'private',
    template TEXT NOT NULL DEFAULT 'empty',
    turso_db_url TEXT,
    turso_db_token TEXT,
    turso_status TEXT NOT NULL DEFAULT 'pending',
    htmlbox_version INTEGER NOT NULL DEFAULT 0,
    share_id TEXT,
    created_by TEXT REFERENCES htmlbox_users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (workspace_id, slug)
  );
  CREATE TABLE IF NOT EXISTS htmlbox_versions (
    box_id TEXT NOT NULL REFERENCES htmlbox_boxes(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    source TEXT NOT NULL,
    agent_name TEXT,
    summary TEXT NOT NULL,
    created_by TEXT REFERENCES htmlbox_users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (box_id, version)
  );
  CREATE INDEX IF NOT EXISTS idx_htmlbox_boxes_workspace ON htmlbox_boxes(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_htmlbox_boxes_tenant ON htmlbox_boxes(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_htmlbox_boxes_share ON htmlbox_boxes(share_id);
  CREATE INDEX IF NOT EXISTS idx_htmlbox_versions_box_desc ON htmlbox_versions(box_id, version DESC);`,

  // 0004_api_tokens.sql
  `CREATE TABLE IF NOT EXISTS htmlbox_api_tokens (
    id            TEXT PRIMARY KEY,
    token_hash    TEXT NOT NULL UNIQUE,
    prefix        TEXT NOT NULL,
    name          TEXT NOT NULL,
    box_id        TEXT NOT NULL REFERENCES htmlbox_boxes(id) ON DELETE CASCADE,
    user_id       TEXT NOT NULL REFERENCES htmlbox_users(id),
    scope         TEXT NOT NULL DEFAULT 'read',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at    TEXT,
    last_used_at  TEXT,
    revoked_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_htmlbox_api_tokens_box ON htmlbox_api_tokens (box_id, revoked_at);
  CREATE INDEX IF NOT EXISTS idx_htmlbox_api_tokens_user ON htmlbox_api_tokens (user_id, revoked_at);`,
]

// Aplica migrations antes de toda la suite.
beforeAll(async () => {
  for (const sql of MIGRATIONS) {
    const stmts = sql
      .split(/;\s*$/m)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    for (const stmt of stmts) {
      try {
        await env.DB.prepare(stmt).run()
      } catch (err) {
        // Re-ejecución (CREATE IF NOT EXISTS) — ignorar errores de "ya existe".
        if (!String(err?.message || err).includes('already exists')) throw err
      }
    }
  }
})

const COOKIE_RE = /sid=([a-f0-9]+)/

function extractSid(headers) {
  const sc = headers.get('set-cookie') || ''
  const m = sc.match(COOKIE_RE)
  return m ? m[1] : null
}

async function jsonReq(url, init = {}) {
  const headers = new Headers(init.headers || {})
  if (
    init.body && typeof init.body === 'object'
    && !(init.body instanceof FormData)
    && !(init.body instanceof ArrayBuffer)
    && !(init.body instanceof ReadableStream)
  ) {
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    init.body = JSON.stringify(init.body)
  }
  return await SELF.fetch(url, { ...init, headers })
}

async function postJson(url, body, cookie) {
  const headers = { 'Content-Type': 'application/json' }
  if (cookie) headers.Cookie = `sid=${cookie}`
  return await jsonReq(url, { method: 'POST', body, headers })
}

async function getJson(url, cookie) {
  const headers = {}
  if (cookie) headers.Cookie = `sid=${cookie}`
  return await jsonReq(url, { headers })
}

// Bootstrap programático de un usuario: hace el ciclo del magic-link.
// Si `asPlatformOwner` es true, además marca is_platform_owner=1.
async function bootstrapUser(email, { asPlatformOwner = false } = {}) {
  // 1) request magic-link
  let res = await jsonReq('http://example.com/api/auth/request', {
    method: 'POST', body: { email },
  })
  expect(res.status).toBe(200)
  const reqData = await res.json()
  const previewLink = reqData._dev_preview
  expect(previewLink).toMatch(/\/api\/auth\/verify\?token=/)
  const token = new URL(previewLink).searchParams.get('token')

  // 2) consume el magic-link
  res = await jsonReq('http://example.com/api/auth/consume', {
    method: 'POST', body: { token },
  })
  expect(res.status).toBe(200)
  expect((await res.json()).ok).toBe(true)
  const sid = extractSid(res.headers)
  expect(sid).toBeTruthy()

  if (asPlatformOwner) {
    await env.DB.prepare(`UPDATE htmlbox_users SET is_platform_owner = 1 WHERE email = ?1`).bind(email).run()
  }

  res = await getJson('http://example.com/api/auth/me', sid)
  const me = await res.json()

  return { sid, email, user: me.user }
}

// Backward-compat: el helper viejo siempre creaba platform owner.
const bootstrapOwner = (email) => bootstrapUser(email, { asPlatformOwner: true })

// =============================================================================
// Tests
// =============================================================================

test('1) auth flow end-to-end: request → consume → me → logout', async () => {
  const ctx = createExecutionContext()
  const { sid } = await bootstrapOwner('user1@test.local')
  expect(sid).toMatch(/^[a-f0-9]{64}$/)

  // me autenticado
  let me = await (await getJson('http://example.com/api/auth/me', sid)).json()
  expect(me.user.email).toBe('user1@test.local')

  // logout
  const logoutRes = await postJson('http://example.com/api/auth/logout', {}, sid)
  await waitOnExecutionContext(ctx)
  expect(logoutRes.status).toBe(200)

  // me ya no autenticado
  me = await (await getJson('http://example.com/api/auth/me', sid)).json()
  expect(me.user).toBeNull()
})

test('2) tenant + workspace creation', async () => {
  const { sid } = await bootstrapOwner('user2@test.local')

  const res = await postJson('http://example.com/api/tenants', {
    slug: 'acme', name: 'Acme Corp',
  }, sid)
  expect(res.status).toBe(201)
  const { tenant } = await res.json()
  expect(tenant.slug).toBe('acme')
  expect(tenant.id).toBeTruthy()

  const wsRes = await getJson(`http://example.com/api/tenants/${tenant.id}/workspaces`, sid)
  const wsData = await wsRes.json()
  expect(wsData.workspaces.length).toBe(1)
  expect(wsData.workspaces[0].name).toBe('Default')
})

test('3) box creation aprovisiona Turso (ready si sqld corre, failed si no)', async () => {
  const { sid } = await bootstrapOwner('user3@test.local')

  const tRes = await postJson('http://example.com/api/tenants', { slug: 'ten3', name: 'T3' }, sid)
  const { tenant } = await tRes.json()
  const wsRes = await getJson(`http://example.com/api/tenants/${tenant.id}/workspaces`, sid)
  const wsData = await wsRes.json()
  const workspaceId = wsData.workspaces[0].id

  const bRes = await postJson('http://example.com/api/boxes', {
    name: 'Mi Dashboard',
    workspace_id: workspaceId,
    template: 'dashboard',
    visibility: 'public',
  }, sid)
  expect(bRes.status).toBe(201)
  const { box } = await bRes.json()
  expect(box.id).toBeTruthy()
  expect(box.slug).toBe('mi-dashboard')
  expect(['ready', 'failed']).toContain(box.turso_status)
  expect(box.share_id).toBeTruthy()
})

test('4) versionado: 6 pushes → quedan 5 versiones, v1 purgada', async () => {
  const { sid } = await bootstrapOwner('user4@test.local')
  const tRes = await postJson('http://example.com/api/tenants', { slug: 'ten4', name: 'T4' }, sid)
  const { tenant } = await tRes.json()
  const wsRes = await getJson(`http://example.com/api/tenants/${tenant.id}/workspaces`, sid)
  const wsData = await wsRes.json()
  const workspaceId = wsData.workspaces[0].id

  const bRes = await postJson('http://example.com/api/boxes', {
    name: 'VersBox', workspace_id: workspaceId, template: 'empty',
  }, sid)
  const { box } = await bRes.json()

  const ctx = createExecutionContext()
  for (let i = 1; i <= 6; i++) {
    const html = `<!doctype html><body>v${i}</body>`
    const size = new TextEncoder().encode(html).byteLength

    const urlRes = await postJson(`http://example.com/api/boxes/${box.id}/upload-url`, {
      size, contentType: 'text/html',
    }, sid)
    expect(urlRes.status).toBe(200)
    const { uploadUrl, key, version } = await urlRes.json()
    expect(version).toBe(i)
    expect(key).toBe(`tenants/ten4/boxes/${box.id}/versions/v${i}.html`)

    const putRes = await SELF.fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/html' },
      body: html,
    })
    expect(putRes.status).toBe(200)

    const confRes = await postJson(`http://example.com/api/boxes/${box.id}/html`, {
      r2Key: key, summary: `iter ${i}`, source: 'portal',
    }, sid)
    expect(confRes.status).toBe(200)
  }
  await waitOnExecutionContext(ctx)

  // verificar que quedan 5 versiones
  const listRes = await getJson(`http://example.com/api/boxes/${box.id}/versions`, sid)
  const listData = await listRes.json()
  expect(listData.versions.length).toBe(5)
  expect(listData.versions.map((v) => v.version)).toEqual([6, 5, 4, 3, 2])

  // v1 debe haber sido purgada del bucket
  const v1 = await env.BUCKET.get(`tenants/ten4/boxes/${box.id}/versions/v1.html`)
  expect(v1).toBeNull()

  // v6 sigue ahí con el contenido correcto
  const v6 = await env.BUCKET.get(`tenants/ten4/boxes/${box.id}/versions/v6.html`)
  expect(v6).not.toBeNull()
  expect(await v6.text()).toBe('<!doctype html><body>v6</body>')
})

test('5) rollback crea nueva versión con el contenido de la anterior', async () => {
  const { sid } = await bootstrapOwner('user5@test.local')
  const tRes = await postJson('http://example.com/api/tenants', { slug: 'ten5', name: 'T5' }, sid)
  const { tenant } = await tRes.json()
  const wsRes = await getJson(`http://example.com/api/tenants/${tenant.id}/workspaces`, sid)
  const wsData = await wsRes.json()
  const workspaceId = wsData.workspaces[0].id

  const bRes = await postJson('http://example.com/api/boxes', {
    name: 'Rb', workspace_id: workspaceId, template: 'empty',
  }, sid)
  const { box } = await bRes.json()

  const ctx = createExecutionContext()
  // subir v1, v2, v3
  for (let i = 1; i <= 3; i++) {
    const html = `v${i}-content`
    const urlRes = await postJson(`http://example.com/api/boxes/${box.id}/upload-url`, {
      size: html.length, contentType: 'text/html',
    }, sid)
    const { uploadUrl, key } = await urlRes.json()
    await SELF.fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/html' },
      body: html,
    })
    await postJson(`http://example.com/api/boxes/${box.id}/html`, {
      r2Key: key, summary: `v${i}`, source: 'portal',
    }, sid)
  }

  // rollback a v2
  const rbRes = await postJson(`http://example.com/api/boxes/${box.id}/rollback/2`, {}, sid)
  expect(rbRes.status).toBe(200)
  const rbData = await rbRes.json()
  expect(rbData.version).toBe(4)
  await waitOnExecutionContext(ctx)

  // la nueva versión 4 debe contener el contenido de v2
  const v4 = await env.BUCKET.get(`tenants/ten5/boxes/${box.id}/versions/v4.html`)
  expect(v4).not.toBeNull()
  expect(await v4.text()).toBe('v2-content')

  // historial completo (4 versiones)
  const list = await (await getJson(`http://example.com/api/boxes/${box.id}/versions`, sid)).json()
  expect(list.versions.map((v) => v.version)).toEqual([4, 3, 2, 1])
  expect(list.versions.find((v) => v.version === 4).source).toBe('rollback')
})

test('6) aislamiento entre tenants (403 cross-tenant)', async () => {
  const { sid: sidA } = await bootstrapOwner('iso-a@test.local')
  const tResA = await postJson('http://example.com/api/tenants', { slug: 'tenant-a', name: 'A' }, sidA)
  const { tenant: tenantA } = await tResA.json()
  const wsResA = await getJson(`http://example.com/api/tenants/${tenantA.id}/workspaces`, sidA)
  const wsDataA = await wsResA.json()
  const wsIdA = wsDataA.workspaces[0].id

  const bResA = await postJson('http://example.com/api/boxes', {
    name: 'BoxA', workspace_id: wsIdA, template: 'empty',
  }, sidA)
  const { box: boxA } = await bResA.json()

  // usuario del tenant B NO debe poder leer el box de A
  // (lo creamos SIN platform_owner para que el check de aislamiento aplique)
  const { sid: sidB } = await bootstrapUser('iso-b@test.local', { asPlatformOwner: false })
  // Crear tenant B requiere platform_owner, así que lo hacemos via DB directa.
  const tenantBId = `tenant_b_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  await env.DB.prepare(`INSERT INTO htmlbox_tenants (id, slug, name) VALUES (?1, 'tenant-b', 'B')`)
    .bind(tenantBId).run()

  const getRes = await getJson(`http://example.com/api/boxes/${boxA.id}`, sidB)
  expect(getRes.status).toBe(403)

  // endpoint interno del runtime con cookie de B
  const intRes = await SELF.fetch(`http://example.com/api/internal/boxes-by-slug/tenant-a/${boxA.slug}`, {
    headers: { Cookie: `sid=${sidB}` },
  })
  expect(intRes.status).toBe(403)
})

test('7) /api/_local/upload: key inválida → 400, mode prod sin firma → 400 (missing_signature), key válida local-fake → 200', async () => {
  const ctx = createExecutionContext()
  const prev = env.HTMLBOX_R2_MODE

  try {
    // Caso A: mode != local-fake sin firma HMAC → 400 (missing_signature)
    env.HTMLBOX_R2_MODE = 'production'
    let res = await SELF.fetch(
      'http://example.com/api/_local/upload?key=tenants/x/boxes/y/versions/v1.html',
      { method: 'PUT', body: '<html/>' },
    )
    expect(res.status).toBe(400)

    // Caso B: mode = local-fake pero key mal formado → 400
    env.HTMLBOX_R2_MODE = 'local-fake'
    res = await SELF.fetch(
      'http://example.com/api/_local/upload?key=../etc/passwd',
      { method: 'PUT', body: '<html/>' },
    )
    expect(res.status).toBe(400)

    // Caso C: mode = local-fake y key válido → 200 + escribe en bucket
    res = await SELF.fetch(
      'http://example.com/api/_local/upload?key=tenants/x/boxes/y/versions/v1.html',
      { method: 'PUT', body: '<html>x</html>', headers: { 'Content-Type': 'text/html' } },
    )
    expect(res.status).toBe(200)
    const obj = await env.BUCKET.get('tenants/x/boxes/y/versions/v1.html')
    expect(obj).not.toBeNull()
    expect(await obj.text()).toBe('<html>x</html>')
  } finally {
    env.HTMLBOX_R2_MODE = prev
  }
  await waitOnExecutionContext(ctx)
})

test('8) active-html: 404 box inexistente, 404 sin versión activa', async () => {
  const { sid } = await bootstrapOwner('user8@test.local')
  const tRes = await postJson('http://example.com/api/tenants', { slug: 'ten8', name: 'T8' }, sid)
  const { tenant } = await tRes.json()
  const wsRes = await getJson(`http://example.com/api/tenants/${tenant.id}/workspaces`, sid)
  const wsData = await wsRes.json()
  const workspaceId = wsData.workspaces[0].id

  const bRes = await postJson('http://example.com/api/boxes', {
    name: 'A8', workspace_id: workspaceId, template: 'empty',
  }, sid)
  const { box } = await bRes.json()

  // sin cookie y box privado (default) → 404 not_found (caller anónimo no debe
  // poder enumerar boxes por id)
  const res = await SELF.fetch(`http://example.com/api/boxes/${box.id}/active-html`)
  expect(res.status).toBe(404)

  // con cookie pero sin versiones → 404 con error claro
  const res2 = await SELF.fetch(
    `http://example.com/api/boxes/${box.id}/active-html`,
    { headers: { Cookie: `sid=${sid}` } },
  )
  expect(res2.status).toBe(404)
  const data = await res2.json()
  expect(data.error).toBe('no_published_version')

  // box público → 200 sin auth
  const bResPub = await postJson('http://example.com/api/boxes', {
    name: 'Pub8', workspace_id: workspaceId, template: 'empty', visibility: 'public',
  }, sid)
  const { box: pubBox } = await bResPub.json()
  // sin versiones: 404
  const pubRes = await SELF.fetch(`http://example.com/api/boxes/${pubBox.id}/active-html`)
  expect(pubRes.status).toBe(404)
})