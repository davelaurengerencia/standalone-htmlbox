// src/worker.js — SivoStudio Worker (launcher + front-worker consolidados).
//
// Ver comentario al inicio de wrangler.jsonc sobre por qué un solo Worker.
//
// Rutas:
//   GET  /                            → launcher UI (botón "Crear box")
//   POST /api/studio/create-box       → aprovisiona box (D1 + WFP) + redirige
//   GET  /api/studio/list             → lista boxes activos (debug)
//   *    /box/{boxId}/*               → despacha al box via WFP
//   GET  /health                      → health check
//
// Aislamiento total del resto del monorepo: NO importa nada de control-plane,
// runtime, portal. Único módulo externo: src/lib/wfpDeployer.js (propio).

import { deployStudioBoxWorker, deleteStudioBoxWorker } from './lib/wfpDeployer.js'

const LAUNCHER_HTML = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SivoStudio — launcher</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
      color: #f1f5f9;
    }
    main { max-width: 560px; padding: 2rem; text-align: center; }
    .badge {
      display: inline-block; padding: 0.4rem 0.8rem;
      background: rgba(99,102,241,0.1); border: 1px solid rgba(99,102,241,0.3);
      border-radius: 999px; font-size: 0.75rem; color: #a5b4fc; margin-bottom: 1.5rem;
    }
    h1 { font-size: 2.25rem; margin-bottom: 0.75rem;
         background: linear-gradient(90deg, #6366f1, #ec4899);
         -webkit-background-clip: text; -webkit-text-fill-color: transparent;
         background-clip: text; }
    p { color: #cbd5e1; margin-bottom: 2rem; line-height: 1.5; }
    button {
      font: inherit; cursor: pointer; padding: 0.75rem 2rem;
      background: #6366f1; color: white; border: 0; border-radius: 8px;
      font-weight: 600; font-size: 1rem;
      transition: background 0.15s;
    }
    button:hover:not(:disabled) { background: #4f46e5; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    #status { margin-top: 1.5rem; font-size: 0.875rem; color: #94a3b8; min-height: 1.25rem; }
    #status.error { color: #f87171; }
    #status.success { color: #4ade80; }
    .existing { margin-top: 2rem; padding-top: 1.5rem; border-top: 1px solid rgba(255,255,255,0.1); }
    .existing h3 { font-size: 0.875rem; color: #94a3b8; font-weight: 500; margin-bottom: 0.75rem; }
    .existing a { display: block; padding: 0.4rem 0.75rem; margin: 0.25rem 0;
                  background: rgba(255,255,255,0.05); border-radius: 4px;
                  color: #a5b4fc; text-decoration: none; font-family: monospace;
                  font-size: 0.8rem; }
    .existing a:hover { background: rgba(99,102,241,0.15); }
    .empty { color: #64748b; font-size: 0.8rem; font-style: italic; }
  </style>
</head>
<body>
  <main x-data="{ creating: false, msg: '', ok: false }">
    <span class="badge">Experimento aislado</span>
    <h1>SivoStudio</h1>
    <p>Cada box arranca como un Worker real en WFP. Lo editás en su propia URL.</p>
    <button
      :disabled="creating"
      @click="creating = true; msg = 'Aprovisionando…'; ok = false;
              fetch('/api/studio/create-box', { method: 'POST' })
                .then(r => r.json())
                .then(d => {
                  if (d.ok && d.url) { ok = true; msg = 'Box ' + d.boxId + ' listo'; setTimeout(() => window.location.href = d.url, 600); }
                  else { creating = false; msg = d.error || 'Error'; $refs.status.classList.add('error'); }
                })
                .catch(e => { creating = false; msg = e.message; $refs.status.classList.add('error'); })">
      <span x-show="!creating">Crear box</span>
      <span x-show="creating">Creando…</span>
    </button>
    <div id="status" x-ref="status" x-text="msg" :class="{ error: !ok && msg, success: ok }"></div>

    <div class="existing" x-data="{ boxes: [] }" x-init="fetch('/api/studio/list').then(r=>r.json()).then(d=>boxes=d.boxes||[])">
      <h3>Boxes activos</h3>
      <template x-if="boxes.length === 0">
        <div class="empty">ninguno todavía</div>
      </template>
      <template x-for="b in boxes" :key="b.box_id">
        <a :href="'/box/' + b.box_id + '/editor/frontend'" x-text="b.box_id + '  ·  ' + b.name"></a>
      </template>
    </div>
  </main>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.1/dist/cdn.min.js"></script>
</body>
</html>`

// === HELPERS ===

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

// Genera un boxId de 16 chars [a-z0-9]. Usa crypto.getRandomValues (Workers
// tienen Crypto API nativo desde el 2022). Hex de 8 bytes = 16 chars
// [0-9a-f] ⊂ [0-9a-z], así que matchea el patrón BOX_ID_PATTERN.
function generateBoxId() {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

const BOX_ID_PATTERN = /^[a-z0-9]{16}$/

// === RUTAS ===

// GET / — launcher UI.
function handleLauncher() {
  return htmlResponse(LAUNCHER_HTML)
}

// POST /api/studio/create-box — crea box (D1 + WFP) y devuelve URL.
//
// Flujo:
//   1. Generar boxId (16 chars [a-z0-9]).
//   2. INSERT en htmlbox_studio_boxes (registro).
//   3. deployStudioBoxWorker() — PUT al namespace WFP separado.
//   4a. Si deploy OK → responder { ok, boxId, url }.
//   4b. Si deploy falla → UPDATE deleted=1, devolver { ok: false, error }.
//       El caller (Alpine.js en el launcher) muestra el error y reintenta.
//
// Nota sobre la redirección: devolvemos una URL RELATIVA (`/box/...`) para
// que funcione tanto en prod (`studiov2.sivocloud.dev`) como en dev
// (`studiov2.localhost:8786`). El browser resuelve contra el host actual.
async function handleCreateBox(request, env) {
  if (!env.STUDIO_D1) {
    return jsonResponse({ ok: false, error: 'no_d1_binding' }, 500)
  }

  const boxId = generateBoxId()
  const scriptName = `box-${boxId}`

  // 1) INSERT en D1.
  try {
    await env.STUDIO_D1.prepare(
      `INSERT INTO htmlbox_studio_boxes (box_id, name, script_name)
       VALUES (?, ?, ?)`
    ).bind(boxId, `Box ${boxId}`, scriptName).run()
  } catch (e) {
    return jsonResponse({ ok: false, error: 'd1_insert_failed', detail: String(e) }, 500)
  }

  // 2) Deploy al namespace WFP separado.
  try {
    await deployStudioBoxWorker(env, boxId)
  } catch (e) {
    // Best-effort cleanup: marcar el box como borrado. El script en WFP
    // queda huérfano pero el cleanup cron (Fase 6) lo libera después.
    try {
      await env.STUDIO_D1.prepare(
        `UPDATE htmlbox_studio_boxes SET deleted = 1 WHERE box_id = ?`
      ).bind(boxId).run()
    } catch { /* ignore */ }
    return jsonResponse({ ok: false, error: 'wfp_deploy_failed', detail: String(e) }, 502)
  }

  // 3) Responder con URL relativa — el browser resuelve contra el host actual.
  return jsonResponse({
    ok: true,
    boxId,
    scriptName,
    url: `/box/${boxId}/editor/frontend`,
  })
}

// GET /api/studio/list — debug: lista boxes activos.
async function handleListBoxes(env) {
  if (!env.STUDIO_D1) {
    return jsonResponse({ ok: false, error: 'no_d1_binding' }, 500)
  }
  try {
    const result = await env.STUDIO_D1.prepare(
      `SELECT box_id, name, script_name, created_at, last_seen
         FROM htmlbox_studio_boxes
        WHERE deleted = 0
        ORDER BY created_at DESC
        LIMIT 50`
    ).all()
    return jsonResponse({ ok: true, boxes: result.results || [] })
  } catch (e) {
    return jsonResponse({ ok: false, error: 'd1_query_failed', detail: String(e) }, 500)
  }
}

// /box/:boxId/* → front-worker: despacha al box via WFP.
//
// Flujo:
//   1. Validar boxId (regex).
//   2. SELECT 1 FROM htmlbox_studio_boxes WHERE box_id=? AND deleted=0.
//      Si no existe → 404.
//   3. UPDATE last_seen = datetime('now').
//   4. Despachar via env.STUDIO_DISPATCH.get('box-{boxId}').fetch(request).
//   5. Si dispatch devuelve 404 ("Worker not found") → script no deployado,
//      respondemos 404 con hint.
async function handleBoxDispatch(request, env, boxId) {
  if (!BOX_ID_PATTERN.test(boxId)) {
    return new Response('Bad boxId', { status: 400, headers: { 'Content-Type': 'text/plain' } })
  }

  if (!env.STUDIO_D1) {
    return jsonResponse({ error: 'no_d1_binding' }, 500)
  }

  // 1) Chequear que el box existe y no está borrado.
  let exists
  try {
    const row = await env.STUDIO_D1.prepare(
      `SELECT 1 AS one FROM htmlbox_studio_boxes WHERE box_id = ? AND deleted = 0 LIMIT 1`
    ).bind(boxId).first()
    exists = !!row
  } catch (e) {
    return jsonResponse({ error: 'd1_query_failed', detail: String(e) }, 500)
  }
  if (!exists) {
    return new Response('Box not found', { status: 404, headers: { 'Content-Type': 'text/plain' } })
  }

  // 2) Update last_seen. Best-effort — si falla, no rompemos el dispatch.
  try {
    await env.STUDIO_D1.prepare(
      `UPDATE htmlbox_studio_boxes SET last_seen = datetime('now') WHERE box_id = ?`
    ).bind(boxId).run()
  } catch { /* ignore */ }

  // 3) Despachar al namespace. El script name es `box-{boxId}`.
  if (!env.STUDIO_DISPATCH) {
    return jsonResponse({ error: 'no_dispatch_binding' }, 500)
  }
  const scriptName = `box-${boxId}`
  let worker
  try {
    worker = env.STUDIO_DISPATCH.get(scriptName)
  } catch (e) {
    return jsonResponse({ error: 'dispatch_get_failed', detail: String(e) }, 500)
  }

  // 4) El box worker recibe el path completo (incluye /box/:boxId/*). Él
  //    sabe parsearlo (ver box-template/worker.js#dispatchZone). Coherente
  //    con el patrón actual de runtime-core/src/boxDispatch.js, que también
  //    pasa la URL completa y agrega headers via BOX_ID_HEADER.
  //
  //    Inyectamos X-HTMLBox-Box-Id para que el box worker sepa qué keys
  //    usar en R2 (box-{boxId}/frontend.html, etc.). Es el patrón
  //    withDispatchContext() de runtime-core, localizado al box worker
  //    de sivostudio.
  const init = {
    method: request.method,
    headers: new Headers(request.headers),
    redirect: request.redirect,
  }
  init.headers.set('X-HTMLBox-Box-Id', boxId)
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body
    init.duplex = 'half'
  }
  const reqWithBoxId = new Request(request.url, init)

  try {
    const dispatched = await worker.fetch(reqWithBoxId)
    if (dispatched.status === 404) {
      // El script existe en D1 pero el deploy falló o todavía no terminó.
      return new Response(
        `Box ${boxId} registrado pero el script no está deployado en WFP. ` +
        '¿Deploy pendiente o fallido? Revisá los logs.',
        { status: 404, headers: { 'Content-Type': 'text/plain' } },
      )
    }
    return dispatched
  } catch (e) {
    return jsonResponse({ error: 'dispatch_failed', detail: String(e) }, 502)
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    // Health check.
    if (url.pathname === '/health') {
      return new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } })
    }

    // Launcher UI.
    if (url.pathname === '/' || url.pathname === '') {
      return handleLauncher()
    }

    // API del launcher.
    if (url.pathname === '/api/studio/create-box' && request.method === 'POST') {
      return await handleCreateBox(request, env)
    }
    if (url.pathname === '/api/studio/list' && request.method === 'GET') {
      return await handleListBoxes(env)
    }

    // Front-worker: /box/:boxId/* → despachar al box via WFP.
    const boxMatch = url.pathname.match(/^\/box\/([a-z0-9]{16})(\/.*)?$/)
    if (boxMatch) {
      const [, boxId] = boxMatch
      return await handleBoxDispatch(request, env, boxId)
    }

    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } })
  },

  // Cron trigger para Fase 6: limpieza de boxes abandonados.
  // Por ahora no declaramos ningún schedule — se agrega cuando Fase 6 esté lista.
  // async scheduled(event, env, ctx) { ... }
}

// Export extra para tests node --test.
export const _internal = { generateBoxId, BOX_ID_PATTERN }