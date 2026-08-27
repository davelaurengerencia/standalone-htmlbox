// __tests__/ai.test.js — tests E2E de los endpoints /api/ai/*.
// Usa vitest + cloudflare-test (miniflare) igual que e2e.test.js.

import { test, expect, beforeAll, vi } from 'vitest'
import { env, SELF, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'

const MIGRATIONS = [
  // (sub-set de las necesarias para los endpoints AI)
  `CREATE TABLE IF NOT EXISTS htmlbox_tenants (
    id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS htmlbox_users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, display_name TEXT,
    tenant_id TEXT REFERENCES htmlbox_tenants(id),
    is_platform_owner INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS htmlbox_workspaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES htmlbox_tenants(id),
    name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS htmlbox_memberships (
    user_id TEXT NOT NULL REFERENCES htmlbox_users(id),
    workspace_id TEXT NOT NULL REFERENCES htmlbox_workspaces(id),
    role TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, workspace_id)
  );
  CREATE TABLE IF NOT EXISTS htmlbox_sessions (
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
  CREATE TABLE IF NOT EXISTS htmlbox_boxes (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES htmlbox_tenants(id),
    workspace_id TEXT NOT NULL REFERENCES htmlbox_workspaces(id),
    slug TEXT NOT NULL, name TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'private',
    template TEXT NOT NULL DEFAULT 'empty',
    turso_db_url TEXT, turso_db_token TEXT,
    turso_status TEXT NOT NULL DEFAULT 'pending',
    htmlbox_version INTEGER NOT NULL DEFAULT 0,
    share_id TEXT, created_by TEXT REFERENCES htmlbox_users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    auto_analyze_on_save INTEGER NOT NULL DEFAULT 0,
    UNIQUE (workspace_id, slug)
  );
  CREATE TABLE IF NOT EXISTS htmlbox_ai_analyses (
    id TEXT PRIMARY KEY,
    box_id TEXT NOT NULL REFERENCES htmlbox_boxes(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES htmlbox_users(id),
    prompt_html_size INTEGER NOT NULL,
    proposal_json TEXT NOT NULL,
    model TEXT NOT NULL,
    tokens_used INTEGER,
    applied INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`,
]

let migrationsApplied = false
beforeAll(async () => {
  if (!migrationsApplied) {
    for (const sql of MIGRATIONS) {
      const stmts = sql.split(/;\s*$/m).map((s) => s.trim()).filter((s) => s.length > 0)
      for (const stmt of stmts) {
        try { await env.DB.prepare(stmt).run() }
        catch (err) {
          if (!String(err?.message || err).includes('already exists')) throw err
        }
      }
    }
    migrationsApplied = true
  }
})

const COOKIE_RE = /sid=([a-f0-9]+)/
function extractSid(headers) {
  const sc = headers.get('set-cookie') || ''
  return sc.match(COOKIE_RE)?.[1] || null
}

async function jsonReq(url, init = {}) {
  const headers = new Headers(init.headers || {})
  if (init.body && typeof init.body === 'object'
      && !(init.body instanceof FormData)
      && !(init.body instanceof ArrayBuffer)
      && !(init.body instanceof ReadableStream)) {
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    init.body = JSON.stringify(init.body)
  }
  return await SELF.fetch(url, { ...init, headers })
}

async function bootstrapUser(email, { asPlatformOwner = false, role = 'owner' } = {}) {
  let res = await jsonReq('http://example.com/api/auth/request', {
    method: 'POST', body: { email },
  })
  expect(res.status).toBe(200)
  const { _dev_preview: previewLink } = await res.json()
  const token = new URL(previewLink).searchParams.get('token')
  res = await jsonReq('http://example.com/api/auth/consume', {
    method: 'POST', body: { token },
  })
  expect(res.status).toBe(200)
  const sid = extractSid(res.headers)
  expect(sid).toBeTruthy()

  if (asPlatformOwner) {
    await env.DB.prepare(`UPDATE htmlbox_users SET is_platform_owner = 1 WHERE email = ?1`).bind(email).run()
  }
  return sid
}

// Crea tenant + workspace + box con membership opcional.
// Devuelve { sid, boxId, workspaceId, tenantId }.
async function bootstrapBox(email, { role = 'owner', asPlatformOwner = true } = {}) {
  const sid = await bootstrapUser(email, { asPlatformOwner })
  const tRes = await jsonReq('http://example.com/api/tenants', {
    method: 'POST', body: { slug: `t-${Math.random().toString(36).slice(2, 8)}`, name: 'T' },
    headers: { Cookie: `sid=${sid}` },
  })
  expect(tRes.status).toBe(201)
  const { tenant } = await tRes.json()

  const wsRes = await jsonReq(`http://example.com/api/tenants/${tenant.id}/workspaces`, {
    headers: { Cookie: `sid=${sid}` },
  })
  const { workspaces } = await wsRes.json()
  const workspaceId = workspaces[0].id

  // Si el rol pedido NO es 'owner' (porque platform_owner crea con owner implícito),
  // pisamos la membresía para que efectivamente sea viewer.
  const meRes = await jsonReq('http://example.com/api/auth/me', { headers: { Cookie: `sid=${sid}` } })
  const { user } = await meRes.json()
  await env.DB.prepare(
    `INSERT INTO htmlbox_memberships (user_id, workspace_id, role) VALUES (?1, ?2, ?3)
       ON CONFLICT(user_id, workspace_id) DO UPDATE SET role = excluded.role`
  ).bind(user.id, workspaceId, role).run()

  const bRes = await jsonReq('http://example.com/api/boxes', {
    method: 'POST',
    body: { name: 'Box', workspace_id: workspaceId, template: 'empty' },
    headers: { Cookie: `sid=${sid}` },
  })
  expect(bRes.status).toBe(201)
  const { box } = await bRes.json()
  return { sid, userId: user.id, boxId: box.id, workspaceId, tenantId: tenant.id }
}

function mockGeminiFetch(respondFn) {
  const orig = globalThis.fetch
  globalThis.fetch = vi.fn(async (url, init) => {
    const u = String(url)
    if (u.includes('generativelanguage.googleapis.com')) {
      return respondFn(url, init)
    }
    return orig.call(globalThis, url, init)
  })
  return () => { globalThis.fetch = orig }
}

const OK_GEMINI = () => new Response(JSON.stringify({
  candidates: [{
    content: { parts: [{ text: JSON.stringify({
      tables: [{
        slug: 'productos',
        name: 'Productos',
        description: 'Catálogo',
        columns: [{ name: 'id', type: 'number', example: '1' }],
        sample_rows: [{ id: 1 }],
        sdk_example: "await HTMLBox.table('productos').rows({ limit: 50 })",
      }],
    }) }], role: 'model' },
    finishReason: 'STOP',
  }],
  usageMetadata: { totalTokenCount: 500 },
}), { status: 200, headers: { 'Content-Type': 'application/json' } })

beforeAll(() => {
  env.GEMINI_API_KEY = 'test-key'
})

// 1) sin auth → 401
test('1) POST /api/ai/analyze-html without auth → 401', async () => {
  const res = await jsonReq('http://example.com/api/ai/analyze-html', {
    method: 'POST', body: { boxId: 'abc', html: '<html/>' },
  })
  expect(res.status).toBe(401)
})

// 2) con editor + body válido → 200 + tables + analysisId
test('2) POST /api/ai/analyze-html with editor auth + valid body → 200', async () => {
  const restore = mockGeminiFetch(OK_GEMINI)
  try {
    const { sid, boxId } = await bootstrapBox('ai-user-2@test.local', { role: 'owner' })

    const res = await jsonReq('http://example.com/api/ai/analyze-html', {
      method: 'POST',
      body: { boxId, html: '<html><script>const productos = [{id:1}]</script></html>' },
      headers: { Cookie: `sid=${sid}` },
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(typeof data.analysisId).toBe('string')
    expect(data.analysisId.length).toBeGreaterThan(0)
    expect(Array.isArray(data.tables)).toBe(true)
    expect(data.tables).toHaveLength(1)
    expect(data.tables[0].slug).toBe('productos')

    // quedó persistido
    const row = await env.DB.prepare(
      `SELECT model, tokens_used, applied FROM htmlbox_ai_analyses WHERE id = ?1`
    ).bind(data.analysisId).first()
    expect(row).toBeTruthy()
    expect(row.model).toBe('gemini-flash-latest')
    expect(row.tokens_used).toBe(500)
    expect(row.applied).toBe(0)
  } finally {
    restore()
  }
})

// 3) viewer → 403
test('3) POST /api/ai/analyze-html with viewer auth → 403', async () => {
  const restore = mockGeminiFetch(OK_GEMINI)
  try {
    // owner crea el box
    const ownerCtx = createExecutionContext()
    const owner = await bootstrapBox('ai-owner@test.local', { role: 'owner' })
    // viewer: usuario en el mismo tenant con membresía de viewer
    const viewerSid = await bootstrapUser('ai-viewer@test.local', { asPlatformOwner: false })
    // Aseguramos que el viewer esté en el mismo tenant que el workspace
    const viewerUserIdRes = await jsonReq('http://example.com/api/auth/me', { headers: { Cookie: `sid=${viewerSid}` } })
    const { user: viewerUser } = await viewerUserIdRes.json()
    await env.DB.prepare(
      `UPDATE htmlbox_users SET tenant_id = ?1 WHERE id = ?2`
    ).bind(owner.tenantId, viewerUser.id).run()
    // Le damos el rol viewer en el workspace
    await env.DB.prepare(
      `INSERT INTO htmlbox_memberships (user_id, workspace_id, role) VALUES (?1, ?2, 'viewer')
         ON CONFLICT(user_id, workspace_id) DO UPDATE SET role = excluded.role`
    ).bind(viewerUser.id, owner.workspaceId).run()

    const res = await jsonReq('http://example.com/api/ai/analyze-html', {
      method: 'POST',
      body: { boxId: owner.boxId, html: '<html/>' },
      headers: { Cookie: `sid=${viewerSid}` },
    })
    expect(res.status).toBe(403)
    await waitOnExecutionContext(ownerCtx)
  } finally {
    restore()
  }
})

// 4) HTML > 100KB → 200 (truncado)
test('4) POST /api/ai/analyze-html with HTML > 100KB → 200 (truncated)', async () => {
  let capturedText = ''
  const restore = mockGeminiFetch((url, init) => {
    const body = JSON.parse(init.body)
    capturedText = body.contents[0].parts[0].text
    return OK_GEMINI()
  })
  try {
    const { sid, boxId } = await bootstrapBox('ai-user-4@test.local', { role: 'owner' })
    const big = 'x'.repeat(150_000)

    const res = await jsonReq('http://example.com/api/ai/analyze-html', {
      method: 'POST',
      body: { boxId, html: big },
      headers: { Cookie: `sid=${sid}` },
    })
    expect(res.status).toBe(200)
    // el prompt recibido por Gemini debe tener < ~105KB
    expect(capturedText.length).toBeLessThan(105_000)
  } finally {
    restore()
  }
})

// 5) rate-limit: 5 en 1min → 429
test('5) POST /api/ai/analyze-html rate-limited after 5 in 1min → 429', async () => {
  const restore = mockGeminiFetch(OK_GEMINI)
  try {
    const { sid, boxId } = await bootstrapBox('ai-user-5@test.local', { role: 'owner' })

    for (let i = 0; i < 5; i++) {
      const res = await jsonReq('http://example.com/api/ai/analyze-html', {
        method: 'POST',
        body: { boxId, html: `<html>${i}</html>` },
        headers: { Cookie: `sid=${sid}` },
      })
      expect(res.status).toBe(200)
    }
    const sixth = await jsonReq('http://example.com/api/ai/analyze-html', {
      method: 'POST',
      body: { boxId, html: '<html>6</html>' },
      headers: { Cookie: `sid=${sid}` },
    })
    expect(sixth.status).toBe(429)
  } finally {
    restore()
  }
})

// 6) GET /api/ai/analyses?boxId=... → historial
test('6) GET /api/ai/analyses?boxId=... → returns history', async () => {
  const restore = mockGeminiFetch(OK_GEMINI)
  try {
    const { sid, boxId } = await bootstrapBox('ai-user-6@test.local', { role: 'owner' })

    // Generamos 2 análisis
    for (let i = 0; i < 2; i++) {
      const res = await jsonReq('http://example.com/api/ai/analyze-html', {
        method: 'POST',
        body: { boxId, html: `<html>${i}</html>` },
        headers: { Cookie: `sid=${sid}` },
      })
      expect(res.status).toBe(200)
    }

    const listRes = await jsonReq(
      `http://example.com/api/ai/analyses?boxId=${boxId}`,
      { headers: { Cookie: `sid=${sid}` } },
    )
    expect(listRes.status).toBe(200)
    const { analyses } = await listRes.json()
    expect(Array.isArray(analyses)).toBe(true)
    expect(analyses).toHaveLength(2)
    expect(analyses[0]).toHaveProperty('id')
    expect(analyses[0]).toHaveProperty('model')
    expect(analyses[0]).toHaveProperty('tokens_used')
    expect(analyses[0]).toHaveProperty('applied')
  } finally {
    restore()
  }
})

// 7) PATCH /api/boxes/:id con auto_analyze_on_save → persiste y devuelve en SELECT
test('7) PATCH /api/boxes/:id with auto_analyze_on_save persists and is returned', async () => {
  const restore = mockGeminiFetch(OK_GEMINI)
  try {
    const { sid, boxId } = await bootstrapBox('ai-user-7@test.local', { role: 'owner' })

    const patchRes = await jsonReq(`http://example.com/api/boxes/${boxId}`, {
      method: 'PATCH',
      body: { auto_analyze_on_save: true },
      headers: { Cookie: `sid=${sid}` },
    })
    expect(patchRes.status).toBe(200)
    const { box } = await patchRes.json()
    expect(box.auto_analyze_on_save).toBe(1)

    // GET /api/boxes/:id también lo devuelve
    const getRes = await jsonReq(`http://example.com/api/boxes/${boxId}`, {
      headers: { Cookie: `sid=${sid}` },
    })
    expect(getRes.status).toBe(200)
    const data = await getRes.json()
    expect(data.box.auto_analyze_on_save).toBe(1)

    // PATCH con false lo apaga
    const patchRes2 = await jsonReq(`http://example.com/api/boxes/${boxId}`, {
      method: 'PATCH',
      body: { auto_analyze_on_save: false },
      headers: { Cookie: `sid=${sid}` },
    })
    expect(patchRes2.status).toBe(200)
    const { box: box2 } = await patchRes2.json()
    expect(box2.auto_analyze_on_save).toBe(0)
  } finally {
    restore()
  }
})

// 8) POST /api/ai/analyses/:id/apply → marca applied=1
test('8) POST /api/ai/analyses/:id/apply marks applied=1', async () => {
  const restore = mockGeminiFetch(OK_GEMINI)
  try {
    const { sid, boxId } = await bootstrapBox('ai-user-8@test.local', { role: 'owner' })

    const ar = await jsonReq('http://example.com/api/ai/analyze-html', {
      method: 'POST',
      body: { boxId, html: '<html/>' },
      headers: { Cookie: `sid=${sid}` },
    })
    const { analysisId } = await ar.json()

    const applyRes = await jsonReq(
      `http://example.com/api/ai/analyses/${analysisId}/apply`,
      { method: 'POST', headers: { Cookie: `sid=${sid}` } },
    )
    expect(applyRes.status).toBe(200)
    const data = await applyRes.json()
    expect(data.ok).toBe(true)
    expect(data.applied).toBe(1)

    // verificamos en DB
    const row = await env.DB.prepare(
      `SELECT applied FROM htmlbox_ai_analyses WHERE id = ?1`
    ).bind(analysisId).first()
    expect(row.applied).toBe(1)
  } finally {
    restore()
  }
})