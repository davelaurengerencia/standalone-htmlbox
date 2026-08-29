// box-template/lib/handlers.js — handlers extraídos del box worker.
//
// Razón: testearlos con node --test sin necesidad de wrangler/miniflare.
// El box-template/worker.js importa estas funciones y las usa dentro del
// default.fetch; acá están como funciones puras testeables con mocks de R2.
//
// Storage: env.STUDIO_R2 (R2 bucket `htmlbox-studio-boxes`, opcional).
// Si el binding no está, los handlers devuelven 503 con un hint claro —
// degradación elegante para deployar el bundle ANTES de crear el bucket.

export const BOX_ID_HEADER = 'X-HTMLBox-Box-Id'
export const BOX_ID_PATTERN = /^[a-z0-9]{16}$/

export function getBoxId(request) {
  const boxId = request.headers.get(BOX_ID_HEADER)
  if (!BOX_ID_PATTERN.test(boxId || '')) return null
  return boxId
}

export function dispatchZone(pathname) {
  let p = pathname
  const m = pathname.match(/^\/box\/[a-z0-9]{16}(\/.*)?$/)
  if (m) p = m[1] || '/'

  if (p === '/' || p === '') return { zone: 'app', subpath: '/' }
  if (p === '/editor/frontend' || p.startsWith('/editor/frontend/')) {
    return { zone: 'editor-frontend', subpath: p }
  }
  if (p === '/editor/backend' || p.startsWith('/editor/backend/')) {
    return { zone: 'editor-backend', subpath: p }
  }
  if (p === '/editor/variables' || p.startsWith('/editor/variables/')) {
    return { zone: 'editor-variables', subpath: p }
  }
  if (p === '/editor/api/frontend' || p === '/editor/api/flow' ||
      p === '/editor/api/variables' || p === '/editor/api/deploy') {
    return { zone: 'editor-api', subpath: p }
  }
  if (p.startsWith('/api/') || p === '/api') {
    return { zone: 'api', subpath: p }
  }
  return { zone: 'app', subpath: p }
}

// === Respuestas comunes ===

const EMPTY_APP_HTML = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Box vacío</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           min-height: 100vh; display: flex; align-items: center; justify-content: center;
           background: #f8fafc; color: #0f172a; margin: 0; }
    .box { max-width: 480px; padding: 2rem; text-align: center; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { color: #64748b; margin-bottom: 1.5rem; }
    a { display: inline-block; padding: 0.5rem 1rem; background: #6366f1;
        color: white; text-decoration: none; border-radius: 6px; }
    a:hover { background: #4f46e5; }
  </style>
</head>
<body>
  <main class="box">
    <h1>Box vacío</h1>
    <p>Todavía no se hizo el primer deploy. Empezá por el editor de frontend.</p>
    <a href="/editor/frontend">Abrir App Studio</a>
  </main>
</body>
</html>`

export const PLACEHOLDER_HTML = `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><title>Próximamente</title></head>
<body style="font-family: sans-serif; padding: 2rem;">
  <h1>Zona en construcción</h1>
  <p>Esta parte del editor se habilita en fases posteriores del experimento.</p>
  <p><a href="/">← Volver al box</a></p>
</body>
</html>`

export function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

export function noStorageResponse() {
  return jsonResponse({
    error: 'no_storage',
    detail: 'STUDIO_R2 binding no configurado — crear el bucket htmlbox-studio-boxes y agregarlo al wrangler.jsonc. Ver scripts/setup-wfp-experiments.sh.',
  }, 503)
}

// === Handlers ===

// GET / → app del usuario. Lee HTML de R2 si existe, si no placeholder.
export async function handleApp(env, boxId) {
  if (!env.STUDIO_R2) {
    return htmlResponse(EMPTY_APP_HTML)
  }
  const obj = await env.STUDIO_R2.get(`box-${boxId}/frontend.html`)
  if (!obj) {
    return htmlResponse(EMPTY_APP_HTML)
  }
  const html = await obj.text()
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  })
}

export function handleEditorFrontend(appStudioHtml) {
  return htmlResponse(appStudioHtml)
}

export function handleEditorVariables() {
  return htmlResponse(PLACEHOLDER_HTML)
}

// POST /editor/api/* — handlers de Fase 5.
export async function handleEditorApi(request, env, boxId, subpath) {
  if (!env.STUDIO_R2) return noStorageResponse()

  if (subpath === '/editor/api/frontend') {
    const html = await request.text()
    if (typeof html !== 'string' || html.length === 0) {
      return jsonResponse({ ok: false, error: 'empty_body' }, 400)
    }
    await env.STUDIO_R2.put(`box-${boxId}/frontend.html`, html, {
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
    })
    return jsonResponse({ ok: true, size: html.length })
  }

  if (subpath === '/editor/api/flow') {
    const body = await request.text()
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch (e) {
      return jsonResponse({ ok: false, error: 'invalid_json', detail: String(e) }, 400)
    }
    await env.STUDIO_R2.put(`box-${boxId}/flow.json`, JSON.stringify(parsed), {
      httpMetadata: { contentType: 'application/json' },
    })
    return jsonResponse({ ok: true })
  }

  if (subpath === '/editor/api/variables') {
    const body = await request.text()
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch (e) {
      return jsonResponse({ ok: false, error: 'invalid_json', detail: String(e) }, 400)
    }
    if (typeof parsed.vars !== 'object' || parsed.vars === null) {
      return jsonResponse({ ok: false, error: 'vars_must_be_object' }, 400)
    }
    await env.STUDIO_R2.put(`box-${boxId}/vars.json`, JSON.stringify(parsed), {
      httpMetadata: { contentType: 'application/json' },
    })
    return jsonResponse({ ok: true })
  }

  if (subpath === '/editor/api/deploy') {
    return jsonResponse({ ok: true, note: 'deploy es no-op: el bundle lee de R2 en runtime, no requiere redeploy.' })
  }

  return jsonResponse({ ok: false, error: 'unknown_editor_api_path' }, 404)
}

// Carga los flows guardados en R2 para este box (si existen).
// Estructura esperada: { 'nombre-del-flow': [flowJsonArray], ... }.
export async function loadStoredFlows(env, boxId) {
  if (!env.STUDIO_R2) return {}
  const obj = await env.STUDIO_R2.get(`box-${boxId}/flow.json`)
  if (!obj) return {}
  try {
    return JSON.parse(await obj.text())
  } catch {
    return {}
  }
}